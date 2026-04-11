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
import {
  getRouteByPublicPath,
  resolveUpstreamPath,
  UpstreamPathPlaceholderError,
} from '../services/merchants'
import {
  ChannelNotInstalledError,
  payMerchant,
  payMerchantSession,
} from '../mpp/tempo-client'
import { bumpCumulative } from '../mpp/channel-store'
import {
  createStellarPayment,
  getRouterStellarAddress,
  getStellarUsdcSac,
} from '../mpp/stellar-server'
import {
  resolveStellarChannelMppx,
  StellarChannelNotRegisteredError,
} from '../mpp/stellar-channel-dispatch'
import {
  buildX402PaymentRequiredHeader,
  checkAndReserveNonce,
  isStellarX402ForThisRouter,
  prepareStellarX402Inbound,
  settleStellarX402,
  verifyStellarX402WithFacilitator,
} from '../mpp/stellar-x402-server'
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
 * Inspect an Authorization header and decide how the router should
 * treat the credential.
 *
 * Returns:
 *   - 'stellar.charge'  → agent presented a Stellar MPP credential
 *                         with intent="charge" (V1, single-shot USDC
 *                         payment). Run the charge verify path and
 *                         pay the Tempo merchant on the agent's
 *                         behalf.
 *   - 'stellar.channel' → agent presented a Stellar MPP credential
 *                         with intent="channel" (V2 §6, long-lived
 *                         payment channel voucher). Run the channel
 *                         dispatch path which looks up the
 *                         channel's sidecar metadata in KV and
 *                         builds a per-request Mppx instance.
 *   - 'passthrough'     → anything else — non-Stellar MPP, Bearer,
 *                         Basic, EVM x402, SIWX, unrelated Payment
 *                         schemes. Forward untouched; the router
 *                         does not settle these.
 *   - 'none'            → no Authorization header. Fall through to
 *                         the default Stellar 402 challenge flow so
 *                         naive Stellar agents learn what to pay.
 *
 * History: V1 returned just `'stellar'` without distinguishing
 * intent. V2 splits `'stellar'` into `'stellar.charge'` vs
 * `'stellar.channel'` so the proxy can route each to the right
 * verify handler. Critically, both intents carry
 * `challenge.method === "stellar"`, so the intent field is the
 * ONLY way to tell them apart from the credential wire format.
 *
 * IMPORTANT: a pre-V1 draft of this function parsed the header as
 * if it contained RFC 9110 auth-params (`Payment id="...",
 * method="stellar", ...`). That is the `WWW-Authenticate`
 * serialization format, not the `Authorization` format. Real mppx
 * Credentials are serialized as a single base64url-encoded JSON
 * blob after the `Payment ` prefix — see
 * mppx/src/Credential.ts:131. Always parse with
 * `Credential.deserialize()` — mppx owns the wire format.
 */
type AuthKind =
  | 'stellar.charge'
  | 'stellar.channel'
  | 'stellar.x402'
  | 'passthrough'
  | 'none'

