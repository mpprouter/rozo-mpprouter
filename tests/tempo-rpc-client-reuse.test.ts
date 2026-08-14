/**
 * Tempo RPC client reuse + block caching.
 *
 * Regression cover for the production incident where merchant payments
 * started failing with:
 *
 *   {"error":"Merchant payment failed",
 *    "detail":"Request exceeds defined limit.\nURL: https://rpc.tempo.xyz\n
 *              Request body: {\"method\":\"eth_getBlockByNumber\",...}\n
 *              Details: too many connections from this IP"}
 *
 * Two root causes, both locked in here:
 *
 *   1. `env.TEMPO_RPC_URL` never reached the payment path. mppx's
 *      `tempo.charge` / `tempo.session` / `sessionLegacy` each build their
 *      own client from mppx's hardcoded `defaults.rpcUrl`, and none of them
 *      accepts an `rpcUrl` parameter — `getClient` is the only injection
 *      point. So configuring a private endpoint was a silent no-op for
 *      payments (it only ever affected the balance pre-flight).
 *
 *   2. A new viem client, and therefore a new connection, per request —
 *      then ~3 sequential RPC round trips on it from
 *      `prepareTransactionRequest` (getBlock / getTransactionCount /
 *      estimateGas), plus a 4th from the uncached balance pre-flight.
 *
 * The tests below assert the observable consequences of the fix rather
 * than its shape, so they stay meaningful if the implementation moves.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  getTempoClient,
  resetTempoClients,
  parseRpcUrls,
  DEFAULT_TEMPO_RPC_URL,
} from '../src/mpp/tempo-rpc'
import {
  getTempoUsdcBalance,
  resetTempoBalanceCache,
} from '../src/utils/tempo-balance'

const PRIVATE_RPC = 'https://tempo.example-provider.io/v1/test-key'

const LATEST_BLOCK = {
  method: 'eth_getBlockByNumber',
  params: ['latest', false],
} as const

describe('getTempoClient', () => {
  beforeEach(() => {
    resetTempoClients()
  })

  it('returns the same client for the same URL (one connection, not one per request)', () => {
    const a = getTempoClient(PRIVATE_RPC)
    const b = getTempoClient(PRIVATE_RPC)
    expect(a).toBe(b)
  })

  it('uses the configured URL — the whole point of the fix', () => {
    const client = getTempoClient(PRIVATE_RPC)
    expect(client.transport.url).toBe(PRIVATE_RPC)
    // Guard against silently falling back to the public endpoint.
    expect(client.transport.url).not.toBe(DEFAULT_TEMPO_RPC_URL)
  })

  it('falls back to the public endpoint when unset, matching prior behaviour', () => {
    expect(getTempoClient(undefined).transport.url).toBe(DEFAULT_TEMPO_RPC_URL)
    expect(getTempoClient('').transport.url).toBe(DEFAULT_TEMPO_RPC_URL)
  })

  it('keys clients by URL so a config change is not masked by the cache', () => {
    const a = getTempoClient(PRIVATE_RPC)
    const b = getTempoClient('https://other.example.io')
    expect(a).not.toBe(b)
    expect(b.transport.url).toBe('https://other.example.io')
  })

  it('is built on the Tempo chain so viem picks the right tx serializer', () => {
    // Without this, signing fails with "maxFeePerGas is not a valid Legacy
    // Transaction attribute" — see mppx/dist/viem/Client.js:8-12.
    const client = getTempoClient(PRIVATE_RPC)
    expect(client.chain?.id).toBe(4217)
    expect(client.chain?.serializers?.transaction).toBeDefined()
  })
})

describe('latest-block caching', () => {
  let calls: any[]

  beforeEach(() => {
    resetTempoClients()
    calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: any, init: any) => {
        calls.push(JSON.parse(init.body))
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { number: '0x1', baseFeePerGas: '0x7' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('serves repeat latest-block reads from cache — this was the throttled call', async () => {
    const client = getTempoClient(PRIVATE_RPC)

    await client.request(LATEST_BLOCK as any)
    await client.request(LATEST_BLOCK as any)
    await client.request(LATEST_BLOCK as any)

    const blockCalls = calls.filter((c) => c.method === 'eth_getBlockByNumber')
    expect(blockCalls).toHaveLength(1)
  })

  it('coalesces a concurrent burst into a single upstream request', async () => {
    const client = getTempoClient(PRIVATE_RPC)

    await Promise.all(
      Array.from({ length: 8 }, () => client.request(LATEST_BLOCK as any)),
    )

    const blockCalls = calls.filter((c) => c.method === 'eth_getBlockByNumber')
    expect(blockCalls).toHaveLength(1)
  })

  it('never caches the calls where a stale answer would be a correctness bug', async () => {
    const client = getTempoClient(PRIVATE_RPC)

    // A cached nonce would double-spend; a cached gas estimate would
    // misprice; a cached send would drop a payment on the floor.
    for (const method of [
      'eth_getTransactionCount',
      'eth_estimateGas',
      'eth_sendRawTransaction',
    ]) {
      calls.length = 0
      await client.request({ method, params: [] } as any)
      await client.request({ method, params: [] } as any)
      expect(calls.filter((c) => c.method === method)).toHaveLength(2)
    }
  })

  it('does not serve a pinned block number from the latest-block cache', async () => {
    const client = getTempoClient(PRIVATE_RPC)

    await client.request(LATEST_BLOCK as any)
    calls.length = 0
    await client.request({ method: 'eth_getBlockByNumber', params: ['0x1234', false] } as any)

    expect(calls).toHaveLength(1)
  })
})

describe('Tempo balance pre-flight caching', () => {
  let fetchMock: any

  beforeEach(() => {
    resetTempoBalanceCache()
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x5f5e100' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hits the RPC once across repeated requests instead of once per request', async () => {
    const a = await getTempoUsdcBalance(PRIVATE_RPC, '0xabc')
    const b = await getTempoUsdcBalance(PRIVATE_RPC, '0xabc')

    expect(a).toBe(100_000_000n)
    expect(b).toBe(100_000_000n)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent pre-flights', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => getTempoUsdcBalance(PRIVATE_RPC, '0xabc')),
    )

    expect(new Set(results)).toEqual(new Set([100_000_000n]))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keys the cache by address so two wallets never share a balance', async () => {
    await getTempoUsdcBalance(PRIVATE_RPC, '0xabc')
    await getTempoUsdcBalance(PRIVATE_RPC, '0xdef')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caches failures too, so an RPC outage cannot become a retry storm', async () => {
    resetTempoBalanceCache()
    const failing = vi.fn(async () => new Response('nope', { status: 429 }))
    vi.stubGlobal('fetch', failing)

    expect(await getTempoUsdcBalance(PRIVATE_RPC, '0xabc')).toBeNull()
    expect(await getTempoUsdcBalance(PRIVATE_RPC, '0xabc')).toBeNull()

    // 2 per uncached attempt (tempo_getBalance + eth_call fallback);
    // the point is the second call adds none.
    expect(failing).toHaveBeenCalledTimes(2)
  })
})

/**
 * Endpoint rotation.
 *
 * Public Tempo endpoints limit per source IP, and on Workers we share an
 * egress IP across the colo — we can't raise the quota, so we spread across
 * several providers instead. The distinction that matters here: viem's
 * built-in `fallback()` only moves on *after* an endpoint errors, which
 * pins all traffic to endpoint #1 and its single quota. These tests pin the
 * spreading behaviour, not just the failover behaviour.
 */
