/**
 * AtomicStoreDO — Durable Object providing linearizable CAS for mppx 0.7.0.
 *
 * ## Why a Durable Object?
 *
 * Cloudflare KV has no server-side conditional write. A Worker-side
 * read→transform→write on KV is non-atomic: two isolates can read the same
 * value before either writes, so BOTH accept the same payment (double-spend
 * on the charge replay-protection path) or the channel cumulative goes
 * backwards (channel path).
 *
 * A Durable Object (DO) is a single-threaded JS isolate. The CF platform
 * guarantees that for a given DO id, **only one `fetch` handler executes at
 * a time** — all other concurrent requests are queued behind it. This turns
 * the DO into a linearizable mutex over its storage without any application-
 * level locking.
 *
 * Reference: https://developers.cloudflare.com/durable-objects/reference/
 *            "At most one event handler runs at any given time."
 *
 * ## Key layout inside the DO's storage
 *
 * For each mppx store key `k`:
 *   `v:<k>` → the stored value string (absent ≡ null)
 *   `n:<k>` → the version counter as a number (absent ≡ 0)
 *
 * Separating value and version into two storage keys keeps the hot-path
 * writes minimal (only `n:` bumped on every commit) and avoids marshalling
 * the entire `{value, version}` object into a single JSON blob.
 *
 * ## Internal HTTP API (Worker → DO)
 *
 * All calls are POST to the DO's `fetch()` endpoint. The DO is never
 * exposed to the public internet — it is only reachable via the
 * `DurableObjectNamespace.get(id).fetch(...)` internal Cloudflare path.
 *
 * POST /read  — body: { key: string }
 *               response: { value: string | null; version: number }
 *
 * POST /commit — body: { key: string; expectedVersion: number;
 *                        op: 'set' | 'delete'; value?: string }
 *               response: { ok: true }
 *                       | { ok: false; value: string | null; version: number }
 *
 * If `storedVersion === expectedVersion` the write is applied and `version`
 * is incremented to `expectedVersion + 1`. Otherwise the current (value,
 * version) is returned so the caller can retry without an extra /read.
 *
 * ## Atomicity of the commit operation
 *
 * The entire get-compare-set inside `fetch()` is synchronous (no awaits
 * between the storage.get calls and the storage.put/delete call except for
 * the awaits inherent to the storage API itself). Because the DO is single-
 * threaded and only one request runs at a time, no interleaving is possible.
 *
 * We use `storage.transaction()` on the /commit path to ensure the
 * get and the conditional put/delete are treated as an atomic unit by
 * the DO's durable storage layer as well (important for crash safety — the
 * version bump and value write either both persist or neither does).
 */

export class AtomicStoreDO implements DurableObject {
  private readonly storage: DurableObjectStorage

  constructor(state: DurableObjectState) {
    this.storage = state.storage
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response('Bad Request: invalid JSON', { status: 400 })
    }

    if (url.pathname === '/read') {
      return this.handleRead(body)
    }

    if (url.pathname === '/commit') {
      return this.handleCommit(body)
    }

    return new Response('Not Found', { status: 404 })
  }

  // -------------------------------------------------------------------------
  // /read handler
  // -------------------------------------------------------------------------

  private async handleRead(body: unknown): Promise<Response> {
    if (!isReadBody(body)) {
      return new Response('Bad Request: expected { key: string }', { status: 400 })
    }
    const { key } = body

    // Both reads are independent — no transaction needed for reads since we
    // are single-threaded and there are no awaits between them that could
    // interleave with a concurrent request.
    const [value, version] = await Promise.all([
      this.storage.get<string>(`v:${key}`),
      this.storage.get<number>(`n:${key}`),
    ])

    const resp: ReadResponse = {
      value: value ?? null,
      version: version ?? 0,
    }
    return Response.json(resp)
  }

  // -------------------------------------------------------------------------
  // /commit handler
  // -------------------------------------------------------------------------

  private async handleCommit(body: unknown): Promise<Response> {
    if (!isCommitBody(body)) {
      return new Response('Bad Request: expected CommitBody', { status: 400 })
    }
    const { key, expectedVersion, op, value: newValue } = body

    // Use storage.transaction() so that the get + conditional put/delete are
    // persisted as an atomic unit. If the DO crashes after the put but before
    // the version bump, the transaction rolls back and the next request re-
    // reads a consistent (old-value, old-version) — no split-brain state.
    let committed = false
    let currentValue: string | null = null
    let currentVersion = 0

    await this.storage.transaction(async (txn) => {
      const [storedValue, storedVersion] = await Promise.all([
        txn.get<string>(`v:${key}`),
        txn.get<number>(`n:${key}`),
      ])
      currentValue = storedValue ?? null
      currentVersion = storedVersion ?? 0

      if (currentVersion !== expectedVersion) {
        // Conflict — the caller's expectedVersion is stale. Roll back the
        // transaction (no write). We return the fresh value+version below so
        // the caller can re-run `fn` without a separate /read round trip.
        txn.rollback()
        return
      }

      // Version matches — apply the write.
      if (op === 'set') {
        if (newValue === undefined) {
          txn.rollback()
          throw new Error('AtomicStoreDO: op=set requires value')
        }
        await txn.put(`v:${key}`, newValue)
      } else {
        // op === 'delete'
        await txn.delete(`v:${key}`)
      }
      await txn.put(`n:${key}`, expectedVersion + 1)
      committed = true
    })

    if (committed) {
      return Response.json({ ok: true } satisfies CommitOkResponse)
    }

    const resp: CommitConflictResponse = {
      ok: false,
      value: currentValue,
      version: currentVersion,
    }
    return Response.json(resp)
  }
}

// -------------------------------------------------------------------------
// Wire-format types and guards
// -------------------------------------------------------------------------

export type ReadResponse = {
  value: string | null
  version: number
}

export type CommitOkResponse = {
  ok: true
}

export type CommitConflictResponse = {
  ok: false
  value: string | null
  version: number
}

export type CommitResponse = CommitOkResponse | CommitConflictResponse

type ReadBody = { key: string }
type CommitBody = {
  key: string
  expectedVersion: number
  op: 'set' | 'delete'
  value?: string
}

function isReadBody(x: unknown): x is ReadBody {
  return (
    typeof x === 'object' &&
    x !== null &&
    'key' in x &&
    typeof (x as Record<string, unknown>).key === 'string'
  )
}

function isCommitBody(x: unknown): x is CommitBody {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (typeof o.key !== 'string') return false
  if (typeof o.expectedVersion !== 'number') return false
  if (o.op !== 'set' && o.op !== 'delete') return false
  if (o.op === 'set' && typeof o.value !== 'string') return false
  return true
}
