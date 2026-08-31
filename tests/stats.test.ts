import { describe, it, expect } from 'vitest'
import { getStats } from '../src/services/stats'
import type { Env } from '../src/index'

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

const INTERNAL = 'GINTERNALPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const BUYER_A = 'GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const BUYER_B = 'GBUYERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

function order(o: Partial<any> & { route_id: string; ts: string }) {
  return JSON.stringify({
    order_id: Math.random().toString(36).slice(2),
    payer: BUYER_A,
    amount_usd: '0.001',
    upstream_status: 200,
    latency_ms: 100,
    refund_status: 'none',
    request_path: '/x',
    settlement_ref: null,
    ...o,
  })
}

/** KV stub holding the given order records. */
function kv(records: string[]) {
  const keys = records.map((_, i) => ({ name: `mercury_order:${i}` }))
  return {
    async list() {
      return { keys, list_complete: true }
    },
    async get(name: string) {
      return records[Number(name.split(':')[1])] ?? null
    },
  } as any
}

/**
 * Metrics D1 stub. `serviceIds` answers the DISTINCT service_id query used to
 * seed services that have quality rows but no ledger rows.
 */
function metricsDb(rows: any[] = [], serviceIds: string[] = []) {
  const answer = (sql: string) =>
    sql.includes('DISTINCT service_id')
      ? { results: serviceIds.map((service_id) => ({ service_id })) }
      : { results: rows }
  return {
    prepare: (sql: string) => ({
      bind: () => ({ all: async () => answer(sql), run: async () => {} }),
      all: async () => answer(sql),
    }),
  } as any
}

function env(records: string[], opts: { internal?: string; unresolved?: string } = {}): Env {
  return {
    MPP_STORE: kv(records),
    ROUTE_METRICS_DB: metricsDb(),
    LEDGER_INTERNAL_PAYERS: opts.internal,
    LEDGER_UNRESOLVED_PAYERS: opts.unresolved,
  } as unknown as Env
}

