/**
 * POST /v1/services/:service/:operation — Core proxy handler.
 *
 * Flow:
 * 1. Agent sends request → forward to merchant → get 402 challenge
 * 2. Parse Tempo challenge to learn amount/recipient
 * 3. Feed request through the mppx Stellar charge handler:
 *    - No credential → mppx returns a signed 402 challenge for the agent
 *    - Credential    → mppx verifies HMAC + signature (+ on-chain simulation
 *                      for amounts above OPTIMISTIC_THRESHOLD)
 * 4. On verified payment, pay the merchant on Tempo via the mppx client
 * 5. Return merchant content to the agent with a Payment-Receipt header
 */

import { getRouteByPublicPath } from '../services/merchants'
import { payMerchant } from '../mpp/tempo-client'
import {
  createStellarPayment,
  getRouterStellarAddress,
  getStellarUsdcSac,
} from '../mpp/stellar-server'
import type { Env } from '../index'

/**
 * Resolve a public Router URL to an internal upstream route.
 */
function resolveRoute(url: URL, method: string) {
  return getRouteByPublicPath(url.pathname, method)
}

/**
 * Build the full merchant URL from the internal route mapping.
 */
function buildMerchantUrl(merchantHost: string, upstreamPath: string, search: string): string {
  return `https://${merchantHost}${upstreamPath}${search}`
}

/**
 * Forward headers from agent to merchant.
 *
 * By default the agent's Authorization header is stripped — the router
 * replaces it with a Tempo credential minted from the router's own wallet
 * when paying the merchant. In transparent-passthrough mode (for non-
 * Stellar credentials) we keep Authorization so the merchant sees the
 * agent's original auth exactly as sent.
 */
function forwardHeaders(
  request: Request,
  opts: { keepAuthorization?: boolean } = {},
): HeadersInit {
  const headers: Record<string, string> = {}
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase()
    if (lower === 'host') continue
    if (lower === 'authorization' && !opts.keepAuthorization) continue
    headers[key] = value
  }
  return headers
}

/**
 * Inspect an Authorization header and decide whether it is a Stellar MPP
 * credential that we should verify + represent, or some other auth scheme
 * (Bearer, Basic, EVM x402, SIWX, etc.) that we should forward untouched.
 *
 * Returns:
 *   - 'stellar'  → agent presented an MPP Payment credential with
 *                  method="stellar". Run mppx verification and pay the
 *                  Tempo merchant on the agent's behalf.
 *   - 'passthrough' → anything else. Forward the whole request including
 *                     Authorization to the merchant as-is. The router
 *                     does not touch this payment flow.
 *   - 'none'     → no Authorization header. Fall through to the default
 *                  Stellar 402 challenge flow so naive Stellar agents
 *                  learn what to pay.
 */
function classifyAuth(authHeader: string | null): 'stellar' | 'passthrough' | 'none' {
  if (!authHeader) return 'none'
  const trimmed = authHeader.trim()
  // Payment scheme uses the MPP "Payment" prefix. Anything else is
  // definitely not a Stellar MPP credential.
  if (!/^Payment\s+/i.test(trimmed)) return 'passthrough'
  // Extract the method="..." field from the comma-separated params.
  const methodMatch = trimmed.match(/method="([^"]+)"/i)
  if (!methodMatch) return 'passthrough'
  return methodMatch[1].toLowerCase() === 'stellar' ? 'stellar' : 'passthrough'
}

/**
 * Parse a Tempo WWW-Authenticate header into its fields.
 *
 * Format: Payment id="...", realm="...", method="tempo", intent="charge",
 *         request="base64", expires="..."
 * The request is base64url-encoded JSON: { amount, currency, recipient, ... }
 */
function parseTempoChallenge(wwwAuth: string): {
  id: string
  realm: string
  intent: string
  request: { amount: string; currency: string; recipient: string; [key: string]: any }
  expires?: string
} | null {
  try {
    const idMatch = wwwAuth.match(/id="([^"]+)"/)
    const realmMatch = wwwAuth.match(/realm="([^"]+)"/)
    const intentMatch = wwwAuth.match(/intent="([^"]+)"/)
    const requestMatch = wwwAuth.match(/request="([^"]+)"/)
    const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)

    if (!idMatch || !requestMatch) return null

    // Decode base64url request
    const requestJson = atob(requestMatch[1].replace(/-/g, '+').replace(/_/g, '/'))
    const request = JSON.parse(requestJson)

    return {
      id: idMatch[1],
      realm: realmMatch?.[1] || '',
      intent: intentMatch?.[1] || 'charge',
      request,
      expires: expiresMatch?.[1],
    }
  } catch {
    return null
  }
}

