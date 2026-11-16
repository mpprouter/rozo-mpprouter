import { describe, expect, it } from 'vitest'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import { handleClientReport, parseClientReport } from '../src/routes/client-report'

function makeDb(fail = false) {
  const rows: unknown[][] = []
  const sqls: string[] = []
  return {
    rows,
    sqls,
    db: {
      prepare(sql: string) {
        sqls.push(sql)
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              if (fail) throw new Error('d1 down')
              rows.push(args)
              return { success: true }
            },
          }),
        }
      },
    },
  }
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  const store = new Map<string, string>()
  return {
    CLIENT_REPORTS_ENABLED: 'true',
    CLIENT_REPORTS_IP_LIMIT_PER_HOUR: '3',
    CLIENT_REPORTS_GLOBAL_LIMIT_PER_HOUR: '5',
    ATOMIC_STORE: makeAtomicStoreMock(),
    MPP_STORE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
    ...extra,
  } as unknown as Env
}

const good = { client: 'rozo-checkout-cli', version: '0.1.27', outcome: 'refused', code: 'CREATE_DRIFT', flow: 'coinbase' }
const post = (env: Env, body: unknown, ip = '1.2.3.4') =>
  handleClientReport(
    new Request('https://mpp.test/v1/checkout/client-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  )

describe('parseClientReport', () => {
  it('accepts the contract and drops unknown fields', () => {
    expect(parseClientReport({ ...good, address: '0xabc', amount: '10', email: 'a@b.c' })).toEqual({
      client: 'rozo-checkout-cli', version: '0.1.27', outcome: 'refused', code: 'CREATE_DRIFT', flow: 'coinbase', rozoPaymentId: null,
    })
  })
  it('refuses anything out of contract', () => {
    for (const bad of [
      { ...good, client: 'other' },
      { ...good, version: 'latest' },
      { ...good, version: '0.1.27-John.Smith' },
      { ...good, outcome: 'paid' },
      { ...good, code: 'lower_case' },
      { ...good, code: 'A'.repeat(65) },
      { ...good, outcome: 'succeeded' },
      { ...good, flow: 'stripe' },
      { ...good, rozoPaymentId: 'not-a-uuid' },
      [good],
      null,
    ]) expect(parseClientReport(bad)).toBeNull()
  })
})

describe('POST /v1/checkout/client-report', () => {
  it('is 404 while off and 503 without a configured limit or database', async () => {
    const { db } = makeDb()
    expect((await post(makeEnv({ CLIENT_REPORTS_ENABLED: 'false', ROUTE_METRICS_DB: db }), good)).status).toBe(404)
    expect((await post(makeEnv({ CLIENT_REPORTS_IP_LIMIT_PER_HOUR: '', ROUTE_METRICS_DB: db }), good)).status).toBe(503)
    expect((await post(makeEnv(), good)).status).toBe(503)
  })

  it('stores one row with only the contract fields and answers 204 without echo', async () => {
    const { db, rows, sqls } = makeDb()
    const res = await post(makeEnv({ ROUTE_METRICS_DB: db }), { ...good, rozoPaymentId: 'AAAAAAAA-1111-4111-8111-111111111111', address: '0xabc' })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(sqls[0]).toContain('INSERT INTO checkout_client_reports')
    const [id, at, ...rest] = rows[0]
    expect(typeof id).toBe('string')
    expect(typeof at).toBe('number')
    expect(rest).toEqual(['rozo-checkout-cli', '0.1.27', 'refused', 'CREATE_DRIFT', 'coinbase', 'aaaaaaaa-1111-4111-8111-111111111111'])
    expect(JSON.stringify(rows)).not.toContain('0xabc')
  })

  it('a storage failure still answers 204', async () => {
    const { db } = makeDb(true)
    expect((await post(makeEnv({ ROUTE_METRICS_DB: db }), good)).status).toBe(204)
  })

  it('rejects bad JSON, oversize bodies and is rate limited per IP', async () => {
    const { db, rows } = makeDb()
    const env = makeEnv({ ROUTE_METRICS_DB: db })
    expect((await post(env, '{', '9.9.9.9')).status).toBe(400)
    expect((await post(env, JSON.stringify({ ...good, pad: 'x'.repeat(3000) }), '8.8.8.8')).status).toBe(413)
    for (let i = 0; i < 3; i++) expect((await post(env, good, '7.7.7.7')).status).toBe(204)
    expect((await post(env, good, '7.7.7.7')).status).toBe(429)
    expect(rows).toHaveLength(3)
  })
})

describe('review fixes', () => {
  it('stores unknown codes as OTHER, never verbatim (a Stellar key looks like a code)', () => {
    const key = 'S' + 'A'.repeat(55)
    expect(parseClientReport({ ...good, code: key })!.code).toBe('OTHER')
    expect(parseClientReport({ ...good, code: 'AWAITING_DEPOSIT', outcome: 'unconfirmed' })!.code).toBe('AWAITING_DEPOSIT')
  })

  it('the global hourly cap is atomic and binds across IPs', async () => {
    const { db, rows } = makeDb()
    const env = makeEnv({ ROUTE_METRICS_DB: db })
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => post(env, good, `10.0.0.${i}`)))
    expect(res.filter((r) => r.status === 204)).toHaveLength(5)
    expect(res.filter((r) => r.status === 429)).toHaveLength(3)
    expect(rows).toHaveLength(5)
  })

  it('fails closed when the atomic store is unavailable', async () => {
    const { db, rows } = makeDb()
    const env = makeEnv({ ROUTE_METRICS_DB: db, ATOMIC_STORE: { idFromName: () => { throw new Error('down') }, get: () => { throw new Error('down') } } })
    expect((await post(env, good)).status).toBe(429)
    expect(rows).toHaveLength(0)
  })

  it('needs the global limit configured', async () => {
    const { db } = makeDb()
    expect((await post(makeEnv({ ROUTE_METRICS_DB: db, CLIENT_REPORTS_GLOBAL_LIMIT_PER_HOUR: '' }), good)).status).toBe(503)
  })

  it('counts bytes, not UTF-16 units', async () => {
    const { db } = makeDb()
    const env = makeEnv({ ROUTE_METRICS_DB: db })
    expect((await post(env, JSON.stringify({ ...good, pad: '中'.repeat(800) }), '6.6.6.6')).status).toBe(413)
  })
})

describe('round 2 fixes', () => {
  it('counts in its own DO instance, never the payment singleton', async () => {
    const { db } = makeDb()
    const names: string[] = []
    const base = makeAtomicStoreMock() as any
    const ns = { ...base, idFromName: (n: string) => { names.push(n); return base.idFromName(n) }, get: (id: any) => base.get(id) }
    expect((await post(makeEnv({ ROUTE_METRICS_DB: db, ATOMIC_STORE: ns }), good)).status).toBe(204)
    expect(names.length).toBeGreaterThan(0)
    expect(names.every((n) => n === 'client-report-counter')).toBe(true)
  })
})
