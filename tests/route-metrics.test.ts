import { describe, it, expect, vi } from 'vitest'
import {
  classifyOutcome,
  serviceIdFromRouteId,
  recordRouteCall,
  getRouteQuality,
} from '../src/services/route-metrics'
import type { Env } from '../src/index'

/**
 * Minimal D1 stub. `all()` replays the rows it was seeded with; `run()`
 * captures the bound INSERT parameters so the write path can be asserted
 * without a real database.
 */
function fakeDb(rows: any[] = []) {
  const writes: any[][] = []
  return {
    writes,
    prepare(_sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async run() {
              writes.push(args)
            },
            async all() {
              return { results: rows }
            },
          }
        },
        async all() {
          return { results: rows }
        },
      }
    },
  } as any
}

/** ctx that runs waitUntil work immediately so assertions can await it. */
function immediateCtx() {
  const pending: Promise<any>[] = []
  return {
    ctx: { waitUntil: (p: Promise<any>) => void pending.push(p) },
    settle: () => Promise.all(pending),
  }
}

const DAY = 24 * 60 * 60 * 1000

describe('serviceIdFromRouteId', () => {
  it('takes the segment before the first underscore', () => {
    expect(serviceIdFromRouteId('mercury_txs_by_hash')).toBe('mercury')
    expect(serviceIdFromRouteId('anthropic_chat_completions')).toBe('anthropic')
  })

  it('returns the whole id when there is no underscore', () => {
    expect(serviceIdFromRouteId('firecrawl')).toBe('firecrawl')
  })
})

describe('classifyOutcome', () => {
  it('counts 2xx as ok', () => {
    expect(classifyOutcome(200)).toBe('ok')
    expect(classifyOutcome(204)).toBe('ok')
  })

  it('blames the provider for 5xx and for a missing status', () => {
    expect(classifyOutcome(500)).toBe('provider_fault')
    expect(classifyOutcome(502)).toBe('provider_fault')
    // No status at all: transport failure, timeout or throw.
    expect(classifyOutcome(undefined)).toBe('provider_fault')
  })

  it('blames the caller for an ordinary bad request, not the provider', () => {
    // This is the distortion the whole attribution exists for: most of the
    // 47 lifetime calls that were non-2xx were our own malformed parameters.
    expect(classifyOutcome(400)).toBe('caller_error')
    expect(classifyOutcome(404)).toBe('caller_error')
  })

  it('never blames the caller for an auth rejection', () => {
    // The agent's Authorization header is stripped before the upstream call
    // (forwardHeaders in routes/proxy.ts), so a 401/403 cannot be the
    // caller's credential. Calling it caller_error would drop a provider's
    // own refusals out of its published success rate — the first version of
    // this function did exactly that and would have shown 100% for a
    // provider that was refusing every call.
    expect(classifyOutcome(403)).toBe('provider_fault')
    expect(classifyOutcome(401)).toBe('provider_fault')
  })

  it('attributes a known router-side failure to us, not the provider', () => {
    // A session channel we never installed says nothing about the provider.
    expect(classifyOutcome(undefined, { routerSideFailure: true })).toBe('router_fault')
    expect(classifyOutcome(500, { routerSideFailure: true })).toBe('router_fault')
  })

  it('treats 408 and 429 as the provider refusing to serve', () => {
    expect(classifyOutcome(408)).toBe('provider_fault')
    expect(classifyOutcome(429)).toBe('provider_fault')
  })

  it('splits auth rejections between us and the provider, never the caller', () => {
    expect(classifyOutcome(403, { routerHoldsCredential: true })).toBe('router_fault')
    expect(classifyOutcome(401, { routerHoldsCredential: true })).toBe('router_fault')
    expect(classifyOutcome(403, { routerHoldsCredential: false })).toBe('provider_fault')
    expect(classifyOutcome(401)).toBe('provider_fault')
  })
})

describe('recordRouteCall', () => {
  it('is a no-op when the database is not provisioned', () => {
    const { ctx, settle } = immediateCtx()
    // Staged rollout: the code deploys before the D1 exists.
    recordRouteCall({} as Env, ctx, { routeId: 'mercury_x', method: 'GET', outcome: 'ok' })
    return expect(settle()).resolves.toEqual([])
  })

  it('derives the service id and stores an unmeasured latency as NULL', async () => {
    const db = fakeDb()
    const { ctx, settle } = immediateCtx()

    recordRouteCall({ ROUTE_METRICS_DB: db } as unknown as Env, ctx, {
      routeId: 'mercury_txs_by_hash',
      method: 'GET',
      outcome: 'provider_fault',
      reason: 'upstream_error',
      upstreamStatus: 502,
    })
    await settle()

    expect(db.writes).toHaveLength(1)
    const [, , serviceId, routeId, method, outcome, reason, status, latency] = db.writes[0]
    expect(serviceId).toBe('mercury')
    expect(routeId).toBe('mercury_txs_by_hash')
    expect(method).toBe('GET')
    expect(outcome).toBe('provider_fault')
    expect(reason).toBe('upstream_error')
    expect(status).toBe(502)
    // NULL, never 0: a zero would drag every published percentile down.
    expect(latency).toBeNull()
  })

  it('never rejects when the write fails', async () => {
    const db = {
      prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error('d1 down')) }) }),
    } as any
    const { ctx, settle } = immediateCtx()

    recordRouteCall({ ROUTE_METRICS_DB: db } as unknown as Env, ctx, {
      routeId: 'mercury_x',
      method: 'GET',
      outcome: 'ok',
      latencyMs: 12,
    })
    // A metrics write must not be able to fail a call the payer already paid for.
    await expect(settle()).resolves.toBeDefined()
  })
})