describe('RPC endpoint rotation', () => {
  // Paths, not bare hosts: `fetch` normalizes "https://a.example" to
  // "https://a.example/", which would make these assertions compare
  // different strings for the same endpoint.
  const POOL = ['https://a.example/rpc', 'https://b.example/rpc', 'https://c.example/rpc']

  let hits: string[]
  let failing: Set<string>

  beforeEach(() => {
    resetTempoClients()
    hits = []
    failing = new Set()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        const u = String(url)
        hits.push(u)
        if (failing.has(u)) return new Response('rate limited', { status: 429 })
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // A method that is never cached, so each call must reach an endpoint.
  const uncached = { method: 'eth_getTransactionCount', params: ['0xabc', 'pending'] }

  it('parses a comma-separated pool and tolerates whitespace', () => {
    expect(parseRpcUrls('https://a.example/rpc, https://b.example/rpc')).toEqual([
      'https://a.example/rpc',
      'https://b.example/rpc',
    ])
    expect(parseRpcUrls('https://a.example/rpc')).toEqual(['https://a.example/rpc'])
    expect(parseRpcUrls(undefined)).toEqual([DEFAULT_TEMPO_RPC_URL])
    expect(parseRpcUrls('')).toEqual([DEFAULT_TEMPO_RPC_URL])
    expect(parseRpcUrls('  ,  ')).toEqual([DEFAULT_TEMPO_RPC_URL])
  })

  it('spreads requests across the pool instead of hammering the first', async () => {
    const client = getTempoClient(POOL.join(','))

    for (let i = 0; i < 9; i++) await client.request(uncached as any)

    // 9 requests over 3 endpoints — each should carry a third.
    for (const url of POOL) {
      expect(hits.filter((h) => h === url)).toHaveLength(3)
    }
  })

  it('does not pin traffic to one endpoint (the fallback() failure mode)', async () => {
    const client = getTempoClient(POOL.join(','))

    for (let i = 0; i < 6; i++) await client.request(uncached as any)

    expect(new Set(hits).size).toBe(3)
  })

  it('fails over to a healthy endpoint when one is rate-limited', async () => {
    failing.add('https://a.example/rpc')
    const client = getTempoClient(POOL.join(','))

    const result = await client.request(uncached as any)

    expect(result).toBe('0x1')
    expect(hits).toContain('https://a.example/rpc')
  })

  it('stops sending traffic to a failed endpoint (cooldown)', async () => {
    failing.add('https://a.example/rpc')
    const client = getTempoClient(POOL.join(','))

    // First pass discovers a is bad.
    for (let i = 0; i < 3; i++) await client.request(uncached as any)
    hits.length = 0
    // Subsequent traffic should route around it entirely.
    for (let i = 0; i < 6; i++) await client.request(uncached as any)

    expect(hits.filter((h) => h === 'https://a.example/rpc')).toHaveLength(0)
    expect(new Set(hits).size).toBe(2)
  })

  it('still attempts every endpoint when all are cooled down, rather than failing fast', async () => {
    POOL.forEach((u) => failing.add(u))
    const client = getTempoClient(POOL.join(','))

    await expect(client.request(uncached as any)).rejects.toBeTruthy()

    hits.length = 0
    failing.clear() // quota recovered
    const result = await client.request(uncached as any)

    expect(result).toBe('0x1')
  })

  it('throws when every endpoint fails, surfacing the error', async () => {
    POOL.forEach((u) => failing.add(u))
    const client = getTempoClient(POOL.join(','))

    await expect(client.request(uncached as any)).rejects.toBeTruthy()
    // Every endpoint was tried before giving up.
    expect(new Set(hits).size).toBe(3)
  })

  it('serves cached blocks without spending any endpoint quota', async () => {
    const client = getTempoClient(POOL.join(','))

    await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] } as any)
    hits.length = 0
    await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] } as any)
    await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] } as any)

    expect(hits).toHaveLength(0)
  })

  it('keys the client by the whole pool, so changing the pool builds a new client', () => {
    const a = getTempoClient(POOL.join(','))
    const b = getTempoClient(POOL.slice(0, 2).join(','))
    expect(a).not.toBe(b)
  })
})