function classifyAuth(authHeader: string | null, env: Env): AuthKind {
  if (!authHeader) return 'none'
  const trimmed = authHeader.trim()
  // Payment scheme uses the MPP "Payment" prefix. Anything else is
  // definitely not a Stellar MPP credential — forward untouched.
  if (!/^Payment\s+/i.test(trimmed)) return 'passthrough'
  // Try to parse as a real mppx Credential first. mppx credentials
  // deserialize as `{ challenge: { method, intent, ... }, ... }`.
  // x402 payloads deserialize as `{ x402Version, accepted, payload }`
  // and will throw inside mppx's Credential.deserialize — so mppx
  // failure is our "maybe x402?" trigger.
  try {
    const credential = Credential.deserialize(trimmed) as {
      challenge?: { method?: string; intent?: string }
    }
    const method = credential.challenge?.method?.toLowerCase()
    if (method === 'stellar') {
      const intent = credential.challenge?.intent?.toLowerCase()
      if (intent === 'channel') return 'stellar.channel'
      // Default for stellar.* credentials is charge. This matches V1
      // behavior: any stellar credential without an explicit
      // 'channel' intent takes the charge path. New intents added by
      // future mppx versions will need explicit cases here.
      return 'stellar.charge'
    }
    // Parsed as mppx but non-Stellar method — fall through.
  } catch {
    // Not an mppx credential. Fall through to x402 check.
  }
  // Stellar x402 (via @x402/core + @x402/stellar). Only claim the
  // credential if its `payTo` matches STELLAR_X402_PAY_TO AND the
  // feature flag is on. This makes dispatch opt-in per request so
  // agents paying directly to some other Stellar recipient (not our
  // router) stay in passthrough.
  if (isStellarX402ForThisRouter(trimmed, env)) return 'stellar.x402'
  return 'passthrough'
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
/**
 * Stellar mainnet native XLM Soroban Asset Contract (SAC) address.
 * Soroban contracts refer to native XLM via this specific SAC instance,
 * not the string "native" (that would be a Stellar account alias).
 *
 * Verify with: `stellar contract id asset --asset native --network mainnet`
 *
 * Used by `convertUsdcToXlm` below to decide whether a Stellar channel
 * is XLM-denominated and therefore needs the FX conversion. USDC SAC
 * channels (e.g. agent2's CAYS2LBU…) bypass the conversion entirely.
 */
export const STELLAR_NATIVE_XLM_SAC = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'

/**
 * Convert a USDC-denominated decimal amount string into the equivalent
 * XLM amount string at a fixed XLM/USD rate, with rounding UP at the
 * Stellar USDC precision (7 decimals) so the router never undercharges
 * the agent on a sub-stroop fractional remainder.
 *
 * Why round UP, not nearest:
 *   The router is the broker. Every voucher is a promise that the agent
 *   will eventually pay this much XLM. If we rounded down, the agent
 *   would pay strictly less XLM than the merchant's USDC cost, and
 *   over many requests the router would slowly bleed value (the FX
 *   gap from internaldocs/v2-session-session-done.md §5.1 in
 *   miniature). Rounding up errs in the router's favor by at most one
 *   stroop (1e-7 XLM ≈ 1e-8 USD at 0.11 rate), well below the
 *   per-request precision the agent can observe. Document this
 *   prominently because reversing the rounding direction would be a
 *   silent broker loss.
 *
 * Examples (rate=0.11):
 *   convertUsdcToXlm("0.00075", 0.11) === "0.0068182"
 *     # raw: 0.00075/0.11 = 0.006818181818..., rounded up to 7dp.
 *   convertUsdcToXlm("0.000001", 0.11) === "0.0000091"
 *     # raw: 9.0909e-6, rounded up.
 *   convertUsdcToXlm("0", 0.11) === "0"
 *
 * @param usdcAmount  decimal string (e.g. "0.00075"), already normalized
 *                    by baseUnitsToDecimalString from merchant base units
 * @param rate        XLM/USD rate as a positive finite number, e.g. 0.11
 *                    means 1 XLM = $0.11
 * @returns           decimal string suitable for the Stellar charge/channel
 *                    `amount` field at 7-decimal precision
 *
 * @throws if rate <= 0, not finite, or NaN
 * @throws if usdcAmount is not a valid decimal string
 */
export function convertUsdcToXlm(usdcAmount: string, rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`convertUsdcToXlm: rate must be a positive finite number, got ${rate}`)
  }
  if (!/^-?\d+(\.\d+)?$/.test(usdcAmount)) {
    throw new Error(`convertUsdcToXlm: usdcAmount must be a decimal string, got ${usdcAmount}`)
  }
  // Use BigInt to do the math at 7-decimal precision exactly. We avoid
  // Number/parseFloat because USDC base unit is 1e-7 XLM and a naive
  // float multiply at $1+ amounts would silently lose the bottom
  // stroop. Strategy:
  //   1. parse usdcAmount into base units at 7 decimals (Stellar precision)
  //   2. compute baseUsdc / rate as a rational, scaled to 7 decimals
  //   3. round UP and emit as a decimal string via baseUnitsToDecimalString
  //
  // For step 2 we represent rate as a scaled BigInt: rate * 1e9 rounded
  // to nearest. 1e9 of headroom keeps us well under JS Number precision
  // (rate is ≤ ~10 USD/XLM in any realistic scenario) and gives
  // sub-stroop accuracy in the quotient.
  const STELLAR_DECIMALS = 7
  const RATE_SCALE = 1_000_000_000 // 1e9
  // Convert usdc decimal string to base units at STELLAR_DECIMALS.
  const negative = usdcAmount.startsWith('-')
  const unsigned = negative ? usdcAmount.slice(1) : usdcAmount
  const dotIdx = unsigned.indexOf('.')
  let intPart = dotIdx === -1 ? unsigned : unsigned.slice(0, dotIdx)
  let fracPart = dotIdx === -1 ? '' : unsigned.slice(dotIdx + 1)
  if (fracPart.length > STELLAR_DECIMALS) {
    throw new Error(
      `convertUsdcToXlm: usdcAmount has more than ${STELLAR_DECIMALS} fractional digits (${usdcAmount}); ` +
        `cannot represent losslessly at Stellar precision`,
    )
  }
  fracPart = fracPart.padEnd(STELLAR_DECIMALS, '0')
  const usdcBaseUnits = BigInt(intPart || '0') * BigInt(10 ** STELLAR_DECIMALS) + BigInt(fracPart || '0')
  if (usdcBaseUnits === 0n) return '0'
  const rateScaled = BigInt(Math.round(rate * RATE_SCALE))
  if (rateScaled <= 0n) {
    throw new Error(`convertUsdcToXlm: scaled rate underflowed to 0 (rate=${rate})`)
  }
  // xlmBaseUnits = usdcBaseUnits * RATE_SCALE / rateScaled, rounded UP
  const numerator = usdcBaseUnits * BigInt(RATE_SCALE)
  let xlmBaseUnits = numerator / rateScaled
  if (numerator % rateScaled !== 0n) {
    xlmBaseUnits += 1n // round up
  }
  const result = baseUnitsToDecimalString(xlmBaseUnits.toString(), STELLAR_DECIMALS)
  return negative ? `-${result}` : result
}

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

