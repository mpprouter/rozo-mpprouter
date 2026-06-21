/**
 * Durable Object–backed AtomicStore adapter for mppx 0.7.0.
 *
 * ## Problem with the previous KV implementation
 *
 * mppx 0.7.0's `@stellar/mpp` charge and channel constructors require
 * `Store.AtomicStore` — a store whose `update(key, fn)` is a TRUE
 * linearizable compare-and-set (CAS). Native Cloudflare KV has no
 * server-side conditional write, so the old implementation was a
 * non-atomic read→transform→write: two Worker isolates serving
 * parallel requests could both read the same value before either
 * writes, letting BOTH accept the same payment (double-spend on the
 * charge replay-protection path) or allowing the channel cumulative
 * to go backwards (channel path).
 *
 * ## Solution: Durable Object as a linearizable mutex
 *
 * A Cloudflare Durable Object (DO) is a single-threaded JS isolate.
 * The CF platform guarantees: "At most one event handler runs at any
 * given time." All requests to a given DO id are serialized by the
 * platform — no application-level locking required.
 *
 * See src/mpp/atomic-store-do.ts for the DO class and its internal
 * /read + /commit HTTP API.
 *
 * ## Optimistic CAS loop (the key insight)
 *
 * mppx's `fn` callback closes over per-request data and is not
 * serialisable (cannot be sent to the DO). We run `fn` on the Worker
 * side but make the read and conditional-write atomic on the DO side:
 *
 *   1. Worker asks DO: GET { value, version } for key.
 *   2. Worker runs fn(value) locally → Change { op, value?, result }.
 *   3. If op === 'noop' → return result (no write needed, no DO round trip).
 *   4. If op === 'set' | 'delete' → Worker asks DO: COMMIT
 *      { key, expectedVersion=version, op, value }.
 *   5. DO (single-threaded) checks storedVersion === expectedVersion:
 *        • Match → applies write, bumps version, returns { ok: true }.
 *        • Mismatch → returns { ok: false, value: fresh, version: fresh }.
 *   6. On conflict → back to step 2 with the fresh (value, version).
 *      Loop is bounded by MAX_UPDATE_RETRIES.
 *
 * mppx's Store.d.ts explicitly states that `fn` "may be retried" and
 * "must be side-effect-free" — so re-running it is contract-safe.
 *
 * ## Race-safety proof (two-parallel-request scenario)
 *
 * Suppose R1 and R2 arrive simultaneously for the same charge key
 * (replay-protection scenario). Both find value=null, version=0.
 *
 *   • R1 /read  → { value: null, version: 0 }
 *   • R2 /read  → { value: null, version: 0 }
 *   • R1 fn(null) → { op:'set', value: pendingState, result: 'claimed' }
 *   • R2 fn(null) → { op:'set', value: pendingState, result: 'claimed' }
 *   • R1 /commit expectedVersion=0 → DO serialises: storedVersion=0 matches
 *     → writes value, sets version=1 → { ok: true } → R1 returns 'claimed'.
 *   • R2 /commit expectedVersion=0 → DO serialises: storedVersion is NOW 1
 *     (R1 already bumped it) → mismatch → { ok: false, value: pendingState,
 *     version: 1 }.
 *   • R2 retries: fn(pendingState) → mppx returns { op:'noop', result:'replay' }
 *     → R2 returns 'replay' without writing.
 *
 * One request claims, one gets replay. No double-spend.
 *
 * ## Why ALL operations go through the DO (not a KV+DO split)
 *
 * mppx's `get()` is called to read state that `update()` subsequently
 * modifies. If `get()` reads from KV and `update()` reads from the DO,
 * the two can diverge (KV eventual consistency). Routing everything
 * through the DO ensures a single source of truth with no split-brain.
 *
 * ## Key-space notes
 *
 * The DO's internal storage uses `v:<k>` and `n:<k>` namespacing to
 * separate value from version. The external mppx key `k` passes through
 * unchanged (no extra prefix needed — the DO is dedicated to mppx storage
 * and does not share its internal storage with any other subsystem).
 *
 * mppx's own key prefixes (`stellar:charge:*`, `stellar:channel:*`) do
 * NOT collide with our sidecar keys (`stellarChannel:*`, `tempoChannel:*`,
 * `idempotency:*`) which still live in KV — this file only replaces the
 * mppx Store adapter, not the rest of KV usage.
 *
 * ## DO instance ID
 *
 * We use a single named DO `"mppx"` as the singleton for all mppx keys.
 * This is intentional: mppx's charge and channel servers share the same
 * Store and their keys must be mutually serialised (a replay-protection
 * key for charge and a cumulative key for channel must not race each
 * other either). One DO = one serialization point = correct.
 *
 * At mppx's current key cardinality (challenge IDs + per-channel
 * cumulatives, measured in tens to low-hundreds of unique keys) a single
 * DO instance has ample throughput. If traffic ever grows to thousands of
 * concurrent payments, the DO can be sharded by key prefix — but that is
 * not a concern for the current deployment size.
 *
 * See internaldocs/v2-stellar-channel-notes.md §N4 for the key-collision
 * audit that confirms mppx's `stellar:charge:*` and `stellar:channel:*`
 * key prefixes do not collide with any of our own KV keys.
 */

