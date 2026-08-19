/**
 * Public settlement ledger (src/routes/ledger.ts): shape, pagination,
 * per-IP 1 req/s limit, tx lookup, and the privacy boundary.
 */

import { describe, it, expect } from 'vitest'
import { handleLedger, ledgerRateLimit, toPublicRow } from '../src/routes/ledger'
import { recordOrder, orderKey, txIndexKey, type OrderLedgerEntry } from '../src/services/order-ledger'
import type { Env } from '../src/index'

/**
 * Minimal stand-in for the ATOMIC_STORE Durable Object: a single-threaded
 * CAS store, which is exactly the guarantee the real DO provides. The public
 * limiter runs through it, so the tests exercise the real code path rather
 * than a KV shim that cannot express atomicity.
 */
function freshAtomicStore(): { store: Map<string, { value: string; version: number }>; ns: DurableObjectNamespace } {
  const store = new Map<string, { value: string; version: number }>()
  const stub = {
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname
      const body = (await req.json()) as any
      const cur = store.get(body.key) ?? { value: null as unknown as string, version: 0 }
      if (path === '/read') {
        return new Response(JSON.stringify({ value: cur.value ?? null, version: cur.version }))
      }
      if (path === '/commit') {
        if (cur.version !== body.expectedVersion) {
          return new Response(JSON.stringify({ ok: false, value: cur.value ?? null, version: cur.version }))
        }
        store.set(body.key, { value: body.value, version: cur.version + 1 })
        return new Response(JSON.stringify({ ok: true }))
      }
      return new Response('nope', { status: 404 })
    },
  }
  const ns = {
    idFromName: (name: string) => name,
    get: () => stub,
  } as unknown as DurableObjectNamespace
  return { store, ns }
}

/** An ATOMIC_STORE whose every call throws, for the fail-closed test. */
const brokenAtomicStore = {
  idFromName: (n: string) => n,
  get: () => ({
    fetch: async () => {
      throw new Error('DO unavailable')
    },
  }),
} as unknown as DurableObjectNamespace

/** In-memory KV with a real prefix/cursor `list`, which the endpoint depends on. */
function freshKv(): { kv: Map<string, string>; ns: KVNamespace } {
  const kv = new Map<string, string>()
  const ns = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => {
      kv.set(key, value)
    },
    delete: async (key: string) => {
      kv.delete(key)
    },
    list: async (opts?: { prefix?: string; limit?: number; cursor?: string }) => {
      const prefix = opts?.prefix ?? ''
      const limit = opts?.limit ?? 1000
      const all = [...kv.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = opts?.cursor ? all.indexOf(opts.cursor) : 0
      const page = all.slice(start, start + limit)
      const complete = start + limit >= all.length
      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? '' : all[start + limit],
      }
    },
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace
  return { kv, ns }
}

function entry(n: number, over: Partial<OrderLedgerEntry> = {}): OrderLedgerEntry {
  return {
    order_id: `ord_${String(n).padStart(4, '0')}`,
    ts: `2026-08-1${n % 10}T00:00:00.000Z`,
    route_id: 'firecrawl_scrape',
    payer: 'GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB',
    amount_usd: '0.002',
    settlement_ref: `${String(n).padStart(64, 'a')}`,
    request_path: '/scrape?url=https://secret-internal.example/customer-42',
    upstream_status: 200,
    latency_ms: 120,
    refund_status: 'none',
    ...over,
  }
}

async function seed(env: Env, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) await recordOrder(env, entry(i))
}

function req(qs = '', ip = '1.2.3.4'): Request {
  return new Request(`https://apiserver.mpprouter.dev/v1/ledger${qs}`, {
    headers: { 'CF-Connecting-IP': ip },
  })
}

