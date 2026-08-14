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
 * `TEMPO_RPC_URL` accepts a comma-separated pool, not just one URL.
 *
 * Public Tempo endpoints rate-limit **per source IP**, and on Workers the
 * egress IP is shared across the whole colo — we do not control it and
 * cannot raise the quota. Spreading requests over several independent
 * providers multiplies the effective quota without needing an API key from
 * any of them.
 *
 * Note this is deliberately NOT viem's `fallback()` transport. `fallback`
 * only advances to the next endpoint *after* the current one fails, so
 * every request piles onto the first URL until it starts erroring — that is
 * failover, not load spreading, and it would keep us pinned to one IP quota.
 * We round-robin instead, and additionally fail over on error.
 */
export function parseRpcUrls(raw: string | undefined): string[] {
  const urls = (raw ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  return urls.length > 0 ? urls : [DEFAULT_TEMPO_RPC_URL]
}

/**
 * How long an endpoint is skipped after a hard failure (connection refused,
 * DNS, 5xx). Something is actually wrong with it, so stop sending it traffic
 * for a while. Short enough that a brief blip doesn't take a provider out
 * for long.
 */
const ENDPOINT_COOLDOWN_MS = 15_000

/**
 * How long an endpoint is skipped after a **rate-limit** rejection (429).
 *
 * Deliberately far shorter than the hard-failure cooldown, and the reason is
 * the paid endpoint. Providers meter a key on a short rolling window, so a
 * 429 means "not this second", not "this endpoint is unhealthy" — measured
 * against the dRPC key on 2026-08-14, paced sequential calls alternated 429
 * and 200 within the same second while 5-way concurrency passed clean.
 *
 * With the hard cooldown applied to a 429, a single rejection benched our
 * only *keyed* endpoint for 15s and pushed the traffic it exists to absorb
 * back onto the shared-IP public pool — i.e. we would pay for a quota and
 * then decline to use it. Two seconds is long enough for a rolling window
 * to refill and short enough that the primary stays primary.
 */
const RATE_LIMIT_COOLDOWN_MS = 2_000

/**
 * Did this failure mean "slow down" rather than "you are broken"?
 *
 * viem surfaces an HTTP 429 as an `HttpRequestError` carrying `status`, but
 * some providers answer a limit as a JSON-RPC error instead, so match on the
 * message too. Misclassifying costs only cooldown length, never correctness.
 */
function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  if (status === 429) return true
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '').toLowerCase()
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many')
}

/**
 * Round-robin across the pool, skipping endpoints in cooldown, failing over
 * to the remaining ones if the chosen endpoint errors.
 *
 * Every request starts at a different endpoint, so with N healthy providers
 * each sees roughly 1/N of the traffic — that is the part that prevents the
 * limit rather than reacting to it.
 *
 * If every endpoint is in cooldown we still attempt the full rotation
 * rather than failing fast: an expired quota may have recovered, and a
 * late-but-successful payment beats a certain failure.
 */
function rotatingTransport(primaryUrls: string[], fallbackUrls: string[]): Transport {
  const cooldownUntil = new Map<string, number>()
  let cursor = 0

  // Primary wins ties on identity: if an operator lists the same URL in both
  // places, it is one endpoint at the better tier, not two.
  const primarySet = new Set(primaryUrls)
  const orderedUrls = [...primaryUrls, ...fallbackUrls.filter((u) => !primarySet.has(u))]

  return (opts) => {
    // `retryCount: 0` because failover is OUR job here. viem's default is to
    // retry the SAME url 3 times with backoff before surfacing the error,
    // which is the worst possible response to a 429: it spends three more
    // requests of a quota we have just been told is exhausted, adds its
    // backoff to the latency of every failed payment, and only then lets us
    // do the thing that would have worked — ask a different endpoint.
    const inner = orderedUrls.map((url) => ({
      url,
      isPrimary: primarySet.has(url),
      transport: http(url, { retryCount: 0 })(opts),
    }))
    const primaries = inner.filter((e) => e.isPrimary)
    const fallbacks = inner.filter((e) => !e.isPrimary)

    const request: EIP1193RequestFn = (async (args: any, reqOpts?: any) => {
      const now = Date.now()
      const healthy = (list: typeof inner) =>
        list.filter((e) => (cooldownUntil.get(e.url) ?? 0) <= now)

      // Round-robin *within* a tier, but never across one. A keyed endpoint
      // is metered per key rather than per IP, so it is the one that
      // actually raises our ceiling; spreading traffic evenly over it and
      // the public pool would leave most requests back on the shared colo
      // IP that caused the incident this pool exists to prevent.
      const rotate = <T,>(list: T[]) => {
        if (list.length === 0) return list
        const start = cursor++ % list.length
        return Array.from({ length: list.length }, (_, i) => list[(start + i) % list.length])
      }

      // Last resort: everything is cooling down. Attempt the full rotation
      // anyway — a quota may have refilled, and a late-but-successful
      // payment beats a certain failure.
      const attempts = [...rotate(healthy(primaries)), ...rotate(healthy(fallbacks))]
      const order = attempts.length > 0 ? attempts : [...rotate(primaries), ...rotate(fallbacks)]

      let lastError: unknown
      for (const entry of order) {
        try {
          const result = await (entry.transport.request as EIP1193RequestFn)(args, reqOpts)
          cooldownUntil.delete(entry.url)
          return result
        } catch (err) {
          lastError = err
          const penalty = isRateLimit(err) ? RATE_LIMIT_COOLDOWN_MS : ENDPOINT_COOLDOWN_MS
          cooldownUntil.set(entry.url, Date.now() + penalty)
        }
      }
      throw lastError
    }) as EIP1193RequestFn

    return { ...inner[0].transport, request }
  }
}

/** Test seam: current cooldown state is internal; exposed only for reset. */
export const RPC_ENDPOINT_COOLDOWN_MS = ENDPOINT_COOLDOWN_MS

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
 * One client per configured pool, for the life of the isolate.
 */
const clients = new Map<string, Client>()

/**
 * Get the shared Tempo viem client for `rpcUrl`, which may be a single URL
 * or a comma-separated pool.
 *
 * Pass the result to mppx as `getClient`. mppx will graft the Tempo chain
 * serializers on if they are missing, but we build with `tempoChain`
 * already so `Client.getResolver` returns our client untouched.
 *
 * Layering matters: the block cache sits OUTSIDE the rotation, so a cached
 * `latest` block costs no endpoint quota at all rather than merely being
 * spread across the pool.
 */
export function getTempoClient(rpcUrl?: string, primaryRpcUrl?: string): Client {
  const fallback = parseRpcUrls(rpcUrl)
  // No `parseRpcUrls` here: it substitutes the public default for an empty
  // input, which is right for the fallback pool and wrong for this one —
  // an unset primary must stay empty so the tier is simply absent.
  const primary = (primaryRpcUrl ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)

  const key = `${primary.join(',')}|${fallback.join(',')}`

  const existing = clients.get(key)
  if (existing) return existing

  const client = createClient({
    chain: tempoChain,
    transport: withBlockCache(rotatingTransport(primary, fallback)),
  })

  clients.set(key, client)
  return client
}

/**
 * Test seam: drop all cached clients (and with them the block cache).
 * Not used in production code.
 */
export function resetTempoClients(): void {
  clients.clear()
}
