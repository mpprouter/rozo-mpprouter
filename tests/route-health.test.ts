/**
 * Live route health.
 *
 * Regression cover for the customer-reported gap in the 2026-08-12 Tempo
 * RPC incident: `firecrawl_scrape` kept advertising
 * `payment_status: "verified"` / `charge_rozo_verified: true` while it
 * failed 100% of calls for two days, because those fields record a human
 * verification from 2026-04-11 and nothing recomputes them. The customer
 * asked for a flag they could gate on automatically.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  recordRouteFailure,
  recordRouteSuccess,
  getDegradedRoutes,
  resetRouteHealthCache,
} from '../src/services/route-health'

/** Minimal KV double with the two methods this module uses. */
function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    reads: 0,
    writes: 0,
    async get(key: string) {
      this.reads++
      return store.get(key) ?? null
    },
    async put(key: string, value: string) {
      this.writes++
      store.set(key, value)
    },
  }
}

/** Collects waitUntil promises so tests can await the background work. */
function makeCtx() {
  const pending: Promise<any>[] = []
  return {
    ctx: { waitUntil: (p: Promise<any>) => { pending.push(p) } },
    settle: () => Promise.all(pending),
  }
}

describe('live route health', () => {
  let kv: ReturnType<typeof makeKv>
  let env: any
  let now: number

  beforeEach(() => {
    resetRouteHealthCache()
    kv = makeKv()
    env = { MPP_STORE: kv }
    now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const fail = async (routeId: string, times: number, reason = 'timeout') => {
    for (let i = 0; i < times; i++) {
      const { ctx, settle } = makeCtx()
      recordRouteFailure(env, ctx, routeId, reason)
      await settle()
      now += 1_000
    }
  }

  it('stays quiet below the threshold — one bad call is not an incident', async () => {
    await fail('firecrawl_scrape', 2)
    expect(await getDegradedRoutes(env)).toEqual({})
  })

  it('marks a route degraded once failures are consistent', async () => {
    await fail('firecrawl_scrape', 3, 'timeout')

    const degraded = await getDegradedRoutes(env)
    expect(degraded.firecrawl_scrape?.live_status).toBe('degraded')
    expect(degraded.firecrawl_scrape?.live_status_reason).toContain('timeout')
    expect(degraded.firecrawl_scrape?.live_status_since).toBeDefined()
  })

  it('scopes the incident to the failing route', async () => {
    await fail('firecrawl_scrape', 4)

    const degraded = await getDegradedRoutes(env)
    expect(degraded.firecrawl_scrape).toBeDefined()
    expect(degraded.openai_chat).toBeUndefined()
  })

  it('clears on the next success', async () => {
    await fail('firecrawl_scrape', 3)
    expect(await getDegradedRoutes(env)).toHaveProperty('firecrawl_scrape')

    const { ctx, settle } = makeCtx()
    recordRouteSuccess(env, ctx, 'firecrawl_scrape')
    await settle()

    expect(await getDegradedRoutes(env)).toEqual({})
  })

  it('resets the streak, so intermittent failures never accumulate to degraded', async () => {
    await fail('firecrawl_scrape', 2)
    const { ctx, settle } = makeCtx()
    recordRouteSuccess(env, ctx, 'firecrawl_scrape')
    await settle()
    await fail('firecrawl_scrape', 2)

    expect(await getDegradedRoutes(env)).toEqual({})
  })

  it('expires on its own when a route simply stops being called', async () => {
    await fail('firecrawl_scrape', 3)
    expect(await getDegradedRoutes(env)).toHaveProperty('firecrawl_scrape')

    now += 16 * 60_000
    resetRouteHealthCache() // force a re-read rather than the 10s cache

    expect(await getDegradedRoutes(env)).toEqual({})
  })

  it('costs no KV work on the success path (the overwhelmingly common case)', async () => {
    // Prime the cache with a read so the module knows the route is healthy.
    await getDegradedRoutes(env)
    const before = kv.writes + kv.reads

    for (let i = 0; i < 50; i++) {
      const { ctx, settle } = makeCtx()
      recordRouteSuccess(env, ctx, 'some_healthy_route')
      await settle()
    }

    expect(kv.writes + kv.reads).toBe(before)
  })

  it('clears an incident written by ANOTHER isolate within the cache window, not the TTL', async () => {
    // Codex review flagged the success-path early return as able to strand a
    // recovered route for the full 15-minute TTL. It cannot: the guard
    // requires a LIVE cache entry, so the staleness bound is CACHE_MS.

    // This isolate has a fresh, empty view...
    await getDegradedRoutes(env)
    // ...while another isolate records an incident straight into KV.
    kv.store.set('routeHealth:incidents', JSON.stringify({
      firecrawl_scrape: { fails: 5, since: now, lastAt: now, reason: 'timeout' },
    }))

    // Within the cache window the success is a no-op, as designed.
    let { ctx, settle } = makeCtx()
    recordRouteSuccess(env, ctx, 'firecrawl_scrape')
    await settle()
    expect(JSON.parse(kv.store.get('routeHealth:incidents')!)).toHaveProperty('firecrawl_scrape')

    // Once the cache entry ages out, the very next success clears it —
    // seconds, nowhere near INCIDENT_TTL_MS.
    now += 11_000
    ;({ ctx, settle } = makeCtx())
    recordRouteSuccess(env, ctx, 'firecrawl_scrape')
    await settle()
    expect(JSON.parse(kv.store.get('routeHealth:incidents')!)).toEqual({})
  })

  it('never lets a KV outage break the catalog', async () => {
    env.MPP_STORE = {
      get: async () => { throw new Error('KV down') },
      put: async () => { throw new Error('KV down') },
    }
    resetRouteHealthCache()

    await expect(getDegradedRoutes(env)).resolves.toEqual({})

    const { ctx, settle } = makeCtx()
    recordRouteFailure(env, ctx, 'firecrawl_scrape', 'timeout')
    await expect(settle()).resolves.toBeDefined()
  })

  it('survives a corrupted blob rather than throwing', async () => {
    kv.store.set('routeHealth:incidents', '{not json')
    resetRouteHealthCache()

    await expect(getDegradedRoutes(env)).resolves.toEqual({})
  })

  it('publishes only the coarse reason, never an upstream error body', async () => {
    // The incident's own 502 detail leaked our RPC URL and request body back
    // to the caller; this field must not repeat that.
    await fail('firecrawl_scrape', 3, 'upstream_5xx')

    const reason = (await getDegradedRoutes(env)).firecrawl_scrape!.live_status_reason!
    expect(reason).toContain('upstream_5xx')
    expect(reason).not.toContain('rpc.tempo.xyz')
    expect(reason).not.toMatch(/https?:\/\//)
  })
})