describe('GET /v1/ledger — response shape', () => {
  it('returns one public row per order with the settlement fields a reviewer needs', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await seed(env, 3)

    const res = await handleLedger(req(), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.count).toBe(3)
    expect(body.order).toBe('ts_asc')
    expect(body.next_cursor).toBeNull()

    const row = body.entries[0]
    expect(row).toMatchObject({
      order_id: 'ord_0001',
      service: 'firecrawl_scrape',
      payer: 'GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB',
      amount_usd: '0.002',
      status: 'delivered',
      upstream_status: 200,
      internal: null,
      attribution: 'unknown',
    })
    expect(row.settlement_tx).toMatch(/^a+1$/)
    expect(typeof row.ts).toBe('string')
  })

  it('never leaks the upstream request path (it carries caller-supplied content)', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await seed(env, 1)

    const text = await (await handleLedger(req(), env)).text()
    expect(text).not.toContain('secret-internal.example')
    expect(text).not.toContain('request_path')
    expect(text).not.toContain('latency_ms')
  })

  it('maps refund and failure states onto status', () => {
    const none = { internal: new Set<string>(), unresolved: new Set<string>() }
    expect(toPublicRow(entry(1, { refund_status: 'pending' }), none).status).toBe('refund_pending')
    expect(toPublicRow(entry(1, { refund_status: 'unknown' }), none).status).toBe('refund_unknown')
    expect(toPublicRow(entry(1, { upstream_status: 502 }), none).status).toBe('failed')
    expect(toPublicRow(entry(1), none).status).toBe('delivered')
  })

  it('marks internal payers only when an operator has configured the list', () => {
    const seeded = 'GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB'
    const configured = { internal: new Set([seeded]), unresolved: new Set<string>() }
    const empty = { internal: new Set<string>(), unresolved: new Set<string>() }
    expect(toPublicRow(entry(1), configured).internal).toBe(true)
    expect(toPublicRow(entry(1, { payer: 'GOTHER' }), configured).internal).toBe(false)
    // Unknown, not "external": no list configured means no classification.
    expect(toPublicRow(entry(1), empty).internal).toBeNull()
    expect(toPublicRow(entry(1, { payer: null }), configured).internal).toBeNull()
  })

  it('reports four-way attribution, keeping "unresolved" distinct from both buckets', () => {
    const ours = 'GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB'
    const adjacent = 'GDOOBI5HMUAXYF3QWGAPPY5MK3IPMHRA6LAXWAUZGA6H4FTZQUJNJU56'
    const lists = { internal: new Set([ours]), unresolved: new Set([adjacent]) }

    expect(toPublicRow(entry(1), lists).attribution).toBe('internal')
    expect(toPublicRow(entry(1, { payer: adjacent }), lists).attribution).toBe('unresolved')
    expect(toPublicRow(entry(1, { payer: 'GSTRANGER' }), lists).attribution).toBe('external')
    expect(toPublicRow(entry(1, { payer: null }), lists).attribution).toBe('unknown')

    // The whole reason the enum exists: an unresolved payer must not be
    // counted as external (it would inflate the grant's unique-payer floor)
    // and must not be claimed as internal (we cannot evidence ownership).
    expect(toPublicRow(entry(1, { payer: adjacent }), lists).internal).toBeNull()

    // With no lists at all, nothing is external — everything is unknown.
    const empty = { internal: new Set<string>(), unresolved: new Set<string>() }
    expect(toPublicRow(entry(1, { payer: 'GSTRANGER' }), empty).attribution).toBe('unknown')
  })
})

describe('GET /v1/ledger — pagination', () => {
  it('honours limit and walks the whole set with next_cursor', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await seed(env, 5)

    const first = (await (await handleLedger(req('?limit=2'), env)).json()) as any
    expect(first.entries).toHaveLength(2)
    expect(first.next_cursor).toBeTruthy()

    const second = (await (
      await handleLedger(req(`?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`, '1.2.3.5'), env)
    ).json()) as any
    expect(second.entries).toHaveLength(2)
    expect(second.entries[0].order_id).not.toBe(first.entries[0].order_id)

    const third = (await (
      await handleLedger(req(`?limit=2&cursor=${encodeURIComponent(second.next_cursor)}`, '1.2.3.6'), env)
    ).json()) as any
    expect(third.entries).toHaveLength(1)
    expect(third.next_cursor).toBeNull()
  })

  it('caps limit at 100 rather than serving an unbounded page', async () => {
    const { ns } = freshKv()
    let requestedLimit = -1
    const spy = {
      ...ns,
      list: async (opts: any) => {
        requestedLimit = opts.limit
        return { keys: [], list_complete: true, cursor: '' }
      },
    } as unknown as KVNamespace
    const env = { MPP_STORE: spy, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await handleLedger(req('?limit=5000'), env)
    expect(requestedLimit).toBe(100)
  })

  it('rejects a nonsense limit with 400', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    expect((await handleLedger(req('?limit=0'), env)).status).toBe(400)
    expect((await handleLedger(req('?limit=abc', '9.9.9.9'), env)).status).toBe(400)
  })
})