import type { Store } from 'mppx/server'
import type { ReadResponse, CommitResponse } from './atomic-store-do'

/**
 * Maximum number of times `update()` will retry after a CAS conflict.
 * A conflict means another DO request won the write between our /read
 * and our /commit. mppx guarantees `fn` is side-effect-free and
 * re-runnable, so each retry is safe. After MAX_UPDATE_RETRIES
 * consecutive conflicts we throw — it is better to fail a payment
 * than to loop infinitely or silently accept under contention.
 *
 * In practice, mppx's replay-protection `fn` returns 'noop' on the
 * second invocation (when it sees the already-claimed state), so
 * retries almost always resolve in one loop iteration. The bound is
 * a safety net, not an expected code path.
 */
const MAX_UPDATE_RETRIES = 5

/**
 * Internal URL base used for DO-to-Worker RPC. The actual hostname is
 * irrelevant — CF routes DO `stub.fetch()` calls internally and never
 * makes an outbound network request. We use a stable fake origin so
 * `new URL(path, DO_ORIGIN)` produces a valid URL object.
 */
const DO_ORIGIN = 'https://atomic-store.internal'

/**
 * Shape of the `cloudflare.AtomicParameters` type from mppx's `Store` namespace.
 * Passing a value of this type to `Store.cloudflare()` returns `Store.AtomicStore`.
 */
type KvAtomicParams = {
  get: (key: string) => Promise<unknown>
  put: (key: string, value: string) => Promise<void>
  delete: (key: string) => Promise<void>
  update: <R>(
    key: string,
    fn: (current: string | null) => Store.Change<string, R>,
  ) => Promise<R>
}

/**
 * Build the `cloudflare.AtomicParameters` object backed by an `AtomicStoreDO`
 * Durable Object namespace.
 *
 * All four operations (get, put, delete, update) are routed through the DO so
 * there is a single source of truth — if `get()` read from KV and `update()`
 * read from the DO they could diverge due to KV's eventual consistency.
 *
 * Pass the returned object to `Store.cloudflare(...)` to obtain an
 * `AtomicStore` compatible with `@stellar/mpp@0.7.0`'s charge and channel
 * server constructors.
 *
 * @param ns - The `ATOMIC_STORE` `DurableObjectNamespace` from `env`.
 */