describe('getRouteQuality', () => {
  const now = Date.now()
  const rows = [
    // Inside 24h.
    { outcome: 'ok', refunded: 0, latency_ms: 100, created_at: now - 1000 },
    { outcome: 'ok', refunded: 0, latency_ms: 300, created_at: now - 2000 },
    { outcome: 'provider_fault', refunded: 1, latency_ms: null, created_at: now - 3000 },
    // Inside 7d, outside 24h.
    { outcome: 'caller_error', refunded: 0, latency_ms: null, created_at: now - 3 * DAY },
    // Inside 30d, outside 7d.
    { outcome: 'ok', refunded: 0, latency_ms: 900, created_at: now - 10 * DAY },
    // Inside 90d, outside 30d.
    { outcome: 'router_fault', refunded: 1, latency_ms: null, created_at: now - 60 * DAY },
  ]

  it('reports every window from one read, with windows nested consistently', async () => {
    const env = { ROUTE_METRICS_DB: fakeDb(rows) } as unknown as Env
    const q = await getRouteQuality(env, 'mercury')

    expect(q['24h'].calls).toBe(3)
    expect(q['7d'].calls).toBe(4)
    expect(q['30d'].calls).toBe(5)
    expect(q['90d'].calls).toBe(6)
    expect(q.all.calls).toBe(6)
  })

  it('excludes caller errors and router faults from the provider success rate', async () => {
    const env = { ROUTE_METRICS_DB: fakeDb(rows) } as unknown as Env
    const q = await getRouteQuality(env, 'mercury')

    // 24h: 2 ok + 1 provider_fault → 2/3.
    expect(q['24h'].provider_success_rate).toBeCloseTo(0.6667, 4)
    // 7d adds only a caller_error, which must not move the provider's rate.
    expect(q['7d'].provider_success_rate).toBeCloseTo(0.6667, 4)
    expect(q['7d'].caller_error).toBe(1)
    // 90d adds only a router_fault — also not the provider's problem.
    expect(q['90d'].provider_success_rate).toBeCloseTo(0.75, 4)
    expect(q['90d'].router_fault).toBe(1)
  })

  it('measures latency over successful calls only', async () => {
    const env = { ROUTE_METRICS_DB: fakeDb(rows) } as unknown as Env
    const q = await getRouteQuality(env, 'mercury')

    // The failed call has no latency and must not appear as a 0ms sample.
    expect(q['24h'].latency_samples).toBe(2)
    expect(q['24h'].latency_p50_ms).toBe(100)
    expect(q['24h'].latency_p95_ms).toBe(300)
  })

  it('returns null rather than 0 when a window has no data', async () => {
    const env = { ROUTE_METRICS_DB: fakeDb([]) } as unknown as Env
    const q = await getRouteQuality(env, 'mercury')

    // "No calls yet" and "0% success" are different claims; a page that
    // renders the first as the second libels a working provider.
    expect(q['24h'].calls).toBe(0)
    expect(q['24h'].provider_success_rate).toBeNull()
    expect(q['24h'].refund_rate).toBeNull()
    expect(q['24h'].latency_p50_ms).toBeNull()
    expect(q['24h'].last_call_at).toBeNull()
  })

  it('reports refund rate over all calls', async () => {
    const env = { ROUTE_METRICS_DB: fakeDb(rows) } as unknown as Env
    const q = await getRouteQuality(env, 'mercury')
    expect(q['24h'].refunded).toBe(1)
    expect(q['24h'].refund_rate).toBeCloseTo(0.3333, 4)
  })

  it('degrades to empty stats instead of throwing when the read fails', async () => {
    const db = { prepare: () => ({ all: () => Promise.reject(new Error('d1 down')) }) } as any
    const env = { ROUTE_METRICS_DB: db } as unknown as Env
    // The catalog must still render if the metrics read is broken.
    const q = await getRouteQuality(env)
    expect(q.all.calls).toBe(0)
  })

  it('returns empty stats when the database is not provisioned', async () => {
    const q = await getRouteQuality({} as Env)
    expect(q.all.calls).toBe(0)
    expect(q.all.provider_success_rate).toBeNull()
  })
})
