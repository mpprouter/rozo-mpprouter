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