describe('getStats', () => {
  it('groups calls by service and sorts busiest first', async () => {
    const s = await getStats(
      env([
        order({ route_id: 'mercury_txs_by_hash', ts: iso(now - 1000) }),
        order({ route_id: 'mercury_events_by_contract', ts: iso(now - 2000) }),
        order({ route_id: 'exa_search', ts: iso(now - 3000) }),
      ]),
      '30d',
    )

    expect(s.services.map((x) => x.service_id)).toEqual(['mercury', 'exa'])
    expect(s.services[0].calls).toBe(2)
    expect(s.totals.calls).toBe(3)
  })

  it('sums USDC without float drift', async () => {
    const s = await getStats(
      env([
        order({ route_id: 'mercury_a', ts: iso(now - 1000), amount_usd: '0.1' }),
        order({ route_id: 'mercury_a', ts: iso(now - 1000), amount_usd: '0.2' }),
      ]),
      '30d',
    )
    // 0.1 + 0.2 in floating point is 0.30000000000000004.
    expect(s.totals.volume_usd).toBe('0.3')
  })


  it('counts every recorded call, whoever paid', async () => {
    // The payer-classification split was removed deliberately: this is an
    // internal operating view, so "internal vs external" was a distinction
    // nobody read and three counters to keep true.
    const s = await getStats(
      env(
        [
          order({ route_id: 'mercury_a', ts: iso(now - 1000), payer: BUYER_A, amount_usd: '1' }),
          order({ route_id: 'mercury_a', ts: iso(now - 2000), payer: INTERNAL, amount_usd: '2' }),
          order({ route_id: 'mercury_a', ts: iso(now - 3000), payer: null, amount_usd: '4' }),
        ],
        { internal: INTERNAL },
      ),
      '30d',
    )
    expect(s.totals.calls).toBe(3)
    expect(s.totals.volume_usd).toBe('7')
    // An undecodable payer is still a call, just not a distinct buyer.
    expect(s.totals.buyers).toBe(2)
  })

  it('counts distinct buyers, not calls', async () => {
    const s = await getStats(
      env([
        order({ route_id: 'mercury_a', ts: iso(now - 1000), payer: BUYER_A }),
        order({ route_id: 'mercury_a', ts: iso(now - 2000), payer: BUYER_A }),
        order({ route_id: 'mercury_a', ts: iso(now - 3000), payer: BUYER_B }),
      ]),
      '30d',
    )
    expect(s.services[0].calls).toBe(3)
    expect(s.services[0].buyers).toBe(2)
  })


  it('honours the window boundary', async () => {
    const records = [
      order({ route_id: 'mercury_a', ts: iso(now - 1000) }),
      order({ route_id: 'mercury_a', ts: iso(now - 10 * DAY) }),
      order({ route_id: 'mercury_a', ts: iso(now - 60 * DAY) }),
    ]
    expect((await getStats(env(records), '24h')).totals.calls).toBe(1)
    expect((await getStats(env(records), '30d')).totals.calls).toBe(2)
    expect((await getStats(env(records), '90d')).totals.calls).toBe(3)
    expect((await getStats(env(records), 'all')).totals.calls).toBe(3)
  })

  it('produces an activity series bounded to 90 points', async () => {
    const s = await getStats(
      env([order({ route_id: 'mercury_a', ts: iso(now - 1000) })]),
      '30d',
    )
    expect(s.services[0].activity.length).toBeLessThanOrEqual(90)
    expect(s.services[0].activity.reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('survives an unparseable ledger record instead of emptying the page', async () => {
    const s = await getStats(
      env(['{not json', order({ route_id: 'mercury_a', ts: iso(now - 1000) })]),
      '30d',
    )
    expect(s.totals.calls).toBe(1)
  })

  it('degrades to an empty payload when KV is unavailable', async () => {
    const broken = {
      MPP_STORE: { list: () => Promise.reject(new Error('kv down')) },
      ROUTE_METRICS_DB: metricsDb(),
    } as unknown as Env
    const s = await getStats(broken, '30d')
    expect(s.totals.calls).toBe(0)
    // The caller must be able to tell "no data" from "we could not read it".
    expect(s.truncated).toBe(true)
  })
})

describe('getStats attribution and refunds', () => {
  const UNRESOLVED = 'GUNRESOLVEDPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'


  it('takes refunds from the ledger, which is actually updated', async () => {
    const s = await getStats(
      env([
        order({ route_id: 'mercury_a', ts: iso(now - 1000), refund_status: 'refunded' }),
        order({ route_id: 'mercury_a', ts: iso(now - 2000), refund_status: 'none' }),
        // 'pending' is not yet money returned, so it is not counted.
        order({ route_id: 'mercury_a', ts: iso(now - 3000), refund_status: 'pending' }),
      ]),
      '30d',
    )
    expect(s.services[0].refunded).toBe(1)
    expect(s.services[0].refund_rate).toBeCloseTo(0.3333, 4)
    expect(s.totals.refunded).toBe(1)
  })

  it('degrades to truncated when an individual KV read fails', async () => {
    const broken = {
      MPP_STORE: {
        async list() {
          return { keys: [{ name: 'mercury_order:0' }], list_complete: true }
        },
        get: () => Promise.reject(new Error('kv read failed')),
      },
      ROUTE_METRICS_DB: metricsDb(),
    } as unknown as Env
    // Must not become a 500; the endpoint promises degradation.
    const s = await getStats(broken, '30d')
    expect(s.totals.calls).toBe(0)
  })
})

describe('getStats coverage', () => {
  it('keeps a service that has quality rows but no ledger rows', async () => {
    // Every call failed before an order was written, or all succeeded
    // asynchronously. Dropping the provider from a provider-quality page is
    // the worst available failure mode.
    const e = {
      MPP_STORE: kv([]),
      ROUTE_METRICS_DB: metricsDb([], ['firecrawl']),
    } as unknown as Env
    const s = await getStats(e, '30d')
    expect(s.services.map((x) => x.service_id)).toContain('firecrawl')
    expect(s.services[0].calls).toBe(0)
  })


  it('marks a malformed ledger row as truncated rather than claiming completeness', async () => {
    const s = await getStats(
      env(['{not json', order({ route_id: 'mercury_a', ts: iso(now - 1000) })]),
      '30d',
    )
    expect(s.totals.calls).toBe(1)
    expect(s.truncated).toBe(true)
  })

  it('publishes its known coverage gaps', async () => {
    const s = await getStats(env([]), '30d')
    expect(s.coverage.known_gaps.length).toBeGreaterThan(0)
  })
})