/**
 * Priority tiers + graded cooldown (2026-08-14).
 *
 * Context: the pool that shipped on 2026-08-12 spread traffic evenly over
 * four PUBLIC endpoints. Public endpoints meter per source IP, and on
 * Workers the egress IP belongs to the whole colo — so an even spread
 * still leaves every request inside a quota we neither own nor control.
 * A keyed endpoint is metered per KEY, which is the only thing that
 * actually raises our ceiling, so it must be preferred rather than merely
 * included.
 *
 * The second half of that is cooldown length. Measured against the real
 * dRPC key on 2026-08-14, paced sequential calls alternated 429 and 200
 * within the same second. Under the original flat 15s cooldown a single
 * 429 benched the keyed endpoint and handed its traffic straight back to
 * the shared-IP pool — paying for a quota and then declining to use it.
 */
describe('RPC endpoint priority tiers', () => {
  const PRIMARY = 'https://keyed.example/rpc/secret-key'
  const PUBLIC = ['https://pub1.example/rpc', 'https://pub2.example/rpc']

  let hits: string[]
  let failing: Set<string>
  let status: number
  let now: number

  beforeEach(() => {
    resetTempoClients()
    // Cooldown is clock-based, not timer-based, so moving Date.now is
    // enough — and unlike fake timers it leaves the transport's own
    // promises running normally.
    now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    hits = []
    failing = new Set()
    status = 429
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        const u = String(url)
        hits.push(u)
        if (failing.has(u)) return new Response('nope', { status })
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const uncached = { method: 'eth_getTransactionCount', params: ['0xabc', 'pending'] }

  it('sends every request to the keyed endpoint while it is healthy', async () => {
    const client = getTempoClient(PUBLIC.join(','), PRIMARY)

    for (let i = 0; i < 8; i++) await client.request(uncached as any)

    expect(hits.filter((h) => h === PRIMARY)).toHaveLength(8)
    expect(hits.filter((h) => PUBLIC.includes(h))).toHaveLength(0)
  })

  it('falls back to the public pool when the keyed endpoint rejects', async () => {
    failing.add(PRIMARY)
    const client = getTempoClient(PUBLIC.join(','), PRIMARY)

    const result = await client.request(uncached as any)

    expect(result).toBe('0x1')
    expect(hits[0]).toBe(PRIMARY)
    expect(PUBLIC).toContain(hits[1])
  })

  it('returns to the keyed endpoint ~2s after a 429, not 15s', async () => {
    failing.add(PRIMARY)
    const client = getTempoClient(PUBLIC.join(','), PRIMARY)
    await client.request(uncached as any)

    // Rolling window refills; the endpoint starts answering again.
    failing.delete(PRIMARY)

    now += 2_500
    hits.length = 0
    await client.request(uncached as any)

    expect(hits[0]).toBe(PRIMARY)
  })

  it('keeps a hard failure benched for the full 15s (429 grace is not a blanket)', async () => {
    status = 500
    failing.add(PRIMARY)
    const client = getTempoClient(PUBLIC.join(','), PRIMARY)
    await client.request(uncached as any)

    failing.delete(PRIMARY)

    now += 3_000
    hits.length = 0
    await client.request(uncached as any)

    // Still benched — a 500 means broken, not "slow down".
    expect(hits[0]).not.toBe(PRIMARY)

    now += 13_000
    hits.length = 0
    await client.request(uncached as any)
    expect(hits[0]).toBe(PRIMARY)
  })

  it('still tries the keyed endpoint when the entire pool is cooling down', async () => {
    failing.add(PRIMARY)
    PUBLIC.forEach((u) => failing.add(u))
    const client = getTempoClient(PUBLIC.join(','), PRIMARY)

    await expect(client.request(uncached as any)).rejects.toBeTruthy()

    failing.clear()
    hits.length = 0
    await client.request(uncached as any)
    expect(hits[0]).toBe(PRIMARY)
  })

  it('behaves exactly as before when no primary is configured', async () => {
    const client = getTempoClient(PUBLIC.join(','))

    for (let i = 0; i < 4; i++) await client.request(uncached as any)

    expect(new Set(hits)).toEqual(new Set(PUBLIC))
  })

  it('treats a URL listed in both tiers as one endpoint at the better tier', async () => {
    const client = getTempoClient([PRIMARY, ...PUBLIC].join(','), PRIMARY)

    for (let i = 0; i < 5; i++) await client.request(uncached as any)

    // Not alternating between "primary" and "fallback" copies of itself.
    expect(hits.filter((h) => h === PRIMARY)).toHaveLength(5)
  })

  it('keys the client cache on both tiers, so adding a key is not a no-op', () => {
    const withKey = getTempoClient(PUBLIC.join(','), PRIMARY)
    const without = getTempoClient(PUBLIC.join(','))
    expect(withKey).not.toBe(without)
  })
})

/**
 * The balance pre-flight took the SAME pool string and handed it straight
 * to `fetch()`. "https://a,https://b" is not a URL, so from 958c56d
 * (2026-08-12) onward every reading threw and returned null — and null is
 * indistinguishable from "RPC down" to the caller, which skips both the
 * low-balance alert and the insufficient-funds rejection. The result was a
 * 502 at the merchant-payment step where a clean 503 was intended.
 */
describe('Tempo balance pre-flight endpoint pool', () => {
  const POOL = ['https://p1.example/rpc', 'https://p2.example/rpc']
  const ADDRESS = '0x4374b2072ff9bc5c0e263CaE7866a41a4C601d29'
  const BALANCE_HEX = '0x0000000000000000000000000000000000000000000000000000000001aa2882'

  let hits: string[]

  beforeEach(() => {
    resetTempoBalanceCache()
    hits = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads a balance from a comma-separated pool (regression: always returned null)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        hits.push(String(url))
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: BALANCE_HEX }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )

    const balance = await getTempoUsdcBalance(POOL.join(','), ADDRESS)

    expect(balance).toBe(BigInt(BALANCE_HEX))
    expect(hits[0]).toBe(POOL[0])
  })

  it('falls through to the next endpoint when one is unusable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        const u = String(url)
        hits.push(u)
        if (u === POOL[0]) return new Response('rate limited', { status: 429 })
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: BALANCE_HEX }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )

    expect(await getTempoUsdcBalance(POOL.join(','), ADDRESS)).toBe(BigInt(BALANCE_HEX))
  })

  it('survives a provider that does not implement tempo_getBalance', async () => {
    // Verified against both rpc.tempo.xyz and the dRPC endpoint on
    // 2026-08-14: each answers -32601 for tempo_getBalance, so eth_call is
    // the branch that actually returns a number today.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body)
        if (body.method === 'tempo_getBalance') {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method is not available' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: BALANCE_HEX }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )

    expect(await getTempoUsdcBalance(POOL.join(','), ADDRESS)).toBe(BigInt(BALANCE_HEX))
  })

  it('prefers the keyed endpoint here too', async () => {
    const PRIMARY = 'https://keyed.example/rpc/secret-key'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        hits.push(String(url))
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: BALANCE_HEX }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )

    await getTempoUsdcBalance(POOL.join(','), ADDRESS, PRIMARY)

    expect(hits[0]).toBe(PRIMARY)
  })
})