export function doAtomicParams(ns: DurableObjectNamespace): KvAtomicParams {
  // All mppx keys share a single DO instance, named "mppx".
  // `idFromName` is deterministic and pure — the same name always resolves to
  // the same DO instance across all Worker isolates in all colos.
  const stub = ns.get(ns.idFromName('mppx'))

  /** Internal helper: POST to the DO and parse the JSON response. */
  async function doPost<T>(path: string, payload: unknown): Promise<T> {
    const resp = await stub.fetch(new Request(`${DO_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`AtomicStoreDO ${path} failed (${resp.status}): ${text}`)
    }
    return resp.json() as Promise<T>
  }

  return {
    // ------------------------------------------------------------------
    // get: read the current value (not version) for a key.
    // Routes through the DO for consistency — see module-level comment.
    // ------------------------------------------------------------------
    async get(key: string): Promise<string | null> {
      const r = await doPost<ReadResponse>('/read', { key })
      return r.value
    },

    // ------------------------------------------------------------------
    // put: overwrite a key unconditionally.
    // Used by mppx for non-CAS writes (rare; most writes go through update).
    // Implemented as a commit with expectedVersion=-1 which always conflicts
    // with any real version (≥0). We bypass the version check by using a
    // dedicated 'set' commit with a sentinel expectedVersion of -1.
    //
    // Alternative: add a /put endpoint to the DO. We chose to reuse /commit
    // with expectedVersion=-1 to keep the DO API surface minimal — but the
    // DO must accept -1. Looking at the DO impl: the check is
    // `currentVersion !== expectedVersion`. A real version starts at 0.
    // With expectedVersion=-1, currentVersion (0 if absent) !== -1, so it
    // would CONFLICT. That means a blind put would loop and fail.
    //
    // The correct solution: add a /put endpoint to the DO for unconditional
    // writes. We handle this by making put() its own /commit with a special
    // "force" op. To keep the DO simple, we implement blind put here by
    // re-reading the version first and then committing with that version.
    // This is safe for the blind-put use case because mppx only uses put()
    // in non-racing contexts (operator bootstrap, not the hot verify path).
    //
    // IMPORTANT: This is NOT atomic vs a concurrent update(). If you need
    // strict ordering between put() and update(), use update() only.
    // mppx's contract: put() is only called from places that don't race.
    // ------------------------------------------------------------------
    async put(key: string, value: string): Promise<void> {
      // Read current version, then commit with that exact version.
      // Retry loop mirrors update() in case of concurrent interference.
      for (let attempt = 0; attempt < MAX_UPDATE_RETRIES; attempt++) {
        const r = await doPost<ReadResponse>('/read', { key })
        const result = await doPost<CommitResponse>('/commit', {
          key,
          expectedVersion: r.version,
          op: 'set',
          value,
        })
        if (result.ok) return
        // Conflict: another writer modified the key between our read and
        // commit. Retry with fresh version from the conflict response.
        // (The conflict response already carries the fresh version.)
      }
      throw new Error(
        `AtomicStoreDO put(${key}): exhausted ${MAX_UPDATE_RETRIES} retries — ` +
        `too much concurrent write contention`,
      )
    },

    // ------------------------------------------------------------------
    // delete: remove a key unconditionally.
    // Same semantics as put() — read-then-commit with retry.
    // ------------------------------------------------------------------
    async delete(key: string): Promise<void> {
      for (let attempt = 0; attempt < MAX_UPDATE_RETRIES; attempt++) {
        const r = await doPost<ReadResponse>('/read', { key })
        if (r.value === null) return // already absent — nothing to do
        const result = await doPost<CommitResponse>('/commit', {
          key,
          expectedVersion: r.version,
          op: 'delete',
        })
        if (result.ok) return
      }
      throw new Error(
        `AtomicStoreDO delete(${key}): exhausted ${MAX_UPDATE_RETRIES} retries — ` +
        `too much concurrent write contention`,
      )
    },

    // ------------------------------------------------------------------
    // update: the core CAS operation.
    //
    // Optimistic loop (see module-level doc for full race proof):
    //   1. /read  → { value, version }
    //   2. fn(value) → change
    //   3. If noop → return change.result (no write)
    //   4. /commit with expectedVersion → ok OR conflict+fresh
    //   5. On conflict → goto 2 with fresh (value, version)
    // ------------------------------------------------------------------
    async update<R>(
      key: string,
      fn: (current: string | null) => Store.Change<string, R>,
    ): Promise<R> {
      // Seed with a /read on the first iteration.
      let { value, version } = await doPost<ReadResponse>('/read', { key })

      for (let attempt = 0; attempt < MAX_UPDATE_RETRIES; attempt++) {
        const change = fn(value)

        if (change.op === 'noop') {
          // No write needed — return immediately. This is the fast path for
          // mppx's replay-protection check when it sees an already-claimed
          // challenge: fn returns { op:'noop', result:'replay' }.
          return change.result
        }

        // Attempt the conditional write.
        const result = await doPost<CommitResponse>('/commit', {
          key,
          expectedVersion: version,
          op: change.op,
          ...(change.op === 'set' ? { value: change.value } : {}),
        })

        if (result.ok) {
          // Committed successfully.
          return change.result
        }

        // Conflict: between our /read and /commit, another request won
        // the write. The DO returns the fresh (value, version) so we can
        // re-run fn without a separate /read round trip.
        value = result.value
        version = result.version
        // Loop: re-run fn with the updated value.
      }

      // We exhausted all retries. This is safer than silently accepting
      // because on the charge path a stale noop-result could mean we
      // mis-classify a replay as a fresh claim.
      throw new Error(
        `AtomicStoreDO update(${key}): exhausted ${MAX_UPDATE_RETRIES} CAS retries — ` +
        `too much concurrent write contention on this key`,
      )
    },
  }
}

/**
 * @deprecated Use `doAtomicParams(env.ATOMIC_STORE)` instead.
 *
 * The KV-backed implementation was non-atomic under multi-isolate
 * Worker concurrency (two isolates could both read the same value
 * before either writes → double-spend on the charge replay-protection
 * path). Replaced by the Durable Object–backed `doAtomicParams` in
 * P1-3. This export is kept only so that any lingering import from
 * scripts/ or tests still compiles; call sites in the hot path
 * (stellar-server.ts, stellar-channel-dispatch.ts) have been migrated.
 *
 * REMOVE after all callers are updated.
 */
export function kvAtomicParams(_kv: KVNamespace): KvAtomicParams {
  throw new Error(
    'kvAtomicParams is deprecated: use doAtomicParams(env.ATOMIC_STORE) instead. ' +
    'The KV-backed store is not atomically safe under multi-isolate concurrency.',
  )
}