/**
 * Shared merchant-pay step used by both the Stellar and x402 verify
 * branches. Dispatches on the merchant's live 402 intent (`charge` vs
 * `session`), calls `payMerchant` / `payMerchantSession`, and returns
 * either a merchant body + response to be wrapped by the caller, or
 * a fully-formed error `Response` if anything fell over.
 *
 * The caller is responsible for:
 *   1. Running payment verification BEFORE calling this.
 *   2. Wrapping the returned body in whatever receipt envelope their
 *      verify path uses (mppx `verifyResult.withReceipt` for Stellar,
 *      `X-Payment-Response` for x402).
 *
 * `forwardedHeaders` must be pre-computed by the caller so we don't
 * have to reach back into the request here (keeps the helper pure).
 */
type MerchantPayResult =
  | {
      kind: 'ok'
      body: string
      contentType: string
      merchantResponse: Response
    }
  | { kind: 'error'; response: Response }

async function payMerchantAndGetBody(
  env: Env,
  ctx: ExecutionContext,
  route: ReturnType<typeof getRouteByPublicPath> & {},
  parsed: NonNullable<ReturnType<typeof parseTempoChallenge>>,
  merchantUrl: string,
  request: Request,
  requestBody: string | undefined,
): Promise<MerchantPayResult> {
  // Dispatch on the merchant's ACTUAL intent (parsed.intent from the
  // live 402), not the hardcoded route.upstreamPaymentMethod. See the
  // long comment at the original inline site for why. Logic here is
  // byte-identical to the pre-extract inline block from the Stellar
  // path — the only thing we added is a different return shape.
  const merchantIntent = parsed.intent.toLowerCase()
  if (merchantIntent !== route.upstreamPaymentMethod.replace('tempo.', '')) {
    console.log(
      `[proxy] Note: route ${route.id} hardcoded as ${route.upstreamPaymentMethod} ` +
        `but merchant returned intent=${merchantIntent}; following merchant.`,
    )
  }

  let merchantResponse: Response
  try {
    if (merchantIntent === 'session') {
      const sessionResult = await payMerchantSession(env, route.id, merchantUrl, {
        method: request.method,
        headers: forwardHeaders(request),
        body: requestBody,
      })
      merchantResponse = sessionResult.response
      if (merchantResponse.ok) {
        const newCumulativeRaw = (
          BigInt(sessionResult.channelBefore.cumulativeRaw) +
          BigInt(parsed.request.amount)
        ).toString()
        ctx.waitUntil(
          bumpCumulative(env, route.id, newCumulativeRaw).catch((err: any) => {
            console.error(
              `[proxy] post-2xx bumpCumulative failed for ${route.id}: ${err.message}`,
            )
          }),
        )
      }
    } else {
      merchantResponse = await payMerchant(env, merchantUrl, {
        method: request.method,
        headers: forwardHeaders(request),
        body: requestBody,
      })
    }
  } catch (err: any) {
    if (err instanceof ChannelNotInstalledError) {
      console.error(`[proxy] ${err.message}`)
      return {
        kind: 'error',
        response: new Response(
          JSON.stringify({
            error: 'Router session channel not installed',
            detail: err.message,
            hint: 'Operator must run scripts/open-channel.ts before this merchant accepts session traffic.',
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      }
    }
    console.error(`[proxy] Tempo payment error: ${err.message}`)
    return {
      kind: 'error',
      response: new Response(
        JSON.stringify({
          error: 'Merchant payment failed',
          detail: err.message,
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
    }
  }

  console.log(`[proxy] Merchant responded: ${merchantResponse.status}`)

  if (!merchantResponse.ok) {
    const errorBody = await merchantResponse.text()
    console.error(`[proxy] Merchant error body: ${errorBody.substring(0, 200)}`)
    return {
      kind: 'error',
      response: new Response(
        JSON.stringify({
          error: 'Merchant payment failed',
          status: merchantResponse.status,
          detail: errorBody.substring(0, 500),
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
    }
  }

  const contentType = merchantResponse.headers.get('content-type') || 'application/json'
  const body = await merchantResponse.text()
  return { kind: 'ok', body, contentType, merchantResponse }
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
  // Resolve `:placeholder` tokens in route.upstreamPath from the
  // URL query (e.g. ?model=gemini-2.0-flash for the gemini route).
  // Falls back to per-route defaults. Strips consumed params from
  // the forwarded query so the merchant doesn't see them.
  let upstreamPath: string
  let consumedQueryParams: Set<string>
  try {
    const resolved = resolveUpstreamPath(route, url.searchParams)
    upstreamPath = resolved.path
    consumedQueryParams = resolved.consumed
  } catch (err: any) {
    if (err instanceof UpstreamPathPlaceholderError) {
      return new Response(JSON.stringify({
        error: 'Bad upstream path placeholder',
        detail: err.message,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw err
  }
  // Build the forwarded query string. Strip both:
  //   - placeholder feeders consumed by resolveUpstreamPath
  //   - router-internal params (?payment=channel&agent=G...) — see §6-D2
  const forwardedSearch = (() => {
    const params = new URLSearchParams(url.search)
    for (const name of consumedQueryParams) params.delete(name)
    params.delete('payment')
    params.delete('agent')
    const s = params.toString()
    return s.length > 0 ? `?${s}` : ''
  })()
  const merchantUrl = buildMerchantUrl(merchantHost, upstreamPath, forwardedSearch)

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
  // Credential header resolution. We accept two formats:
  //
  //   1. `Authorization: Payment <base64>` — the mppx and pre-x402
  //      Stellar convention. This is what existing mppx clients
  //      send, and what the router has always understood.
  //
  //   2. `Payment-Signature: <base64>` — x402 spec v2 header. Set
  //      by @x402/core/client's `encodePaymentSignatureHeader()`.
  //      No `Payment ` prefix; the header value is just the
  //      base64-encoded JSON payload.
  //
  // When we find the x402 v2 header we synthesize a `Payment <b64>`
  // string so the rest of the pipeline (classifyAuth,
  // parseStellarX402Header, verifyStellarX402Inbound) stays on a
  // single code path. No router code below this point has to know
  // which header format the client used.
  //
  // See x402 core: node_modules/@x402/core/.../chunk-*/http/
  // x402HTTPClient.mjs → encodePaymentSignatureHeader() which
  // emits { "PAYMENT-SIGNATURE": <base64> } for V2 payloads.
  let authHeader = request.headers.get('authorization')
  if (!authHeader) {
    const x402V2Header = request.headers.get('payment-signature')
    if (x402V2Header) {
      authHeader = `Payment ${x402V2Header.trim()}`
    }
  }
  const rawAuthKind = classifyAuth(authHeader, env)

  // V2 §6-D2 query-param bootstrap: agents that want the stellar.channel
  // flow on their FIRST request (before any credential has been signed)
  // advertise their intent by passing `?payment=channel&agent=G...` in
  // the URL. We upgrade authKind from 'none' to 'stellar.channel' when
  // we see this pair, so the verify dispatch below builds a channel-
  // bound Mppx for the initial 402.
  //
  // This is strictly additive: requests without the hint stay on the
  // V1 charge path (including the working stellar.charge → tempo.session
  // bridge from commit 9dbaba1). Requests with the hint but a wrong G
  // get a clean 402 via StellarChannelNotRegisteredError. There is no
  // silent mode switch.
  const paymentHint = url.searchParams.get('payment')?.toLowerCase() ?? null
  const agentHint = url.searchParams.get('agent')
  let authKind: typeof rawAuthKind = rawAuthKind
  if (authKind === 'none' && paymentHint === 'channel' && agentHint) {
    authKind = 'stellar.channel'
  }

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

  // ---- stellar.x402 inbound dispatch branch -----------------------
  // Handles agents carrying an @x402/core-compliant PaymentPayload
  // whose payTo matches STELLAR_X402_PAY_TO and whose network is
  // our STELLAR_NETWORK. Runs parallel to the mppx verify block
  // below. See src/mpp/stellar-x402-server.ts for the full
  // architecture; this branch is deliberately short — all the
  // protocol work is delegated to the x402Facilitator singleton.
  //
  // Flow:
  //   1. Parse merchant quote (Tempo 402, base units at 6 decimals),
  //      convert to Stellar USDC 7-decimal base units (×10). The
  //      agent signs at Stellar precision, so we must compare in
  //      that space.
  //   2. prepareStellarX402Inbound: decode payload, amount policy,
  //      compute payload hash. Local-only — no RPC calls. Cheap.
  //   3. checkAndReserveNonce: KV-level replay guard. MUST run
  //      BEFORE the chain-side facilitator verify, because once a
  //      payload's auth nonce is consumed on chain a replayed
  //      simulate() fails with simulation_failed (which is the
  //      wrong error to surface — the right one is "replay
  //      detected").
  //   4. verifyStellarX402WithFacilitator: facilitator.verify runs
  //      Soroban simulate against the live network. RPC call. Only
  //      reached for fresh payloads, never for replays.
  //   5. Pay the downstream merchant via the shared
  //      payMerchantAndGetBody helper (Tempo pool, unchanged).
  //   6. ONLY on merchant 2xx: submit the agent's signed Soroban
  //      invoke on chain. If this fails we log loudly but don't
  //      hide the merchant response from the agent (they already
  //      got served).
  //   7. Return merchant body with X-Payment-* receipt headers.
  //
  // Merchant-decimals guard: Tempo USDC is 6 decimals; Stellar USDC
  // is 7 decimals. We convert between them with a fixed ×10 factor.
  // Any non-USDC-6 merchant would break this assumption — reject
  // upfront.
  if (authKind === 'stellar.x402') {
    const merchantDecimalsX = typeof parsed.request.decimals === 'number'
      ? parsed.request.decimals
      : TEMPO_DEFAULT_DECIMALS
    if (merchantDecimalsX !== 6) {
      return new Response(JSON.stringify({
        error: 'stellar.x402 branch only supports USDC-6 merchants',
        detail: `merchant decimals=${merchantDecimalsX}, expected 6`,
      }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    }
    let merchantQuoteTempoBaseUnits: bigint
    try {
      merchantQuoteTempoBaseUnits = BigInt(parsed.request.amount)
    } catch {
      return new Response(JSON.stringify({
        error: 'Merchant quote amount is not an integer base-unit string',
        raw: parsed.request.amount,
      }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    }
    // Convert Tempo 6dp → Stellar 7dp (multiply by 10). This is the
    // amount the agent should have signed at Stellar precision.
    // Example: merchant quote $0.01 = 10_000 at 6dp = 100_000 at 7dp.
    const merchantQuoteStellarBaseUnits = merchantQuoteTempoBaseUnits * 10n

    if (!authHeader) {
      // classifyAuth already guarantees this is non-null for
      // stellar.x402, but make the invariant explicit for the type
      // checker.
      return new Response(JSON.stringify({ error: 'Internal: stellar.x402 without auth header' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } })
    }
    // Phase A: local prepare (parse + amount policy + payload hash).
    // No RPC calls. Cheap. Failures here mean the payload is
    // structurally invalid or violates the overpay policy.
    const prepared = await prepareStellarX402Inbound(
      env,
      authHeader,
      merchantQuoteStellarBaseUnits,
    )
    if (!prepared.ok) {
      console.log(`[proxy] stellar.x402 prepare rejected: ${prepared.reason}`)
      return new Response(JSON.stringify({
        error: 'stellar.x402 verification failed',
        detail: prepared.reason,
      }), {
        status: prepared.statusCode,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // KV-level replay guard. MUST be checked BEFORE the chain-side
    // facilitator verify — once a payload's auth nonce is consumed
    // on chain, replaying it would fail with the chain-side
    // `simulation_failed` error which is the wrong thing to surface
    // to clients. KV reservation gives us a clean, fast,
    // deterministic "replay detected" response.
    const reserve = await checkAndReserveNonce(env, prepared.payloadHash)
    if (!reserve.ok) {
      console.log(
        `[proxy] stellar.x402 replay rejected for payloadHash=${prepared.payloadHash}`,
      )
      return new Response(JSON.stringify({
        error: 'stellar.x402 replay detected',
        detail: 'This signed payload was already submitted to this router.',
      }), { status: 402, headers: { 'Content-Type': 'application/json' } })
    }

    // Phase B: chain-side verify via facilitator. Soroban simulate
    // call. Only fresh payloads reach this step.
    const facilitatorVerify = await verifyStellarX402WithFacilitator(
      env,
      prepared.payload,
      prepared.requirements,
    )
    if (!facilitatorVerify.ok) {
      console.log(
        `[proxy] stellar.x402 facilitator verify rejected: ${facilitatorVerify.reason}`,
      )
      // Release the KV reservation — this payload didn't actually
      // commit anything (chain rejected it). The agent might want
      // to retry with a fresh signature.
      ctx.waitUntil(reserve.release())
      return new Response(JSON.stringify({
        error: 'stellar.x402 verification failed',
        detail: facilitatorVerify.reason,
      }), {
        status: facilitatorVerify.statusCode,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // `verify` is the variable name used by the rest of this branch
    // for backward-compatible logging — alias to the merged result.
    const verify = prepared

    console.log(
      `[proxy] stellar.x402 verified for route ${route.id} payloadHash=${verify.payloadHash}`,
    )

    const payResult = await payMerchantAndGetBody(
      env,
      ctx,
      route,
      parsed,
      merchantUrl,
      request,
      requestBody,
    )
    if (payResult.kind === 'error') {
      // Merchant failed — release the nonce so the agent can retry
      // with the same payload (they haven't been charged yet because
      // we haven't submitted the settle tx).
      ctx.waitUntil(reserve.release())
      return payResult.response
    }

    // Merchant 2xx — now submit the agent's signed Soroban invoke
    // on chain. Failures here are logged loudly but do NOT hide
    // merchant content from the agent: they already got served,
    // router has committed to the cost, and we don't want to
    // confuse them with a 500 after a successful upstream call.
    const settle = await settleStellarX402(env, verify.payload, verify.requirements)
    if (!settle.success) {
      console.error(
        `[proxy] stellar.x402 SETTLE FAILED after merchant 2xx for ${route.id}: ` +
          `${settle.errorReason ?? ''} ${settle.errorMessage ?? ''}`,
      )
      // Do NOT release the nonce reservation — we DID verify and we
      // DID pay the merchant, so the agent cannot safely re-use the
      // same authorization. The KV entry expires on its TTL.
    } else {
      console.log(
        `[proxy] stellar.x402 settled for ${route.id}: tx=${settle.transaction ?? 'n/a'}`,
      )
    }

    // Idempotency cache + payment log, same shape as the Stellar mppx path.
    ctx.waitUntil((async () => {
      console.log(
        `[payment] route=${route.id} method=stellar.x402 merchant=${merchantHost} upstreamPath=${upstreamPath}`,
      )
      if (requestId) {
        await env.MPP_STORE.put(`idempotency:${requestId}`, payResult.body, { expirationTtl: 86400 })
      }
    })())

    const headers: Record<string, string> = {
      'Content-Type': payResult.contentType,
    }
    if (settle.transaction) headers['X-Payment-Tx'] = settle.transaction
    headers['X-Payment-Method'] = 'stellar.x402'
    if (!settle.success) {
      headers['X-Payment-Settle-Status'] = 'failed'
      if (settle.errorReason) headers['X-Payment-Settle-Reason'] = settle.errorReason
    } else {
      headers['X-Payment-Settle-Status'] = 'settled'
    }
    return new Response(payResult.body, { status: 200, headers })
  }
  // ---- end stellar.x402 branch ------------------------------------

  // 2. Run the request through the Stellar mppx handler. This is the
  // critical verification step: without a valid, HMAC-bound credential
  // whose echoed challenge matches the same amount/currency/recipient
  // (charge) or channel (channel), mppx returns a 402 challenge here
  // and we never reach payMerchant.
  //
  // Dispatch branches on authKind:
  //   - 'stellar.charge' / 'none': use the shared-instance charge Mppx
  //     from createStellarPayment(env). This is the V1 path, unchanged.
  //   - 'stellar.channel': use a per-request Mppx from
  //     resolveStellarChannelMppx() which reads the channel metadata
  //     from KV (`stellarChannel:<contract>`) and constructs a fresh
  //     Mppx instance bound to that specific channel + its
  //     commitmentKey. See src/mpp/stellar-channel-dispatch.ts and
  //     internaldocs/v2-stellar-channel-notes.md §N2.
  let mppx: Awaited<ReturnType<typeof resolveStellarChannelMppx>>['mppx']
  let channelContractForVerify: string | undefined
  let channelCurrencyForVerify: string | undefined
  try {
    if (authKind === 'stellar.channel') {
      // Pass agentHint so the first-request bootstrap path can
      // resolve the agent's channel without a credential yet.
      // Once the agent signs a voucher on the retry, the
      // credential.source extraction will produce the same G
      // and we'll converge on the same channel.
      const resolved = await resolveStellarChannelMppx(env, authHeader, agentHint)
      mppx = resolved.mppx as any
      channelContractForVerify = resolved.channelContract
      channelCurrencyForVerify = resolved.channelCurrency
      console.log(
        `[proxy] Stellar channel dispatch for ${resolved.channelContract} (agent=${resolved.agentAccount}, currency=${resolved.channelCurrency})`,
      )
    } else {
      mppx = createStellarPayment(env) as any
    }
  } catch (err: any) {
    if (err instanceof StellarChannelNotRegisteredError) {
      // Agent is unknown to the router — either they never
      // deployed a channel, or the operator never registered
      // it. 402 with a pointer to the register script, not 500:
      // the request is well-formed and we want the operator to
      // notice quickly.
      console.error(`[proxy] ${err.message}`)
      return new Response(
        JSON.stringify({
          error: 'Router does not recognize this agent',
          detail: err.message,
          hint: 'Deploy a Stellar channel contract and run scripts/admin/register-stellar-channel.ts before first use.',
        }),
        {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }
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

  // Dispatch the actual verify on authKind. Both the charge and the
  // channel paths are HMAC-bound challenge verifications that return
  // a Method.Server output with `.status`, `.challenge`, and
  // `.withReceipt`, so downstream code can treat them uniformly.
  //
  // The shape of the arguments differs slightly:
  //   - charge:  { amount, currency, recipient, meta }
  //   - channel: { amount, channel, methodDetails }
  // The channel path doesn't take currency + recipient because those
  // are baked into the on-chain channel contract at deploy time.
  let verifyResult
  try {
    if (authKind === 'stellar.channel') {
      // Should not happen — if we got to this branch, resolve already
      // set channelContractForVerify. Defensive check for the type
      // narrowing below.
      if (!channelContractForVerify) {
        throw new Error('Internal: stellar.channel authKind without resolved contract')
      }
      // FX conversion: if the channel was opened against native XLM
      // (instead of USDC SAC), the merchant's USDC-denominated
      // amount has to be re-priced into XLM at a fixed rate before
      // the agent signs a voucher. Otherwise the router silently
      // bleeds value as a broker because 1 stroop XLM ≠ 1 base unit
      // USDC. USDC SAC channels (e.g. agent2's CAYS2LBU…) need no
      // conversion. See internaldocs/v2-todo.md#c and
      // v2-session-session-done.md §5.1 for the broker math.
      let channelAmount = stellarAmount
      if (channelCurrencyForVerify === STELLAR_NATIVE_XLM_SAC) {
        const rate = parseFloat(env.XLM_USD_RATE)
        if (!Number.isFinite(rate) || rate <= 0) {
          return new Response(JSON.stringify({
            error: 'XLM_USD_RATE misconfigured',
            detail: `Worker env XLM_USD_RATE must be a positive number, got ${env.XLM_USD_RATE}`,
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        try {
          channelAmount = convertUsdcToXlm(stellarAmount, rate)
        } catch (err: any) {
          return new Response(JSON.stringify({
            error: 'Could not convert USDC amount to XLM',
            detail: err.message,
          }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        console.log(
          `[proxy] XLM channel: converted ${stellarAmount} USDC -> ${channelAmount} XLM at rate ${rate}`,
        )
      }
      verifyResult = await (mppx as any)['stellar/channel']({
        amount: channelAmount,
        channel: channelContractForVerify,
        methodDetails: {
          reference: parsed.id,
        },
      })(mppxInput)
    } else {
      verifyResult = await (mppx as any)['stellar/charge']({
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
    }
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
    //
    // Dual-format 402 injection: when X402_ENABLED, we add a
    // standard x402 `Payment-Required` header to the same response
    // so vanilla x402 clients (which call
    // `x402HTTPClient.getPaymentRequiredResponse`) can read the
    // challenge without parsing the mppx-flavored
    // `WWW-Authenticate` format. mppx clients ignore the new
    // header and keep using `WWW-Authenticate` exactly as before.
    // The merchant amount comes from `parsed.request.amount`
    // (Tempo USDC 6dp) and gets converted to Stellar 7dp inside
    // `buildX402PaymentRequiredHeader` (×10).
    //
    // This injection only fires on the FIRST probe (no credential
    // / failed credential). Subsequent retries with a valid
    // credential never reach this code.
    let merchantQuoteTempo: bigint | null = null
    try {
      merchantQuoteTempo = BigInt(parsed.request.amount)
    } catch {
      merchantQuoteTempo = null
    }
    if (merchantQuoteTempo !== null) {
      const x402HeaderValue = buildX402PaymentRequiredHeader(
        env,
        merchantQuoteTempo,
        request.url,
      )
      if (x402HeaderValue) {
        // Clone the mppx Response so we can add headers without
        // mutating the original (which is owned by the mppx
        // verify result and may be referenced elsewhere).
        const mppxChallenge = verifyResult.challenge
        const newHeaders = new Headers(mppxChallenge.headers)
        newHeaders.set('Payment-Required', x402HeaderValue)
        return new Response(mppxChallenge.body, {
          status: mppxChallenge.status,
          statusText: mppxChallenge.statusText,
          headers: newHeaders,
        })
      }
    }
    return verifyResult.challenge
  }

  console.log(`[proxy] Stellar payment verified for route ${route.id}`)

  // 4. Pay the merchant from the Tempo pool.
  //
  // Dispatch on the merchant's ACTUAL intent (parsed.intent from
  // the live 402), not the hardcoded route.upstreamPaymentMethod.
  // This lets the router auto-adapt when:
  //   - A merchant flips between charge and session over time
  //   - mpp.dev catalog claims session intent but the merchant
  //     actually serves charge (modal, alchemy, storage as of
  //     2026-04-11 fall in this bucket)
  //   - Same merchant has different intents on different routes
  //
  // The hardcoded `route.upstreamPaymentMethod` becomes a HINT for
  // operators (do we expect to need a session channel here?) but
  // is no longer the dispatch criterion. v2-todo.md#A-followup.
  //
  // Fixed-price merchants (Firecrawl, Exa, Parallel) emit `charge`,
  // dynamic merchants (OpenRouter, OpenAI) emit `session`. The
  // mppx client handles the full 402 dance in both cases; the
  // difference is that the session path needs to read + write
  // channel state in KV and enforce the commit-after-2xx ordering
  // from §5 of internaldocs/session-support-plan.md.
  //
  // IMPORTANT: a session intent without an opened KV channel raises
  // `ChannelNotInstalledError`. We surface that as a 503 with a
  // clear message so the operator notices and runs
  // `scripts/admin/open-tempo-channel.ts` before agent traffic
  // builds up.
  const payResult = await payMerchantAndGetBody(
    env,
    ctx,
    route,
    parsed,
    merchantUrl,
    request,
    requestBody,
  )
  if (payResult.kind === 'error') return payResult.response
  const { body, contentType } = payResult

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