describe('GET /v1/ledger?tx=', () => {
  it('finds the single entry that settled with that transaction hash', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await seed(env, 2)
    const tx = String(2).padStart(64, 'a')

    const body = (await (await handleLedger(req(`?tx=${tx}`), env)).json()) as any
    expect(body.ok).toBe(true)
    expect(body.entry.order_id).toBe('ord_0002')
    expect(body.entry.settlement_tx).toBe(tx)
  })

  it('404s for a well-formed hash that settled nothing here', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await seed(env, 1)
    const res = await handleLedger(req(`?tx=${'b'.repeat(64)}`), env)
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toMatchObject({ ok: false })
  })

  it('404s when the index points at a record that has expired', async () => {
    const { kv, ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await seed(env, 1)
    kv.delete(orderKey('ord_0001'))
    expect((await handleLedger(req(`?tx=${'a'.repeat(63)}1`), env)).status).toBe(404)
  })

  it('rejects a malformed hash before it reaches storage', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    expect((await handleLedger(req('?tx=notahash'), env)).status).toBe(400)
  })

  it('writes the tx index alongside the record, and skips it when unsettled', async () => {
    const { kv, ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await recordOrder(env, entry(7))
    expect(kv.get(txIndexKey(String(7).padStart(64, 'a')))).toBe('ord_0007')

    await recordOrder(env, entry(8, { settlement_ref: null }))
    expect([...kv.keys()].filter((k) => k.startsWith('mercury_order_tx:'))).toHaveLength(1)
  })
})

describe('GET /v1/ledger — rate limit', () => {
  it('allows 1 request per second per IP and 429s the second one', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await seed(env, 1)

    expect((await handleLedger(req('', '5.5.5.5'), env)).status).toBe(200)
    const throttled = await handleLedger(req('', '5.5.5.5'), env)
    expect(throttled.status).toBe(429)
    expect(throttled.headers.get('Retry-After')).toBe('1')
    // A different caller is unaffected — the limit is per IP, not global.
    expect((await handleLedger(req('', '6.6.6.6'), env)).status).toBe(200)
  })

  it('holds under a concurrent burst — exactly one request gets through', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await seed(env, 1)

    const results = await Promise.all(
      Array.from({ length: 10 }, () => handleLedger(req('', '7.7.7.7'), env)),
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s === 429)).toHaveLength(9)
  })

  it('lets the next window through', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await seed(env, 1)
    expect(await ledgerRateLimit(env, '8.8.8.8', 1_000_000_000_000)).toBe('allow')
    expect(await ledgerRateLimit(env, '8.8.8.8', 1_000_000_000_500)).toBe('throttle')
    expect(await ledgerRateLimit(env, '8.8.8.8', 1_000_000_001_000)).toBe('allow')
  })

  it('fails CLOSED with 503 when the limiter itself is down', async () => {
    const { ns } = freshKv()
    const env = { MPP_STORE: ns, ATOMIC_STORE: brokenAtomicStore } as unknown as Env
    const res = await handleLedger(req('', '9.1.1.1'), env)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('1')
  })

  it('does not read storage at all once a caller is throttled', async () => {
    const { ns } = freshKv()
    let lists = 0
    const counting = {
      ...ns,
      list: async (opts: any) => {
        lists++
        return (ns as any).list(opts)
      },
    } as unknown as KVNamespace
    const env = { MPP_STORE: counting, ATOMIC_STORE: freshAtomicStore().ns } as unknown as Env
    await handleLedger(req('', '9.2.2.2'), env)
    await handleLedger(req('', '9.2.2.2'), env)
    expect(lists).toBe(1)
  })
})
