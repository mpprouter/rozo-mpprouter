import { describe, it, expect } from 'vitest'
import { getStats } from '../src/services/stats'
import type { Env } from '../src/index'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { orderStatsRow, recordOrder, updateOrderRefundStatus, UPSERT_ORDER_STATS_SQL } from '../src/services/order-ledger'

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

/**
 * Metrics D1 stub. `serviceIds` answers the DISTINCT service_id query used to
 * seed services that have quality rows but no ledger rows.
 */
const MIGRATION = readFileSync(new URL('../migrations-metrics/0002_order_ledger_stats.sql', import.meta.url), 'utf8')

/**
 * D1 stub: `order_ledger_stats` SQL runs against a real in-memory SQLite
 * built from the shipped migration; quality-table queries get canned rows.
 */
function metricsDb(rows: any[] = [], serviceIds: string[] = [], sqlite = new DatabaseSync(':memory:')) {
  sqlite.exec(MIGRATION)
  const answer = (sql: string, args: any[]) => {
    if (sql.includes('order_ledger_stats')) {
      return { results: sqlite.prepare(sql).all(...args) }
    }
    return sql.includes('DISTINCT service_id')
      ? { results: serviceIds.map((service_id) => ({ service_id })) }
      : { results: rows }
  }
  const stmt = (sql: string, args: any[] = []) => ({
    bind: (...a: any[]) => stmt(sql, a),
    all: async () => answer(sql, args),
    run: async () => {
      if (sql.includes('order_ledger_stats')) sqlite.prepare(sql).run(...args)
    },
    _exec: () => answer(sql, args),
  })
  return {
    sqlite,
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: any[]) => stmts.map((x) => x._exec()),
  } as any
}

/** KV that fails the test if the stats path touches it at all. */
const forbiddenKv = new Proxy({}, {
  get() {
    throw new Error('stats must not read KV')
  },
}) as any

async function env(records: string[], opts: { internal?: string; unresolved?: string } = {}): Promise<Env> {
  const db = metricsDb()
  for (const raw of records) {
    const row = await orderStatsRow(JSON.parse(raw))
    if (!row) continue
    db.sqlite
      .prepare(UPSERT_ORDER_STATS_SQL)
      .run(row.order_id, row.created_at, row.service_id, row.amount_micros, row.payer_digest, row.refunded)
  }
  return {
    MPP_STORE: forbiddenKv,
    ROUTE_METRICS_DB: db,
    LEDGER_INTERNAL_PAYERS: opts.internal,
    LEDGER_UNRESOLVED_PAYERS: opts.unresolved,
  } as unknown as Env
}

describe('getStats', () => {
  it('groups calls by service and sorts busiest first', async () => {
    const s = await getStats(
      await env([
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
      await env([
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
      await env(
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
      await env([
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
    expect((await getStats(await env(records), '24h')).totals.calls).toBe(1)
    expect((await getStats(await env(records), '30d')).totals.calls).toBe(2)
    expect((await getStats(await env(records), '90d')).totals.calls).toBe(3)
    expect((await getStats(await env(records), 'all')).totals.calls).toBe(3)
  })

  it('produces an activity series bounded to 90 points', async () => {
    const s = await getStats(
      await env([order({ route_id: 'mercury_a', ts: iso(now - 1000) })]),
      '30d',
    )
    expect(s.services[0].activity.length).toBeLessThanOrEqual(90)
    expect(s.services[0].activity.reduce((a, b) => a + b, 0)).toBe(1)
  })

})

describe('getStats attribution and refunds', () => {
  const UNRESOLVED = 'GUNRESOLVEDPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'


  it('takes refunds from the ledger, which is actually updated', async () => {
    const s = await getStats(
      await env([
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

})

describe('getStats coverage', () => {
  it('keeps a service that has quality rows but no ledger rows', async () => {
    // Every call failed before an order was written, or all succeeded
    // asynchronously. Dropping the provider from a provider-quality page is
    // the worst available failure mode.
    const e = {
      MPP_STORE: forbiddenKv,
      ROUTE_METRICS_DB: metricsDb([], ['firecrawl']),
    } as unknown as Env
    const s = await getStats(e, '30d')
    expect(s.services.map((x) => x.service_id)).toContain('firecrawl')
    expect(s.services[0].calls).toBe(0)
  })


  it('publishes its known coverage gaps', async () => {
    const s = await getStats(await env([]), '30d')
    expect(s.coverage.known_gaps.length).toBeGreaterThan(0)
  })
})

describe('getStats commerce rollup', () => {
  it('answers 5000 orders from SQL with zero KV reads and truncated false', async () => {
    const recs = Array.from({ length: 5000 }, (_, i) =>
      order({ route_id: i % 2 ? 'mercury_a' : 'exa_search', ts: iso(now - (i % 29) * DAY - 1000), payer: `G${i % 300}`, amount_usd: '0.001' }),
    )
    const s = await getStats(await env(recs), '30d')
    expect(s.truncated).toBe(false)
    expect(s.totals.calls).toBe(5000)
    expect(s.totals.volume_usd).toBe('5')
    expect(s.totals.buyers).toBe(300)
    expect(s.services[0].activity.reduce((a, b) => a + b, 0)).toBe(s.services[0].calls)
  })

  it('reports truncated, not a confident zero, when the rollup cannot be read', async () => {
    const db = metricsDb()
    db.batch = async () => {
      throw new Error('d1 down')
    }
    const s = await getStats({ MPP_STORE: forbiddenKv, ROUTE_METRICS_DB: db } as unknown as Env, '30d')
    expect(s.totals.calls).toBe(0)
    expect(s.truncated).toBe(true)
  })

  it('reports truncated when the metrics database is not bound', async () => {
    const s = await getStats({ MPP_STORE: forbiddenKv } as unknown as Env, '30d')
    expect(s.truncated).toBe(true)
  })

  it('recordOrder mirrors into the rollup and a confirmed refund flips it', async () => {
    const db = metricsDb()
    const store = new Map<string, string>()
    const e = {
      MPP_STORE: {
        put: async (k: string, v: string) => void store.set(k, v),
        get: async (k: string) => store.get(k) ?? null,
      },
      ROUTE_METRICS_DB: db,
    } as unknown as Env
    const entry = JSON.parse(order({ route_id: 'mercury_a', ts: iso(now - 1000), amount_usd: '1.5' }))
    await recordOrder(e, entry)
    await recordOrder(e, entry) // idempotent
    let s = await getStats({ ...e, MPP_STORE: forbiddenKv } as unknown as Env, '30d')
    expect(s.totals.calls).toBe(1)
    expect(s.totals.volume_usd).toBe('1.5')
    expect(s.totals.refunded).toBe(0)
    await updateOrderRefundStatus(e, entry.order_id, 'refunded')
    s = await getStats({ ...e, MPP_STORE: forbiddenKv } as unknown as Env, '30d')
    expect(s.totals.refunded).toBe(1)
    const row = db.sqlite.prepare('SELECT payer_digest FROM order_ledger_stats').get() as any
    expect(row.payer_digest).not.toContain('G')
  })
})
