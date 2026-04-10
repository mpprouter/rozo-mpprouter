/**
 * POST /v1/services/:service/:operation — Core proxy handler.
 *
 * Flow:
 * 1. Agent sends request → forward to merchant → get 402 challenge
 * 2. Parse Tempo challenge to learn amount/recipient
 * 3. Feed request through the mppx Stellar charge handler:
 *    - No credential → mppx returns a signed 402 challenge for the agent
 *    - Credential    → mppx verifies HMAC + on-chain Soroban simulation
 *                      (the `OPTIMISTIC_THRESHOLD` env var is declared
 *                      but not wired up — see notes.md)
 * 4. On verified payment, pay the merchant on Tempo via the mppx client
 * 5. Return merchant content to the agent with a Payment-Receipt header
 */

import { Credential } from 'mppx'
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
 *                  challenge.method === "stellar". Run mppx verification
 *                  and pay the Tempo merchant on the agent's behalf.
 *   - 'passthrough' → anything else. Forward the whole request including
 *                     Authorization to the merchant as-is. The router
 *                     does not touch this payment flow.
 *   - 'none'     → no Authorization header. Fall through to the default
 *                  Stellar 402 challenge flow so naive Stellar agents
 *                  learn what to pay.
 *
 * IMPORTANT: a prior version of this function parsed the header as if it
 * contained RFC 9110 auth-params (`Payment id="...", method="stellar", …`).
 * That is the `WWW-Authenticate` serialization format, not the
 * `Authorization` format. Real mppx Credentials are serialized as a
 * single base64url-encoded JSON blob after the `Payment ` prefix — see
 * mppx/src/Credential.ts:131. The old regex never matched any real
 * credential and therefore routed every Stellar payment through the
 * passthrough path, which bypassed verification entirely. Always parse
 * with `Credential.deserialize()` — mppx owns the wire format.
 */
function classifyAuth(authHeader: string | null): 'stellar' | 'passthrough' | 'none' {
  if (!authHeader) return 'none'
  const trimmed = authHeader.trim()
  // Payment scheme uses the MPP "Payment" prefix. Anything else is
  // definitely not a Stellar MPP credential — forward untouched.
  if (!/^Payment\s+/i.test(trimmed)) return 'passthrough'
  // Try to parse as a real mppx Credential. If it parses, the nested
  // `challenge.method` field tells us the payment method unambiguously.
  // If it doesn't parse, it's some non-mppx `Payment ...` scheme that
  // happens to share the prefix (e.g. an unrelated x402 dialect) — hand
  // it back to the merchant to interpret.
  try {
    const credential = Credential.deserialize(trimmed) as {
      challenge?: { method?: string }
    }
    const method = credential.challenge?.method?.toLowerCase()
    return method === 'stellar' ? 'stellar' : 'passthrough'
  } catch {
    return 'passthrough'
  }
}

/**
 * Stellar USDC has 7 decimals. Any merchant currency with more than 7
 * decimals cannot be represented losslessly on the Stellar side, so we
 * refuse to charge the agent rather than silently truncating.
 */
const STELLAR_USDC_DECIMALS = 7

/**
 * TIP-20 stablecoins on Tempo (pathUSD, USDC) are hard-coded at 6
 * decimals — see node_modules/mppx/dist/tempo/internal/defaults.js.
 * Merchants drop `decimals` from the wire format via a zod transform,
 * so we have to assume this value unless the challenge explicitly
 * overrides it. Revisit before adding non-Tempo upstreams. See notes.md.
 */
const TEMPO_DEFAULT_DECIMALS = 6

/**
 * Convert a base-unit integer amount (as a string) into a human-readable
 * decimal string. Uses BigInt so there is no floating-point error.
 *
 * Examples:
 *   baseUnitsToDecimalString("10000", 6)     === "0.01"
 *   baseUnitsToDecimalString("1000000", 6)   === "1"
 *   baseUnitsToDecimalString("1234567", 6)   === "1.234567"
 *   baseUnitsToDecimalString("1", 6)         === "0.000001"
 *   baseUnitsToDecimalString("0", 6)         === "0"
 *
 * Trailing zeros in the fractional part are stripped; a pure-integer
 * result loses its decimal point entirely. This matches what the Stellar
 * charge method's toBaseUnits() expects on the way back in.
 */