export async function handleProxy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url)

  const route = resolveRoute(url, request.method)
  if (!route) {
    return new Response(JSON.stringify({
      error: 'Unknown public service route',
      hint: 'Use GET /v1/services/catalog for the list of supported public routes',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const merchantHost = route.upstreamHost
  const upstreamPath = route.upstreamPath
  const merchantUrl = buildMerchantUrl(merchantHost, upstreamPath, url.search)

  // Idempotency check — return cached result on repeat POSTs with same id.
  const requestId = request.headers.get('x-request-id')
  if (requestId) {
    const cached = await env.MPP_STORE.get(`idempotency:${requestId}`)
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Idempotent': 'true' },
      })
    }
  }

  // Read the body once; we may need to send it twice (merchant 402 probe + real paid call).
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const requestBody = hasBody ? await request.text() : undefined

  // 0. Wallet-type gate. Router only represents Stellar wallets. If the
  // agent sent any other kind of Authorization header (Bearer, Basic,
  // EVM x402, SIWX, Solana MPP, …) the merchant decides how to handle
  // it — the router does not spend from the Tempo pool on their behalf.
  //
  // This closes the replay-amplification attack surface by construction:
  // router only funds merchant calls that came with a Stellar credential
  // the router itself issued via mppx. Any other credential type is
  // forwarded as-is and whatever economic exchange happens is between
  // the agent and the merchant.
  const authHeader = request.headers.get('authorization')
  const authKind = classifyAuth(authHeader)

  if (authKind === 'passthrough') {
    console.log(`[proxy] Non-Stellar credential — transparent passthrough to ${merchantHost}`)
    const passthroughResponse = await fetch(merchantUrl, {
      method: request.method,
      headers: forwardHeaders(request, { keepAuthorization: true }),
      body: requestBody,
    })
    return passthroughResponse
  }

  // 1. Probe the merchant to learn the live quote. If the merchant
  // serves content for free, pass that through directly.
  const probeResponse = await fetch(merchantUrl, {
    method: request.method,
    headers: forwardHeaders(request),
    body: requestBody,
  })

  if (probeResponse.status !== 402) {
    // Merchant doesn't require payment for this route — passthrough.
    return probeResponse
  }

  const wwwAuth = probeResponse.headers.get('www-authenticate')
  if (!wwwAuth) {
    return new Response(JSON.stringify({
      error: 'Merchant returned 402 without WWW-Authenticate header',
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const parsed = parseTempoChallenge(wwwAuth)
  if (!parsed) {
    return new Response(JSON.stringify({
      error: 'Could not parse merchant challenge',
      raw: wwwAuth,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 2. Run the request through the Stellar mppx handler. This is the
  // critical verification step: without a valid, HMAC-bound credential
  // whose echoed challenge matches the same amount/currency/recipient,
  // mppx returns a 402 challenge here and we never reach payMerchant.
  let mppx: ReturnType<typeof createStellarPayment>
  try {
    mppx = createStellarPayment(env)
  } catch (err: any) {
    console.error(`[proxy] Failed to initialize Stellar payment handler: ${err.message}`)
    return new Response(JSON.stringify({
      error: 'Router payment handler misconfigured',
      detail: err.message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Rebuild a Request clone that mppx can read (it calls request.headers /
  // url on the input). Body isn't needed by the charge verifier, but we
  // forward a fresh one so consumers of the input see the original.
  const mppxInput = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? requestBody : undefined,
  })

  let verifyResult
  try {
    verifyResult = await mppx['stellar/charge']({
      amount: parsed.request.amount,
      currency: getStellarUsdcSac(env),
      recipient: getRouterStellarAddress(env),
      // Correlate the mppx challenge with the upstream merchant challenge
      // so we can reconcile payments after the fact.
      meta: {
        upstreamChallengeId: parsed.id,
        route: route.id,
      },
    })(mppxInput)
  } catch (err: any) {
    console.error(`[proxy] Stellar verify threw: ${err.message}`)
    return new Response(JSON.stringify({
      error: 'Payment verification failed',
      detail: err.message,
    }), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (verifyResult.status === 402) {
    // Either no credential was presented, or it failed verification —
    // including replay attempts. The stellar charge method inside mppx
    // uses the shared KV store (see src/mpp/stellar-server.ts) to
    // reject any credential whose challenge id (and, for push mode, tx
    // hash) has already been settled. Replay protection is enforced
    // here, not via a counter, so we do not need an extra guard.
    //
    // NOTE: Cloudflare KV is eventually consistent, so two concurrent
    // replays *can* race past the dedup check within a narrow window.
    // For strict once-and-only-once semantics, migrate MPP_STORE to a
    // Durable Object. For now, the mppx store is the authoritative
    // replay guard and the window is small enough that the economic
    // loss is bounded to a single concurrent duplicate.
    return verifyResult.challenge
  }

  console.log(`[proxy] Stellar payment verified for route ${route.id}`)

  // 4. Pay the merchant from the Tempo pool. The mppx client handles the
  // full 402 dance with the Tempo merchant.
  let merchantResponse: Response
  try {
    merchantResponse = await payMerchant(env, merchantUrl, {
      method: request.method,
      headers: forwardHeaders(request),
      body: requestBody,
    })
  } catch (err: any) {
    console.error(`[proxy] Tempo payment error: ${err.message}`)
    return new Response(JSON.stringify({
      error: 'Merchant payment failed',
      detail: err.message,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  console.log(`[proxy] Merchant responded: ${merchantResponse.status}`)

  if (!merchantResponse.ok) {
    const errorBody = await merchantResponse.text()
    console.error(`[proxy] Merchant error body: ${errorBody.substring(0, 200)}`)
    return new Response(JSON.stringify({
      error: 'Merchant payment failed',
      status: merchantResponse.status,
      detail: errorBody.substring(0, 500),
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 5. Return merchant content to the agent with a Payment-Receipt header.
  const contentType = merchantResponse.headers.get('content-type') || 'application/json'
  const body = await merchantResponse.text()

  // Async tasks: broadcast Stellar tx (handled by mppx store), log, cache idempotency
  ctx.waitUntil((async () => {
    console.log(
      `[payment] route=${route.id} merchant=${merchantHost} upstreamPath=${upstreamPath}`,
    )
    if (requestId) {
      await env.MPP_STORE.put(`idempotency:${requestId}`, body, { expirationTtl: 86400 })
    }
  })())

  const merchantContent = new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType },
  })
  return verifyResult.withReceipt(merchantContent)
}
