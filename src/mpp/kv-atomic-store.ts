/**
 * Cloudflare KV atomic store adapter for mppx 0.7.0.
 *
 * mppx 0.7.0's `@stellar/mpp` charge and channel constructors require
 * `Store.AtomicStore` — a store that includes an `update()` method providing
 * compare-and-set (CAS) semantics. Native Cloudflare KV does not expose server-
 * side CAS, so we implement a "read → transform → write" sequence here.
 *
 * SAFETY MODEL (single-isolate):
 * A Cloudflare Worker isolate processes one request at a time on a single-threaded
 * event loop. All `await` points in `update()` are sequential within a request, and
 * Worker isolates do not share state. Therefore:
 *
 * - Cross-request (cross-isolate) races are not prevented by this implementation.
 *   Two isolates could both read the same KV value, compute transforms, and
 *   both write. This is the acknowledged limitation of Cloudflare KV for multi-
 *   process CAS; mppx's own docs call it out in the `store` parameter JSDoc.
 *
 * - Within a single isolate (the common case for a cold Cloudflare Worker serving
 *   one concurrent request), the sequential read-transform-write is safe. The
 *   `cumulativeLock` inside mppx's channel server serializes concurrent verify
 *   calls further within the same isolate.
 *
 * For INBOUND PAYMENT VERIFICATION on the charge path, the mppx challenge ID is
 * a unique random nonce tied to the 402 challenge the router issued. Under normal
 * traffic (one request, one payment, one credential), the non-atomic CAS is safe:
 * the challenge nonce is used exactly once.
 *
 * If a future deployment switches to Workers with multiple concurrent requests
 * (e.g., via Durable Objects or a custom queue), this adapter should be replaced
 * with a Durable Object–backed store that provides true linearizable CAS.
 *
 * See internaldocs/v2-stellar-channel-notes.md §N4 for the key collision audit
 * that confirms our `stellar:charge:*` and `stellar:channel:*` mppx keys do not
 * collide with our own `stellarChannel:*` / `tempoChannel:*` sidecar metadata.
 */

import type { Store } from 'mppx/server'

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
 * Build the `cloudflare.AtomicParameters` object from a Cloudflare `KVNamespace`.
 *
 * The `update` implementation is a best-effort read-transform-write.
 * Within a single Worker isolate this is safe (sequential event loop).
 * See module-level doc for the cross-isolate caveat.
 *
 * Pass the returned object to `Store.cloudflare(...)` to obtain an
 * `AtomicStore` compatible with `@stellar/mpp@0.7.0`'s charge and channel
 * server constructors.
 */
export function kvAtomicParams(kv: KVNamespace): KvAtomicParams {
  return {
    async get(key: string): Promise<string | null> {
      return kv.get(key)
    },
    async put(key: string, value: string): Promise<void> {
      await kv.put(key, value)
    },
    async delete(key: string): Promise<void> {
      await kv.delete(key)
    },
    async update<R>(
      key: string,
      fn: (current: string | null) => Store.Change<string, R>,
    ): Promise<R> {
      // Sequential read → transform → write within a single isolate.
      // KVNamespace.get() returns the raw stored string or null.
      const current = await kv.get(key)
      const change = fn(current)
      if (change.op === 'set') {
        await kv.put(key, change.value)
      } else if (change.op === 'delete') {
        await kv.delete(key)
      }
      // 'noop': no write needed
      return change.result
    },
  }
}
