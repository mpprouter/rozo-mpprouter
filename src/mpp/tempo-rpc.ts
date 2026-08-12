/**
 * Shared Tempo RPC client.
 *
 * Two problems this file exists to fix:
 *
 * 1. **`TEMPO_RPC_URL` was never reaching the payment path.** mppx's
 *    `tempo.charge()` / `tempo.session()` / `sessionLegacy()` build their
 *    own viem client via `Client.getResolver({ rpcUrl: defaults.rpcUrl })`
 *    (see `mppx/dist/tempo/client/Charge.js:30-34`). `defaults.rpcUrl` is
 *    mppx's own hardcoded map — `{ 4217: 'https://rpc.tempo.xyz' }`. None
 *    of the three methods accepts an `rpcUrl` parameter, so the ONLY
 *    supported injection point is `getClient`. Before this file, pointing
 *    `TEMPO_RPC_URL` at a private endpoint changed nothing for payments;
 *    it only affected the balance pre-flight in `utils/tempo-balance.ts`.
 *
 * 2. **A fresh viem client — and therefore a fresh connection — per
 *    request.** `createTempoClientInternal` runs per request, and mppx
 *    calls the client resolver once per 402 challenge, which lands in the
 *    no-`getClient` branch of `Client.getResolver` and does
 *    `createClient({ transport: http(url) })` every time
 *    (`mppx/dist/viem/Client.js:41-53`). On Cloudflare Workers the egress
 *    IP is shared across the whole colo, so per-request connections is how
 *    we ended up getting `too many connections from this IP` back from the
 *    public endpoint.
 *
 * Passing a module-scope singleton through `getClient` fixes both at once.
 *
 * ## Why a singleton is safe here
 *
 * The client holds no per-request state: the signing account is supplied
 * separately by mppx (`Account.getResolver`), and the transport is a thin
 * wrapper over `fetch`. Module scope on Workers is per-isolate, so this is
 * "reused for as long as the isolate lives" — exactly the lifetime we want.
 * It is keyed by URL so a config change (or a test overriding the URL)
 * produces a distinct client rather than silently reusing the old endpoint.
 *
 * ## Why the block cache
 *
 * The RPC call that actually tripped the limit is `eth_getBlockByNumber`
 * with `latest`, issued by viem's `prepareTransactionRequest` to compute
 * EIP-1559 fees (`viem/_esm/actions/wallet/prepareTransactionRequest.js:238-241`,
 * consumed at `:285/:298/:320`). viem does **not** cache `getBlock`, so
 * every merchant payment refetched it. Base fee moves at most once per
 * block, so a short TTL is safe for fee estimation and removes the
 * hot-path fetch entirely under any real request rate.
 *
 * Note this also un-breaks a viem cache we were defeating: `prepareTransactionRequest`
 * memoizes "is this an EIP-1559 network" in `eip1559NetworkCache` keyed by
 * `client.uid`. With a new client per request that cache never hit, forcing
 * an extra `getBlock`. A stable client makes it hit after the first call.
 */

import { createClient, http, type Client, type EIP1193RequestFn, type Transport } from 'viem'
import { tempo as tempoChain } from 'viem/tempo/chains'

/**
 * Fallback when `env.TEMPO_RPC_URL` is unset. Identical to mppx's own
 * default, so behaviour is unchanged for any caller that never configured
 * one — this file changes *where the URL comes from*, not what it defaults
 * to.
 */
export const DEFAULT_TEMPO_RPC_URL = 'https://rpc.tempo.xyz'

/**
 * How long a `latest` block is reused for fee estimation.
 *
 * Deliberately short. This is only ever used to read `baseFeePerGas`; it is
 * never used to pick a nonce, decide finality, or read balances, so a value
 * a couple of seconds stale cannot produce a wrong payment — at worst a fee
 * estimate computed against a base fee one block old.
 */
const BLOCK_CACHE_MS = 2_000

type CacheEntry = { value: unknown; expiresAt: number }

/**
 * Wrap a transport so that `eth_getBlockByNumber('latest', false)` is
 * served from a short-lived cache, and so that concurrent callers asking
 * for it at the same moment share one upstream request instead of racing.
 *
 * Only that one method is cached. Everything else — `eth_estimateGas`,
 * `eth_getTransactionCount`, `eth_sendRawTransaction` — passes straight
 * through, because caching any of those would be a correctness bug.
 */
function withBlockCache(inner: Transport): Transport {
  let cached: CacheEntry | null = null
  let inFlight: Promise<unknown> | null = null

  return (opts) => {
    const transport = inner(opts)
    const request = transport.request as EIP1193RequestFn

    const patched: EIP1193RequestFn = (async (args: any, reqOpts?: any) => {
      const isLatestBlock =
        args?.method === 'eth_getBlockByNumber' && args?.params?.[0] === 'latest'

      if (!isLatestBlock) return request(args, reqOpts)

      const now = Date.now()
      if (cached && cached.expiresAt > now) return cached.value

      // Coalesce: a burst of concurrent payments should produce one
      // upstream call, not one per payment.
      if (inFlight) return inFlight

      inFlight = (async () => {
        try {
          const value = await request(args, reqOpts)
          cached = { value, expiresAt: Date.now() + BLOCK_CACHE_MS }
          return value
        } finally {
          inFlight = null
        }
      })()

      return inFlight
    }) as EIP1193RequestFn

    return { ...transport, request: patched }
  }
}

/**
 * One client per RPC URL, for the life of the isolate.
 */
const clients = new Map<string, Client>()

/**
 * Get the shared Tempo viem client for `rpcUrl`.
 *
 * Pass the result to mppx as `getClient`. mppx will graft the Tempo chain
 * serializers on if they are missing, but we build with `tempoChain`
 * already so `Client.getResolver` returns our client untouched.
 */
export function getTempoClient(rpcUrl?: string): Client {
  const url = rpcUrl || DEFAULT_TEMPO_RPC_URL

  const existing = clients.get(url)
  if (existing) return existing

  const client = createClient({
    chain: tempoChain,
    transport: withBlockCache(http(url)),
  })

  clients.set(url, client)
  return client
}

/**
 * Test seam: drop all cached clients (and with them the block cache).
 * Not used in production code.
 */
export function resetTempoClients(): void {
  clients.clear()
}
