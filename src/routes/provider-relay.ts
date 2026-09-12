/**
 * Direct-settlement relay for self-serve provider routes.
 *
 * ## Why the proxy's own 402 is the wrong tool here
 *
 * For every snapshot route the proxy issues its own Stellar challenge,
 * settles the buyer's USDC into the ROZO pool, then pays the upstream out
 * of that pool. The 2026-09-03 operator branch reused the first two steps
 * with `recipient = provider` and skipped the third — but the provider's
 * server still demands payment on every request, and it has never seen
 * the credential the router just settled. So the sequence for a published
 * provider was: buyer's USDC lands in the provider's wallet, router calls
 * the provider unpaid, provider answers 402, buyer gets 502. Paid, not
 * served, and by founder decision (2026-09-03) direct routes have no
 * refund because the router never held the money. No provider was
 * published when that shipped, so nobody hit it; automatic publication
 * would have made it the first thing a buyer hit.
 *
 * ## What this does instead
 *
 * Nothing clever. The router forwards the buyer's request — including
 * whatever payment credential they attached (`Authorization: Payment …`
 * for mppx, `PAYMENT-SIGNATURE` / `X-PAYMENT` for x402) — to the
 * provider's own endpoint and returns the provider's answer verbatim, 402
 * included. The buyer pays the provider's own challenge with the
 * provider's own facilitator; the router signs nothing, settles nothing
 * and holds nothing. There is no leg on which the router can lose the
 * buyer's money, so there is nothing to refund.
 *
 * Which is exactly the claim the catalog makes for these routes:
 * `settlement: 'direct'`, "money never passes through us". The relay is
 * the implementation of that sentence.
 *
 * ## What the router still contributes
 *
 * The catalog listing, the verified payout address (a buyer can compare
 * the live 402's payTo against the published record), quality metrics
 * from every relayed call, and — via `/v1/services/select` — a choice
 * between providers that declared the same capability. Metrics are
 * recorded here at the single point every relayed call passes.
 */

import type { Env } from '../index'
import type { PublicServiceRoute } from '../services/merchants-types'
import { classifyOutcome, recordRouteCall } from '../services/route-metrics'
import { recordRouteFailure, recordRouteSuccess } from '../services/route-health'

/** Wall-clock ceiling on one relayed call; the provider's job, not ours, if it is slow. */
const RELAY_TIMEOUT_MS = 60_000

/** Hop-by-hop and origin-specific headers that must not be forwarded. */
const DROP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-authenticate', 'cf-connecting-ip', 'cf-ray', 'cf-visitor',
  'cf-ipcountry', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'content-length',
])

const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length',
  'alt-svc', 'server', 'cf-ray', 'cf-cache-status', 'set-cookie',
])

export function isDirectSettlementRoute(route: PublicServiceRoute): boolean {
  return Boolean(route.operator)
}

export function relayTargetUrl(route: PublicServiceRoute, requestUrl: URL): string {
  const target = new URL(`https://${route.upstreamHost}${route.upstreamPath}`)
  target.search = requestUrl.search
  return target.toString()
}

/**
 * Forward one request to the provider and hand back what it said.
 *
 * The recorded outcome is the provider's HTTP status through the shared
 * classifier, so a relayed 402 (buyer did not pay) counts as
 * `caller_error`, not as a provider fault — the provider answered
 * correctly. Only 5xx, timeouts and connection failures count against it.
 */
export async function relayDirectSettlementRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  route: PublicServiceRoute,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url)
  const target = relayTargetUrl(route, url)
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    if (DROP_REQUEST_HEADERS.has(key.toLowerCase())) continue
    headers.set(key, value)
  }
  headers.set('X-MPP-Router-Relay', route.id)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS)
  const startedAt = Date.now()
  let upstream: Response
  try {
    upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
    })
  } catch (err: any) {
    clearTimeout(timer)
    const timedOut = err?.name === 'AbortError'
    recordRouteCall(env, ctx, {
      routeId: route.id, method: request.method, outcome: 'provider_fault',
      reason: timedOut ? 'timeout' : 'unreachable',
    })
    recordRouteFailure(env, ctx, route.id, timedOut ? 'timeout' : 'upstream_5xx')
    return new Response(JSON.stringify({
      error: 'Provider endpoint unreachable',
      provider: route.operator!.id,
      settlement: 'direct',
      detail: timedOut ? 'The provider did not answer within the relay timeout.' : 'The provider could not be reached.',
      charged: false,
      note: 'MPP Router relays this route to the provider and never holds the payment; nothing was charged by the router.',
    }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
  clearTimeout(timer)
  const latencyMs = Date.now() - startedAt

  // A redirect would send the buyer (and their credential) off the origin
  // the provider proved control of. Refuse rather than follow.
  if (upstream.status >= 300 && upstream.status < 400) {
    recordRouteCall(env, ctx, { routeId: route.id, method: request.method, outcome: 'provider_fault', reason: 'redirect', upstreamStatus: upstream.status })
    recordRouteFailure(env, ctx, route.id, 'upstream_5xx')
    return new Response(JSON.stringify({
      error: 'Provider endpoint redirected',
      provider: route.operator!.id,
      status: upstream.status,
      detail: 'Direct-settlement routes must be served on the verified origin without redirects.',
    }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }

  const outcome = classifyOutcome(upstream.status, { routerHoldsCredential: false })
  recordRouteCall(env, ctx, {
    routeId: route.id, method: request.method, outcome, upstreamStatus: upstream.status,
    ...(outcome === 'ok' ? { latencyMs } : {}),
  })
  if (outcome === 'provider_fault') recordRouteFailure(env, ctx, route.id, upstream.status === 408 ? 'timeout' : 'upstream_5xx')
  else if (outcome === 'ok') recordRouteSuccess(env, ctx, route.id)

  const out = new Headers()
  for (const [key, value] of upstream.headers) {
    if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
    out.set(key, value)
  }
  out.set('X-MPP-Router-Settlement', 'direct')
  out.set('X-MPP-Router-Provider', route.operator!.id)
  out.set('Access-Control-Expose-Headers', [
    'Payment-Required', 'Payment-Response', 'X-Payment-Response', 'Payment-Receipt', 'WWW-Authenticate',
    'X-MPP-Router-Settlement', 'X-MPP-Router-Provider',
  ].join(', '))
  return new Response(upstream.body, { status: upstream.status, headers: out })
}