export function baseUnitsToDecimalString(amount: string, decimals: number): string {
  if (!/^-?\d+$/.test(amount)) {
    throw new Error(`baseUnitsToDecimalString: amount must be integer string, got ${amount}`)
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`baseUnitsToDecimalString: decimals must be non-negative integer, got ${decimals}`)
  }
  const negative = amount.startsWith('-')
  const digits = negative ? amount.slice(1) : amount
  if (decimals === 0) return negative ? `-${digits}` : digits
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '')
  const body = frac.length === 0 ? whole : `${whole}.${frac}`
  return negative ? `-${body}` : body
}

/**
 * Parse a Tempo WWW-Authenticate header into its fields.
 *
 * Format: Payment id="...", realm="...", method="tempo", intent="charge",
 *         request="base64", expires="..."
 * The request is base64url-encoded JSON: { amount, currency, recipient,
 * decimals, ... }
 *
 * Critical: Tempo emits `amount` in token base units (integer) together
 * with a `decimals` field describing the token's decimal precision. The
 * Stellar charge method, in contrast, expects `amount` as a human-readable
 * decimal string and applies its own `toBaseUnits(amount, 7)` internally.
 * Callers must convert between the two before forwarding — see
 * baseUnitsToDecimalString above. Dropping `decimals` here was the source
 * of the 1,000,000x overcharge bug.
 */
function parseTempoChallenge(wwwAuth: string): {
  id: string
  realm: string
  intent: string
  request: { amount: string; currency: string; recipient: string; decimals?: number; [key: string]: any }
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

  // Convert the merchant's base-unit amount into a decimal string for
  // the Stellar charge method.
  //
  // Tempo TIP-20 tokens (pathUSD, USDC) are hard-coded at 6 decimals on
  // the Tempo side — see node_modules/mppx/dist/tempo/internal/defaults.js
  // which exports `decimals = 6` with the comment "All TIP-20 tokens on
  // Tempo use 6 decimals, so there is no risk of mismatch." The merchant's
  // wire format drops `decimals` during the zod transform in mppx's
  // tempo.charge method, so the 402 challenge arrives with a base-unit
  // integer amount but no explicit decimals field.
  //
  // We therefore assume TEMPO_DEFAULT_DECIMALS unless the challenge
  // overrides it. If we ever start routing merchants on a chain where
  // stablecoins use different precision (e.g. BNB Chain ERC-20 USDT/USDC
  // use 18 decimals), this assumption MUST be revisited — see notes.md.
  const merchantDecimals = typeof parsed.request.decimals === 'number'
    ? parsed.request.decimals
    : TEMPO_DEFAULT_DECIMALS
  if (!Number.isInteger(merchantDecimals) || merchantDecimals < 0) {
    return new Response(JSON.stringify({
      error: 'Merchant challenge carried an invalid decimals field',
      raw: parsed.request,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (merchantDecimals > STELLAR_USDC_DECIMALS) {
    return new Response(JSON.stringify({
      error: 'Merchant token precision exceeds Stellar USDC',
      detail: `merchant decimals=${merchantDecimals}, stellar=${STELLAR_USDC_DECIMALS}. ` +
        `See notes.md for chains that need explicit handling (e.g. BNB Chain ERC-20 = 18 decimals).`,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  let stellarAmount: string
  try {
    stellarAmount = baseUnitsToDecimalString(parsed.request.amount, merchantDecimals)
  } catch (err: any) {
    return new Response(JSON.stringify({
      error: 'Could not normalize merchant amount',
      detail: err.message,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let verifyResult
  try {
    verifyResult = await mppx['stellar/charge']({
      amount: stellarAmount,
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
