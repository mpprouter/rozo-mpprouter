/**
 * POST /v1/services/:service/:operation — Core proxy handler.
 *
 * Flow:
 * 1. Agent sends request (no auth) → forward to merchant → get 402
 * 2. Translate Tempo 402 challenge into Stellar 402 challenge → return to agent
 * 3. Agent retries with Stellar payment credential
 * 4. Verify Stellar payment (signature always, simulation if > threshold)
 * 5. Pay merchant on Tempo via mppx client
 * 6. Return merchant content to agent
 * 7. Async: broadcast agent's Stellar tx
 */

import { getRouteByPublicPath } from '../services/merchants'
import { checkRateLimit } from '../middleware/rate-limit'
import { payMerchant } from '../mpp/tempo-client'
import { getRouterStellarAddress } from '../mpp/stellar-server'
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
 * Forward headers from agent to merchant, stripping sensitive ones.
 */
function forwardHeaders(request: Request): HeadersInit {
  const headers: Record<string, string> = {}
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase()
    if (lower === 'host' || lower === 'authorization') continue
    headers[key] = value
  }
  return headers
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

  // 2. Idempotency check
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

  // 3. Check if agent sent a payment credential
  const authHeader = request.headers.get('authorization')
  const merchantUrl = buildMerchantUrl(merchantHost, upstreamPath, url.search)

  if (!authHeader || !authHeader.startsWith('Payment ')) {
    // First request: forward to merchant to get the 402 challenge
    const merchantResponse = await fetch(merchantUrl, {
      method: request.method,
      headers: forwardHeaders(request),
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    })

    // If merchant returns non-402, passthrough directly
    if (merchantResponse.status !== 402) {
      return merchantResponse
    }

    // Translate Tempo 402 into Stellar 402
    const stellarChallenge = translateChallenge(merchantResponse, env)
    return stellarChallenge
  }

  // 4. Agent sent payment — rate limit check
  // TODO: Extract Stellar address from credential for proper rate limiting
  const rateLimitKey = 'agent' // placeholder until we parse the credential
  const maxRequests = parseInt(env.RATE_LIMIT_MAX || '10', 10)
  if (!await checkRateLimit(env.MPP_STORE, rateLimitKey, maxRequests)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 5. TODO: Verify Stellar payment credential
  // - Parse the Authorization header to extract the signed XDR
  // - Verify signature (always)
  // - If amount > OPTIMISTIC_THRESHOLD, simulate on Soroban RPC
  // - For now, we trust and proceed (will wire up stellar-server verify)
  console.log(`[proxy] Agent sent payment credential, forwarding to route ${route.id}`)

  // Clone the request body so mppx client can re-read it on 402 retry
  const requestBody = request.method !== 'GET' && request.method !== 'HEAD'
    ? await request.text()
    : undefined

  // 6. Pay merchant from Tempo pool
  // The mppx client handles the full 402 dance with the Tempo merchant
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

  // 7. Return merchant content to agent
  const contentType = merchantResponse.headers.get('content-type') || 'application/json'
  const body = await merchantResponse.text()

  // 8. Async tasks: broadcast Stellar tx + log + cache idempotency
  ctx.waitUntil((async () => {
    // TODO: Broadcast agent's Stellar tx to chain
    // TODO: Log payment record
    console.log(`[payment] route=${route.id} merchant=${merchantHost} upstreamPath=${upstreamPath}`)

    // Cache for idempotency
    if (requestId) {
      await env.MPP_STORE.put(`idempotency:${requestId}`, body, { expirationTtl: 86400 })
    }
  })())

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType },
  })
}

/**
 * Stellar USDC SAC contract addresses.
 */
const USDC_SAC: Record<string, string> = {
  'stellar:pubnet': 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  'stellar:testnet': 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
}

/**
 * Parse a Tempo WWW-Authenticate header into its fields.
 *
 * Format: Payment id="...", realm="...", method="tempo", intent="charge", request="base64", expires="..."
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

/**
 * Translate a Tempo 402 response into a Stellar 402 response.
 *
 * Rewrites the WWW-Authenticate header:
 *   - method: "tempo" → "stellar"
 *   - currency: Tempo USDC.e address → Stellar USDC SAC address
 *   - recipient: merchant 0x address → Router's Stellar G address
 *   - amount: kept the same (both USDC, 6 decimals)
 *   - adds: network field in methodDetails
 */
function translateChallenge(merchantResponse: Response, env: Env): Response {
  const wwwAuth = merchantResponse.headers.get('www-authenticate')
  if (!wwwAuth) {
    return new Response(JSON.stringify({ error: 'Merchant returned 402 without WWW-Authenticate header' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const parsed = parseTempoChallenge(wwwAuth)
  if (!parsed) {
    return new Response(JSON.stringify({ error: 'Could not parse merchant challenge', raw: wwwAuth }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const routerAddress = getRouterStellarAddress(env)
  const network = env.STELLAR_NETWORK || 'stellar:pubnet'
  const usdcSac = USDC_SAC[network] || USDC_SAC['stellar:pubnet']

  // Build the Stellar payment request (same amount, different currency + recipient)
  const stellarRequest = {
    amount: parsed.request.amount,
    currency: usdcSac,
    recipient: routerAddress,
    methodDetails: {
      network,
    },
  }

  // Base64url encode the request
  const requestB64 = btoa(JSON.stringify(stellarRequest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  // Build the WWW-Authenticate header in standard MPP format
  const parts = [
    `id="${parsed.id}"`,
    `realm="apiserver.mpprouter.dev"`,
    `method="stellar"`,
    `intent="${parsed.intent}"`,
    `request="${requestB64}"`,
  ]
  if (parsed.expires) {
    parts.push(`expires="${parsed.expires}"`)
  }
  const stellarWwwAuth = `Payment ${parts.join(', ')}`

  // Return 402 with proper header
  return new Response(JSON.stringify({
    status: 402,
    message: 'Payment required',
    method: 'stellar',
    router: routerAddress,
    network,
    amount: parsed.request.amount,
    currency: usdcSac,
  }, null, 2), {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': stellarWwwAuth,
    },
  })
}
