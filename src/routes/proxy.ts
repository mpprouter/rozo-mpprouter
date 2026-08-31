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

import { Credential, Receipt } from 'mppx'
import { Store } from 'mppx/server'
import {
  getAllowedMethodsForPath,
  getRouteByPublicPath,
  resolveUpstreamPath,
  UpstreamPathPlaceholderError,
} from '../services/merchants'
import { normalizePayInvoiceBody } from './pay-invoice-admin'
import { recordRouteFailure, recordRouteSuccess } from '../services/route-health'
import { classifyOutcome, recordRouteCall } from '../services/route-metrics'
import {
  ChannelNotInstalledError,
  payMerchant,
  payMerchantSession,
} from '../mpp/tempo-client'
import { bumpCumulative } from '../mpp/channel-store'
import { buildIdempotencyKey } from '../mpp/idempotency'
import { doAtomicParams } from '../mpp/kv-atomic-store'
import {
  createStellarPayment,
  getRouterStellarAddress,
  getStellarUsdcSac,
} from '../mpp/stellar-server'
import { enqueueRefund, payerAccount, type PaymentProof, type RefundReason } from '../refund/refund'
import {
  resolveStellarChannelMppx,
  rollbackFailedChannelVoucher,
  acquireChannelDeliveryLock,
  releaseChannelDeliveryLock,
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
import { sendDingTalkAlert } from '../utils/dingtalk'
import { getTempoUsdcBalance, LOW_BALANCE_THRESHOLD } from '../utils/tempo-balance'
import { extractStellarAddress, type JobAuthRecord } from './job-status'
import { checkAndBumpDailyLimit, peekDailyLimit, secondsUntilUtcMidnight, utcDateKey } from '../mpp/rate-limit-do'
import { newOrderId, recordOrder, updateOrderRefundStatus, type RefundStatus } from '../services/order-ledger'
import type { Env } from '../index'
import { redactForAlert } from '../utils/alert-redaction'

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
 * Convert a `route.fixedPricing.amountUsd` decimal string (e.g. "0.0005")
 * into a base-unit integer string at 6 decimals — the same convention
 * `parsed.request.amount` uses everywhere else in this file (Tempo USDC-6).
 * Building a fake `parsed` challenge in this shape lets fixed-price routes
 * flow through the SAME downstream verify/settle code every other route
 * uses (see the `isRozoPayInvoiceRoute` synthesized-challenge precedent a
 * few hundred lines below).
 */
export function fixedPriceToBaseUnits6(amountUsd: string): string {
  if (!/^\d+(\.\d+)?$/.test(amountUsd)) {
    throw new Error(`fixedPriceToBaseUnits6: not a decimal string: ${amountUsd}`)
  }
  const [whole, fracRaw = ''] = amountUsd.split('.')
  if (fracRaw.length > 6) {
    throw new Error(`fixedPriceToBaseUnits6: more than 6 fractional digits: ${amountUsd}`)
  }
  const frac = fracRaw.padEnd(6, '0')
  const base = BigInt(whole || '0') * 1_000_000n + BigInt(frac || '0')
  return base.toString()
}

/**
 * Router-held upstream credential injection (Mercury MVP). Sets
 * `route.upstreamAuth.header` from `env[secretBinding]` on top of the
 * normal forwarded headers. Never logs the credential. No-ops (leaves the
 * header unset) if the secret isn't configured in this environment — the
 * upstream call then fails on its own terms (401/403), which is the same
 * fail-open-on-agent-payment shape every other pay-then-fail merchant in
 * this file already has, not a new risk class.
 */
/**
 * Build the `detail` field for a non-2xx upstream error response.
 *
 * SECURITY (P1, codex review 2026-08-12): `hasUpstreamAuth` routes carry a
 * router-held credential (e.g. `MERCURYDATA_MAINNET_JWT`) injected into
 * the OUTBOUND request headers. Reflecting the upstream's raw error body
 * verbatim back to the caller risks leaking that credential (or other
 * upstream internals) if the upstream ever echoes request headers/state
 * in its error output. Routes without `upstreamAuth` never carry a
 * router-held secret on the request, so they keep the original verbatim
 * (truncated) passthrough — byte-identical to the pre-fix behavior.
 */
export function sanitizeUpstreamErrorDetail(hasUpstreamAuth: boolean, body: string): string {
  return hasUpstreamAuth
    ? 'Upstream returned an error. Detail withheld for router-held-credential routes.'
    : body.substring(0, 500)
}

export function injectUpstreamAuth(
  headers: HeadersInit,
  route: { upstreamAuth?: { secretBinding: string; header: string; scheme?: 'bearer' | 'raw' } },
  env: Env,
): Headers {
  const h = new Headers(headers)
  if (!route.upstreamAuth) return h
  const token = (env as unknown as Record<string, string | undefined>)[route.upstreamAuth.secretBinding]
  if (!token) return h
  const scheme = route.upstreamAuth.scheme ?? 'bearer'
  h.set(route.upstreamAuth.header, scheme === 'bearer' ? `Bearer ${token}` : token)
  return h
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
export function forwardHeaders(
  request: Request,
  opts: { keepAuthorization?: boolean } = {},
): HeadersInit {
  const headers: Record<string, string> = {}
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase()
    if (lower === 'host') continue
    if (lower === 'authorization' && !opts.keepAuthorization) continue
    // The agent's Accept-Payment describes what THE AGENT can pay us with
    // (e.g. stellar/charge). Forwarding it to the merchant makes mppx adopt
    // it as the ROUTER's own preference, which filters out every Tempo
    // challenge the merchant offers and leaves zero candidates ("No method
    // found for challenges"). The router pays merchants on its own terms.
    if (lower === 'accept-payment') continue
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

function isRozoPayInvoiceRoute(route: {
  service?: string
  operation?: string
  upstreamHost?: string
  upstreamPath?: string
}): boolean {
  return (
    route.service === 'rozo-agent-api' &&
    route.operation === 'pay-invoice' &&
    route.upstreamHost === 'agentapi.rozo.ai' &&
    route.upstreamPath === '/pay-invoice'
  )
}

function parseX402AmountFromBody(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as {
      accepts?: Array<{ maxAmountRequired?: string }>
    }
    const amount = parsed.accepts?.[0]?.maxAmountRequired
    if (!amount || !/^\d+$/.test(amount)) return null
    return amount
  } catch {
    return null
  }
}

async function quoteInvoiceAmountBaseUnits(
  env: Env,
  requestBody: string | undefined,
): Promise<string | null> {
  if (!requestBody || !env.PAYINVOICE_ADMIN_SECRET) return null
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(requestBody)
  } catch {
    return null
  }
  // Use shared alias normalizer so all field variants (payment_link, id, etc.) resolve
  const { normalized } = normalizePayInvoiceBody(parsedBody)
  if (!normalized) return null
  try {
    const resp = await fetch('https://agentapi.rozo.ai/quote-invoice', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET,
      },
      body: JSON.stringify(normalized),
    })
    if (!resp.ok) return null
    const quote = await resp.json() as {
      quote?: { callerPaysAtomicUsdc?: string }
    }
    const atomic = quote.quote?.callerPaysAtomicUsdc
    if (!atomic || !/^\d+$/.test(atomic)) return null
    return atomic
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
      /** HTTP status from merchant — 200 for sync, 202 for async jobs */
      merchantStatus: number
      /** Wall-clock ms for the actual upstream call. Order-ledger use only. */
      latencyMs?: number
    }
  | {
      kind: 'error'
      response: Response
      refundReason?: RefundReason
      /**
       * HTTP status the merchant actually returned, when it returned one at
       * all. Absent for transport failures/throws, where no upstream status
       * exists. Kept separate from `response.status` (always the router's own
       * 502/503) so the order ledger records what the upstream said, not what
       * we told the caller.
       */
      merchantStatus?: number
      /** Wall-clock ms for the upstream call. Order-ledger use only. */
      latencyMs?: number
      /**
       * True when the failure is OURS (or the agent's setup), not the
       * provider's — a session channel that was never installed, say. It
       * cannot be inferred from `refundReason`, which reuses `upstream_5xx`
       * for this case and is therefore indistinguishable from a real
       * provider 5xx. Without this flag the provider is penalised in its
       * published success rate for a fault it had no part in.
       */
      routerSideFailure?: boolean
    }

/**
 * Errors we raise ourselves before the upstream is reached. Matched by
 * `name` rather than `instanceof` so the set stays a plain data list and
 * does not drag channel/session modules into this file's import graph.
 *
 * These must not count against a provider's published success rate: nothing
 * about them says the provider failed to serve.
 */
const ROUTER_SIDE_ERROR_NAMES = new Set([
  // src/mpp/tempo-client.ts — merchant has no payment channel installed.
  'ChannelNotInstalledError',
  // src/mpp/tempo-client.ts — our own configured budget ceiling rejected it.
  'BudgetExceededError',
])

/**
 * Thin wrapper that feeds the catalog's live health signal.
 *
 * Wrapped rather than inlined at each `return` because this function has
 * ten-plus exit points across three payment branches, and a health signal
 * that silently misses a branch is worse than none — it would report "ok"
 * for a route that is failing every call, which is precisely the failure
 * mode `live_status` exists to end. See services/route-health.ts.
 *
 * Only `refundReason` is recorded, never the upstream error body: this
 * string is published in the catalog, and merchant error bodies quote URLs,
 * request payloads and occasionally credentials.
 */
async function payMerchantAndGetBody(
  env: Env,
  ctx: ExecutionContext,
  route: ReturnType<typeof getRouteByPublicPath> & {},
  parsed: NonNullable<ReturnType<typeof parseTempoChallenge>>,
  merchantUrl: string,
  request: Request,
  requestBody: string | undefined,
): Promise<MerchantPayResult> {
  // Timed HERE rather than in the inner function so every payment branch is
  // covered. The inner timer at the router-held-credential branch is the only
  // one that ever set `latencyMs`; the pay-invoice and Tempo branches returned
  // none, and consumers papered over it with `?? 0`. That is how the order
  // ledger came to report a p50 of 0ms across 47 calls. This outer measurement
  // includes our own settlement overhead, so it is the number a buyer actually
  // waits for, and `result.latencyMs` (upstream leg only) still wins when the
  // inner branch measured it.
  const startedAt = Date.now()

  let result: MerchantPayResult
  try {
    result = await payMerchantAndGetBodyInner(
      env, ctx, route, parsed, merchantUrl, request, requestBody,
    )
  } catch (err) {
    // A throw is a failure too. The caller catches this and turns it into a
    // 502 'Merchant delivery failed', so without recording it here a route
    // could fail every call through that path while still advertising
    // live_status "ok" — the exact blind spot this field exists to close.
    recordRouteFailure(env, ctx, route.id, 'timeout')
    // A throw carries no upstream status, and classifyOutcome therefore
    // blames the provider leg — correct for a timeout or a dropped
    // connection, wrong for the setup errors we raise ourselves before the
    // provider is ever reached. A session channel that was never installed
    // is our (or the agent's) missing configuration; booking it as a
    // provider outage would deflate a provider's published success rate for
    // something it had no part in. Latency is deliberately omitted: a call
    // that threw has no delivery time worth publishing.
    const routerSideFailure = ROUTER_SIDE_ERROR_NAMES.has((err as Error)?.name)
    recordRouteCall(env, ctx, {
      routeId: route.id,
      method: request.method,
      outcome: classifyOutcome(undefined, { routerSideFailure }),
      reason: routerSideFailure ? (err as Error).name : 'timeout',
    })
    throw err
  }

  const elapsedMs = Date.now() - startedAt

  if (result.kind === 'error') {
    recordRouteFailure(env, ctx, route.id, result.refundReason ?? 'upstream_error')
  } else {
    recordRouteSuccess(env, ctx, route.id)
  }

  recordRouteCall(env, ctx, {
    routeId: route.id,
    method: request.method,
    // A 401/403 on a route where WE hold the upstream credential is our
    // misconfiguration, not the caller sending a bad request — publishing it
    // as a provider outage (or as the caller's fault) would both be wrong.
    //
    // `deliveryFailed` matters independently of the status: an upstream that
    // answers 200 with an empty body produces kind:'error' with
    // merchantStatus 200, and the payer is refunded. Classifying on status
    // alone would raise that provider's success rate for a call we had to
    // give the money back on.
    outcome: classifyOutcome(result.merchantStatus, {
      routerHoldsCredential: Boolean(route.upstreamAuth),
      routerSideFailure: result.kind === 'error' && result.routerSideFailure === true,
      deliveryFailed: result.kind === 'error',
    }),
    reason: result.kind === 'error' ? (result.refundReason ?? 'upstream_error') : undefined,
    upstreamStatus: result.merchantStatus,
    latencyMs: result.latencyMs ?? elapsedMs,
  })

  return result
}

async function payMerchantAndGetBodyInner(
  env: Env,
  ctx: ExecutionContext,
  route: ReturnType<typeof getRouteByPublicPath> & {},
  parsed: NonNullable<ReturnType<typeof parseTempoChallenge>>,
  merchantUrl: string,
  request: Request,
  requestBody: string | undefined,
): Promise<MerchantPayResult> {
  // Router-held-credential bridge (Mercury MVP, 2026-08-12): the agent
  // still pays Router via Stellar/x402 as normal, but instead of paying a
  // Tempo merchant, Router calls the upstream DIRECTLY with its own held
  // credential injected. Generalizes the `isRozoPayInvoiceRoute` bridge
  // below (same shape: skip Tempo, one direct upstream fetch) so future
  // router-held-credential providers don't need a third hand-wired branch.
  if (route.upstreamAuth) {
    const headers = injectUpstreamAuth(forwardHeaders(request), route, env)
    const startedAt = Date.now()
    let merchantResponse: Response
    try {
      merchantResponse = await fetch(merchantUrl, {
        method: request.method,
        headers,
        body: requestBody,
      })
    } catch (err: any) {
      return {
        kind: 'error',
        refundReason: 'timeout',
        response: new Response(
          JSON.stringify({ error: 'Upstream call failed', detail: err.message }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        ),
      }
    }
    const latencyMs = Date.now() - startedAt
    const contentType = merchantResponse.headers.get('content-type') || 'application/json'
    const body = await merchantResponse.text()
    if (!merchantResponse.ok) {
      // SECURITY (P1, codex review 2026-08-12): this branch only runs for
      // upstreamAuth routes — the request carries a router-held credential
      // (e.g. MERCURYDATA_MAINNET_JWT) in a header. Reflecting the upstream
      // body verbatim risks leaking that credential (or other upstream
      // internals) back to the caller if the upstream ever echoes request
      // headers in an error body. Non-upstreamAuth routes are unaffected —
      // they never reach this branch.
      return {
        kind: 'error',
        refundReason: merchantResponse.status >= 500 ? 'upstream_5xx' : 'non_fulfillment',
        merchantStatus: merchantResponse.status,
        latencyMs,
        response: new Response(
          JSON.stringify({
            error: 'Upstream request failed',
            status: merchantResponse.status,
            detail: sanitizeUpstreamErrorDetail(true, body),
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        ),
      }
    }
    return { kind: 'ok', body, contentType, merchantResponse, merchantStatus: merchantResponse.status, latencyMs }
  }

  // Special bridge: user still pays Router via Stellar/x402 API path,
  // but Router settles this merchant via admin-secret upstream call.
  if (isRozoPayInvoiceRoute(route) && env.PAYINVOICE_ADMIN_SECRET) {
    let merchantResponse: Response
    try {
      const headers = new Headers(forwardHeaders(request))
      headers.set('x-admin-secret', env.PAYINVOICE_ADMIN_SECRET)
      if (!headers.get('content-type')) headers.set('content-type', 'application/json')
      merchantResponse = await fetch(merchantUrl, {
        method: request.method,
        headers,
        body: requestBody,
      })
    } catch (err: any) {
      return {
        kind: 'error',
        refundReason: 'timeout',
        response: new Response(
          JSON.stringify({
            error: 'Merchant admin payment failed',
            detail: err.message,
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        ),
      }
    }

    const contentType = merchantResponse.headers.get('content-type') || 'application/json'
    const body = await merchantResponse.text()
    if (!merchantResponse.ok && merchantResponse.status !== 202) {
      return {
        kind: 'error',
        refundReason: merchantResponse.status >= 500 ? 'upstream_5xx' : 'non_fulfillment',
        merchantStatus: merchantResponse.status,
        response: new Response(
          JSON.stringify({
            error: 'Merchant admin payment failed',
            status: merchantResponse.status,
            detail: body.substring(0, 500),
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        ),
      }
    }
    return { kind: 'ok', body, contentType, merchantResponse, merchantStatus: merchantResponse.status }
  }

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
        refundReason: 'upstream_5xx',
        routerSideFailure: true,
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
      refundReason: 'timeout',
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

  // Accept 2xx responses (including 202 for async jobs)
  if (!merchantResponse.ok && merchantResponse.status !== 202) {
    const errorBody = await merchantResponse.text()
    console.error(`[proxy] Merchant error body: ${errorBody.substring(0, 200)}`)
    return {
      kind: 'error',
      refundReason: merchantResponse.status >= 500 ? 'upstream_5xx' : 'non_fulfillment',
      merchantStatus: merchantResponse.status,
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
  if (merchantResponse.status !== 202 && body.trim().length === 0) {
    return {
      kind: 'error',
      refundReason: 'empty_response',
      merchantStatus: merchantResponse.status,
      response: new Response(JSON.stringify({ error: 'Merchant returned an empty response' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    }
  }
  return { kind: 'ok', body, contentType, merchantResponse, merchantStatus: merchantResponse.status }
}

/**
 * If the merchant returned an async job (either HTTP 202, or HTTP 200
 * with a pending-status body containing a job id), extract the job ID,
 * store a jobAuth record in KV so the agent can poll later, and build
 * a response with an X-Job-Poll-Url header.
 *
 * Why 200+jobId is also async: some merchants (StableStudio
 * Nano-Banana-Pro, etc.) accept the payment, enqueue the work, and
 * return 200 with `{ jobId, status: "queued" | "pending" | ... }`
 * instead of the canonical 202. Treating those as sync leaves no
 * `jobAuth:<id>` record and the agent gets 404 when they poll.
 *
 * Returns null if the response does not look like an async job.
 */
/**
 * Does a merchant response represent work that is still in flight?
 *
 * A 202 always does. A 200 only does when the merchant SAYS the work is
 * pending — some merchants (StableStudio Nano-Banana-Pro, etc.) accept the
 * payment and return 200 with `{ jobId, status: "queued" }` instead of the
 * canonical 202.
 *
 * A 200 carrying an id but NO status is a delivered sync response, not a job.
 * Anthropic's OpenAI-compatible completion is exactly that shape —
 * `{"id":"msg_...","object":"chat.completion",...}` — and treating it as async
 * threw the answer away, minted a job bound to a path the merchant does not
 * serve, and handed the payer a poll URL that 404s forever. The payment also
 * counted as dispatched, so no refund fired and the payer got nothing.
 * (Observed 2026-08-21 on anthropic_chat_completions: 0.0021760 USDC settled
 * and never returned.)
 */
export function isAsyncJobResponse(
  merchantStatus: number,
  body: string,
): { isAsync: boolean; jobId?: string } {
  let jobId: string | undefined
  let bodyStatus: string | undefined
  try {
    const parsed = JSON.parse(body)
    jobId = parsed.jobId ?? parsed.job_id ?? parsed.id
    bodyStatus = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : undefined
  } catch {
    // Not JSON — cannot be an async job
  }

  if (merchantStatus === 202) return { isAsync: true, jobId }
  const pending = bodyStatus !== undefined && PENDING_JOB_STATUSES.has(bodyStatus)
  return { isAsync: merchantStatus === 200 && !!jobId && pending, jobId }
}

const PENDING_JOB_STATUSES = new Set([
  'queued', 'pending', 'running', 'processing', 'in_progress', 'in-progress',
])

async function handleAsyncJob(
  env: Env,
  payResult: MerchantPayResult & { kind: 'ok' },
  route: ReturnType<typeof getRouteByPublicPath> & {},
  authHeader: string | null,
  requestUrl: URL,
  paymentProof?: PaymentProof,
  channelDelivery?: JobAuthRecord['channelDelivery'],
): Promise<Response | null> {
  const { isAsync, jobId } = isAsyncJobResponse(payResult.merchantStatus, payResult.body)

  if (!isAsync) return null

  if (!jobId) {
    if (channelDelivery?.action === 'voucher') {
      const rolledBack = await rollbackFailedChannelVoucher(
        env, channelDelivery.channelContract, channelDelivery.acceptedAmount,
        channelDelivery.previousAmount, channelDelivery.challengeId,
      )
      if (rolledBack) {
        await releaseChannelDeliveryLock(env, channelDelivery.channelContract, channelDelivery.lockId)
      } else {
        return new Response(JSON.stringify({ error: 'Async voucher requires manual review' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Refund-Status': 'manual-review' },
        })
      }
    }
    if (paymentProof) {
      let refund
      try {
        refund = await enqueueRefund(env, {
          proof: paymentProof,
          reason: 'empty_response',
          merchant: route.upstreamHost,
          routeId: route.id,
        })
      } catch (error: any) {
        return new Response(JSON.stringify({
          error: 'Async delivery and refund persistence failed', detail: error.message,
        }), { status: 503, headers: { 'Content-Type': 'application/json', 'Refund-Status': 'manual-review' } })
      }
      if (channelDelivery?.action === 'close') {
        await releaseChannelDeliveryLock(env, channelDelivery.channelContract, channelDelivery.lockId)
      }
      return new Response(JSON.stringify({ error: 'Async merchant returned no job id' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Refund-Id': refund.publicId, 'Refund-Status': 'pending' },
      })
    }
    // Merchant returned 202 with no identifiable job id — pass through as-is.
    return new Response(payResult.body, {
      status: 202,
      headers: { 'Content-Type': payResult.contentType },
    })
  }

  // Extract agent Stellar address for ownership binding. If we can't
  // pin the job to a G address, we also cannot verify ownership on
  // poll — so refuse to create an unbound record rather than store
  // 'unknown' (which would be unclaimable forever).
  const stellarAddress = extractStellarAddress(authHeader)
  if (!stellarAddress) {
    console.error(
      `[proxy] Async job from ${route.id} without a Stellar credential — cannot bind ownership, rejecting.`,
    )
    return new Response(
      JSON.stringify({
        error: 'Async jobs require a Stellar payment credential to bind ownership',
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // Resolve the upstream host from the route table.
  // Use the already-resolved route rather than re-looking it up by
  // pathname. The old lookup hardcoded method 'POST' — correct while
  // the route table held nothing else, but since GET routes exist
  // (2026-07-31) it would miss and fall back to the `<service>.dev`
  // host guess, binding the job record to the wrong upstream. The
  // caller resolved this exact route already, so just read it.
  const actualHost = route.upstreamHost || `${route.id.split('_')[0]}.dev`

  const record: JobAuthRecord = {
    stellarAddress,
    serviceId: route.id,
    upstreamHost: actualHost,
    upstreamJobPath: `/api/jobs/${jobId}`,
    paidAt: new Date().toISOString(),
    paymentProof,
    channelDelivery,
  }

  // Store with 24h TTL
  try {
    await env.MPP_STORE.put(`jobAuth:${jobId}`, JSON.stringify(record), {
      expirationTtl: 86400,
    })
  } catch (error: any) {
    if (channelDelivery?.action === 'voucher') {
      const rolledBack = await rollbackFailedChannelVoucher(
        env, channelDelivery.channelContract, channelDelivery.acceptedAmount,
        channelDelivery.previousAmount, channelDelivery.challengeId,
      )
      if (rolledBack) {
        await releaseChannelDeliveryLock(env, channelDelivery.channelContract, channelDelivery.lockId)
      }
      return new Response(JSON.stringify({ error: 'Could not persist async delivery ownership' }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Refund-Status': rolledBack ? 'voucher-not-consumed' : 'manual-review',
        },
      })
    }
    if (paymentProof) {
      try {
        const refund = await enqueueRefund(env, {
          proof: paymentProof, reason: 'empty_response',
          merchant: route.upstreamHost, routeId: route.id,
        })
        if (channelDelivery) {
          await releaseChannelDeliveryLock(env, channelDelivery.channelContract, channelDelivery.lockId)
        }
        return new Response(JSON.stringify({ error: 'Could not persist async delivery ownership' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Refund-Id': refund.publicId, 'Refund-Status': 'pending' },
        })
      } catch {
        // Keep a channel lock held when neither delivery nor refund intent was
        // durably recorded. An operator must reconcile before unlocking.
      }
    }
    return new Response(JSON.stringify({
      error: 'Could not persist async delivery ownership', detail: error.message,
    }), { status: 503, headers: { 'Content-Type': 'application/json', 'Refund-Status': 'manual-review' } })
  }

  console.log(`[proxy] Async job ${jobId} stored for agent ${stellarAddress} (route=${route.id})`)

  // Build the poll URL relative to the router
  const service = requestUrl.pathname.split('/')[3] // /v1/services/<service>/<op>
  const pollPath = `/v1/services/${service}/jobs/${jobId}`
  const pollUrl = `${requestUrl.origin}${pollPath}`

  const headers: Record<string, string> = {
    'Content-Type': payResult.contentType,
    'X-Job-Poll-Url': pollUrl,
    'X-Job-Id': jobId,
  }

  return new Response(payResult.body, { status: 202, headers })
}

export async function handleProxy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url)

  const route = resolveRoute(url, request.method)
  if (!route) {
    const allowedMethods = getAllowedMethodsForPath(url.pathname)
    if (allowedMethods.length > 0) {
      return new Response(JSON.stringify({
        error: 'Method not allowed for this service route',
        path: url.pathname,
        method: request.method,
        allowed_methods: allowedMethods,
        hint: `Retry with ${allowedMethods.join(' or ')}. The catalog 'method' field is authoritative — see GET /v1/services/catalog.`,
      }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Allow': allowedMethods.join(', '),
        },
      })
    }
    return new Response(JSON.stringify({
      error: 'Unknown public service route',
      hint: 'Use GET /v1/services/catalog for the list of supported public routes',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // SECURITY GATE (Option A, 2026-06-23): block ONLY routes we have
  // real-money tested and confirmed BROKEN (verifiedMode === false).
  // Everything else is payable — including routes we haven't verified yet
  // (verifiedMode === undefined) — so the ~485 unverified-but-working
  // routes customers rely on aren't blocked.
  //
  // Settlement-ordering caveat (do NOT misread this): the two pay paths
  // differ. The x402 branch is verify → pay merchant → settle customer
  // ONLY on merchant 2xx (proxy.ts ~1128/1158/1179), so a broken x402
  // route can't charge the customer. The legacy mppx `stellar/charge`
  // branch is the OPPOSITE: `stellar/charge` verifies-and-settles the
  // customer BEFORE `payMerchantAndGetBody` runs, so a broken charge
  // route CAN charge the customer and then 502. We accept that risk for
  // unverified routes and manage it with honest catalog flags
  // (charge_rozo_verified/session_rozo_verified) rather than gating every
  // unverified route — the client sees what we've vetted and decides. See
  // docs/codex-review-catalog-v2-2026-06-23.md.
  //
  // We still gate here (not just in the catalog) because catalog hiding
  // doesn't stop an attacker — or a stale snapshot — from POSTing a
  // known-broken path directly. Blocking confirmed-broken routes avoids
  // customers repeatedly paying into dead merchants.
  //
  // The refusal is intentionally generic — no merchant host, channel id,
  // or internal reason — so it doesn't help an attacker probe the fleet.
  // Launch gate escape hatch (P1 fix, codex review 2026-08-12): a route
  // can name a `launchGate` Env var (currently only the 4 Mercury
  // routes → 'MERCURY_LAUNCH_MODE'). When that var is literally
  // 'verify', we let the route through despite verifiedMode === false —
  // this is how a brand-new router-held-credential route gets its FIRST
  // real paid call (verifiedMode can only ever flip away from false
  // AFTER that call succeeds, so without this the route could never be
  // verified). Any other value (including unset) → still 403 below, so
  // the route stays closed to the public until the operator explicitly
  // flips the var for their own test call.
  const launchGateOpen = !!(route.launchGate && env[route.launchGate as keyof Env] === 'verify')
  if (route.verifiedMode === false && !launchGateOpen) {
    return new Response(JSON.stringify({
      error: 'Route not enabled for payment',
      hint: 'See GET /v1/services/catalog for the set of routes that accept payment.',
    }), {
      status: 403,
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

  // Idempotency id. NOTE: the cache is deliberately NOT consulted here.
  // This point in the request is pre-auth and pre-charge, so a lookup
  // keyed on a client-supplied header would hand out paid merchant
  // responses to anyone who replays an id (and, since the old key was not
  // bound to the payer, potentially another account's response). The
  // lookup now happens after the credential is verified and the payer
  // charged, keyed via buildIdempotencyKey(). See src/mpp/idempotency.ts.
  const requestId = request.headers.get('x-request-id')

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

  // ---- Rate cap peek (Mercury MVP, before ANY payment step) ---------
  // Enforced before the agent is ever offered a 402, let alone charged.
  // Protects a router-held upstream credential (Mercury's scoped JWT)
  // from being exhausted by router-side traffic — independent of
  // whatever cap the upstream itself enforces on the token. DO CAS
  // fixed-window counter, copied from coupon.ts:273-313's bumpCounter
  // pattern (see src/mpp/rate-limit-do.ts).
  //
  // P1 fix (codex review 2026-08-12): this is a PEEK ONLY — it does not
  // consume a slot. The unpaid/handshake leg (no credential yet, or the
  // agent's first 402 round-trip) must not burn allowance meant for real
  // paid calls, or 1,000/day cap becomes ~500 real calls and
  // unauthenticated spam can exhaust the whole allowance without ever
  // reaching upstream. The real consuming check
  // (`checkAndBumpDailyLimit`) runs later, immediately before the paid
  // execution path — only for requests that actually carry a verified
  // payment credential and are about to call upstream — still strictly
  // before any money is taken, so an over-cap request is never charged.
  // This peek exists purely to fail fast (no probe/verify work wasted)
  // when the cap is already exhausted.
  const rlKey = route.rateLimit ? `ratelimit:${route.service}:${utcDateKey()}` : null
  if (rlKey && route.rateLimit) {
    const rl = await peekDailyLimit(env, rlKey, route.rateLimit.perDay)
    if (!rl.ok) {
      const retryAfter = secondsUntilUtcMidnight()
      return new Response(JSON.stringify({
        error: 'Daily rate limit exceeded for this service',
        detail: `${rl.used}/${rl.limit} calls used today (UTC). Resets at next UTC midnight.`,
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
      })
    }
  }

  /**
   * Consume one rate-limit slot. Called ONLY right before a paid
   * upstream call is actually about to happen (credential verified),
   * never on the unpaid/handshake leg. Returns a 429 Response to short-
   * circuit the caller if the cap was hit in the race between the peek
   * above and now (still before any money is taken).
   */
  const routeRateLimit = route.rateLimit
  async function consumeRateLimitSlotOrReject(): Promise<Response | null> {
    if (!rlKey || !routeRateLimit) return null
    const rl = await checkAndBumpDailyLimit(env, rlKey, routeRateLimit.perDay)
    if (!rl.ok) {
      const retryAfter = secondsUntilUtcMidnight()
      return new Response(JSON.stringify({
        error: 'Daily rate limit exceeded for this service',
        detail: `${rl.used}/${rl.limit} calls used today (UTC). Resets at next UTC midnight.`,
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
      })
    }
    return null
  }

  // 1. Probe the merchant to learn the live quote. If the merchant
  // serves content for free, pass that through directly.
  //
  // Fixed-price routes (Mercury MVP) skip the probe entirely: there is
  // no merchant-side Tempo 402 to read (the router holds the credential
  // and sets its own price), and an unpaid probe against Mercury without
  // our injected token would just 401 — which is not "free", it's
  // "unauthenticated", and would be misread as a passthrough below.
  let wwwAuth: string | null = null
  let parsed: ReturnType<typeof parseTempoChallenge> = null
  if (route.fixedPricing) {
    parsed = {
      id: `mercury-fixed-${Date.now()}`,
      realm: merchantHost,
      intent: 'charge',
      request: {
        amount: fixedPriceToBaseUnits6(route.fixedPricing.amountUsd),
        currency: 'usd',
        decimals: 6,
        recipient: route.id,
      },
    }
  } else {
  const probeResponse = await fetch(merchantUrl, {
    method: request.method,
    headers: forwardHeaders(request),
    body: requestBody,
  })

  if (probeResponse.status !== 402) {
    // Merchant doesn't require payment for this route — passthrough.
    return probeResponse
  }

  wwwAuth = probeResponse.headers.get('www-authenticate')
  if (wwwAuth) {
    parsed = parseTempoChallenge(wwwAuth)
  } else if (isRozoPayInvoiceRoute(route)) {
    // rozo-agent-api emits x402 JSON 402 (no WWW-Authenticate).
    const rawBody = await probeResponse.text()
    const x402Amount = parseX402AmountFromBody(rawBody)

    // Amount gate for admin-bridge route: only trust quote-invoice.
    const gatedAmount = await quoteInvoiceAmountBaseUnits(env, requestBody)
    if (!gatedAmount) {
      // Parse normalized input for error context
      let normalizedInput: Record<string, string> | undefined
      if (requestBody) {
        try {
          const { normalized } = normalizePayInvoiceBody(JSON.parse(requestBody))
          if (normalized) normalizedInput = normalized as unknown as Record<string, string>
        } catch { /* ignore */ }
      }
      return new Response(JSON.stringify({
        code: 'QUOTE_UNAVAILABLE',
        error: 'Cannot derive exact invoice amount for pay-invoice route',
        message: 'Router refuses fallback quote to avoid undercharging. quote-invoice must return callerPaysAtomicUsdc.',
        hint: 'The upstream quote-invoice endpoint did not return a valid callerPaysAtomicUsdc. This may be a temporary upstream error — retry, or check that the payment link is valid and not expired.',
        normalized_input: normalizedInput,
        route_capabilities: [
          'POST /v1/services/rozo-agent-api/pay-invoice — pay invoice (requires active link)',
          'POST /v1/services/rozo-agent-api/quote-invoice — get quote before paying',
        ],
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const finalAmount = (() => {
      if (!x402Amount) return gatedAmount
      try {
        // Safe-side max gate: never charge less than either source.
        return BigInt(gatedAmount) > BigInt(x402Amount) ? gatedAmount : x402Amount
      } catch {
        return gatedAmount
      }
    })()

    parsed = {
      id: `x402-${Date.now()}`,
      realm: merchantHost,
      intent: 'charge',
      request: {
        amount: finalAmount,
        currency: 'usd',
        decimals: 6,
        recipient: 'router-admin-bypass',
      },
    }
  } else {
    return new Response(JSON.stringify({
      error: 'Merchant returned 402 without WWW-Authenticate header',
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  } // end: !route.fixedPricing probe branch

  if (!parsed) {
    return new Response(JSON.stringify({
      error: 'Could not parse merchant challenge',
      raw: wwwAuth,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ---- Tempo pool balance pre-flight check -------------------------
  // Before accepting the agent's Stellar payment, verify the Router's
  // Tempo wallet has enough USDC.e to cover the merchant quote. If
  // not, return 503 so the agent doesn't pay and get nothing back.
  // Also fire a DingTalk alert when the pool is below 5 USDC.
  // Fixed-price routes (Mercury MVP) never pay a merchant on Tempo —
  // `payMerchantAndGetBody`'s upstreamAuth branch calls the upstream
  // directly — so the Tempo pool balance is irrelevant to whether this
  // request can be served.
  const merchantQuoteBaseUnits = route.fixedPricing ? null : (() => {
    try { return BigInt(parsed.request.amount) } catch { return null }
  })()
  if (merchantQuoteBaseUnits !== null) {
    const tempoBalance = await getTempoUsdcBalance(
      env.TEMPO_RPC_URL,
      env.TEMPO_ROUTER_ADDRESS,
      env.TEMPO_RPC_URL_PRIMARY,
    )
    if (tempoBalance !== null) {
      // Fire DingTalk alert if balance < 5 USDC (fire-and-forget)
      if (tempoBalance < LOW_BALANCE_THRESHOLD && env.DINGTALK_ACCESS_TOKEN) {
        const balanceStr = (Number(tempoBalance) / 1_000_000).toFixed(2)
        ctx.waitUntil(
          sendDingTalkAlert(
            env.DINGTALK_ACCESS_TOKEN,
            redactForAlert(`[MPP Router] ⚠️ Tempo pool low balance: ${balanceStr} USDC\n` +
            `Address: ${env.TEMPO_ROUTER_ADDRESS}\n` +
            `Threshold: 5 USDC\n` +
            `Action needed: top up the Tempo pool to avoid service disruption.`),
          ),
        )
      }
      // Reject if balance can't cover this request
      if (tempoBalance < merchantQuoteBaseUnits) {
        const balanceStr = (Number(tempoBalance) / 1_000_000).toFixed(2)
        const quoteStr = (Number(merchantQuoteBaseUnits) / 1_000_000).toFixed(4)
        console.error(
          `[proxy] Tempo pool insufficient: balance=${balanceStr} USDC, quote=${quoteStr} USDC, route=${route.id}`,
        )
        return new Response(JSON.stringify({
          error: 'Router temporarily unable to serve this route',
          detail: `Tempo pool balance (${balanceStr} USDC) is insufficient for merchant quote (${quoteStr} USDC). Please try again later.`,
        }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '300',
          },
        })
      }
    }
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

    // Consume the rate-limit slot HERE — credential is verified, we are
    // about to make the real upstream call, and no money has moved yet
    // (the on-chain settle for stellar.x402 only happens after merchant
    // 2xx, further below). Release the nonce reservation on reject so
    // the agent can retry with the same payload.
    const rateLimitRejectX402 = await consumeRateLimitSlotOrReject()
    if (rateLimitRejectX402) {
      ctx.waitUntil(reserve.release())
      return rateLimitRejectX402
    }

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

    // Check for async 202 — store job auth and return early with poll URL
    const asyncResponse = await handleAsyncJob(env, payResult, route, authHeader, url)
    if (asyncResponse) {
      // Still need to settle the x402 payment — agent paid, merchant accepted
      const settle = await settleStellarX402(env, verify.payload, verify.requirements)
      if (!settle.success) {
        console.error(
          `[proxy] stellar.x402 SETTLE FAILED (async 202) for ${route.id}: ` +
            `${settle.errorReason ?? ''} ${settle.errorMessage ?? ''}`,
        )
      }
      return asyncResponse
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

    // Payment log. Still no idempotency cache entry on this branch.
    // prepare() now decodes the payer for LEDGER ATTRIBUTION only, and that
    // is deliberately a best-effort value that can be null — it is NOT the
    // "verified payer" an idempotency key would need. Scoping a cached
    // merchant response to a best-effort identity would reintroduce exactly
    // the cross-account disclosure this branch removed. Restoring x402
    // idempotency needs the payer to be verified (i.e. proven by the
    // facilitator's simulate result), not merely parsed; still a follow-up.
    ctx.waitUntil((async () => {
      console.log(
        `[payment] route=${route.id} method=stellar.x402 merchant=${merchantHost} upstreamPath=${upstreamPath}`,
      )
    })())

    // Per-call order ledger (design doc §2.9). Recorded for EVERY settled
    // call, not only router-held-credential (Mercury) routes: the records
    // now back the public GET /v1/ledger, and a ledger that silently omits
    // most of the router's paid traffic misrepresents it. settlement_ref is
    // the on-chain settle tx when it succeeded.
    //
    // Payer IS now decoded from the signed XDR (extractPayerFromXdr, run
    // during prepare). It stays null when the payload shape defeats
    // decoding, so consumers must still treat null as "unknown", not as
    // "no payer". Attribution never gates the payment: prepare already
    // succeeded by this point regardless of what the decoder returned.
    {
      ctx.waitUntil(recordOrder(env, {
        order_id: newOrderId(),
        ts: new Date().toISOString(),
        route_id: route.id,
        payer: prepared.payer,
        amount_usd: baseUnitsToDecimalString(parsed.request.amount, TEMPO_DEFAULT_DECIMALS),
        settlement_ref: settle.transaction ?? null,
        request_path: `${upstreamPath}${forwardedSearch}`,
        upstream_status: payResult.merchantStatus,
        latency_ms: payResult.latencyMs ?? 0,
        refund_status: 'none' as RefundStatus,
      }))
    }

    const headers: Record<string, string> = {
      'Content-Type': payResult.contentType,
      // The merchant's accepted Tempo challenge amount is both the upstream
      // quote and the exact amount payMerchant/payMerchantSession authorizes.
      // It is therefore the realized upstream cash cost for this zero-markup
      // route, not a token-derived estimate.
      'X-MPPRouter-Quoted-Amount': baseUnitsToDecimalString(parsed.request.amount, TEMPO_DEFAULT_DECIMALS),
      'X-MPPRouter-Upstream-Cost': baseUnitsToDecimalString(parsed.request.amount, TEMPO_DEFAULT_DECIMALS),
    }
    if (prepared.payer) headers['X-MPPRouter-Payer'] = prepared.payer
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
  let settledPayment: PaymentProof | undefined
  // Verified payer for the stellar.channel voucher path, which delivers
  // without producing a PaymentProof. Set only from a credential mppx has
  // already verified; used to scope the idempotency key.
  let verifiedChannelPayer: string | undefined
  let channelVoucher: {
    challengeId: string
    acceptedAmount: string
    previousAmount: string
    action: 'voucher' | 'close'
  } | undefined
  let channelDeliveryLockId: string | undefined
  let channelPreviousAmount: string | undefined
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
      mppx = createStellarPayment(env, (payment: any) => {
        settledPayment = {
          paymentId: payment.challenge.id,
          paymentTx: payment.receipt.reference,
          payer: payerAccount(payment.credential.source),
          recipient: payment.request.recipient,
          asset: payment.request.currency,
          amountAtomic: String(payment.request.amount),
          mode: 'charge',
        }
      }) as any
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
      if (authHeader) {
        channelDeliveryLockId = crypto.randomUUID()
        const acquired = await acquireChannelDeliveryLock(env, channelContractForVerify, channelDeliveryLockId)
        if (!acquired) {
          return new Response(JSON.stringify({
            error: 'Another channel delivery is in progress',
            hint: 'Retry this exact request shortly.',
          }), { status: 409, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } })
        }
        const channelStore = Store.cloudflare(doAtomicParams(env.ATOMIC_STORE))
        const previous = await channelStore.get(`stellar:channel:cumulative:${channelContractForVerify}`) as any
        const previousAmount = previous && typeof previous === 'object' && 'amount' in previous
          ? String(previous.amount) : '0'
        channelPreviousAmount = previousAmount
        ;(mppx as any).onPaymentSuccess((payment: any) => {
          const action = payment.credential.payload.action === 'close' ? 'close' : 'voucher'
          // See the recovery path below: 'voucher' produces no
          // PaymentProof, so capture the verified payer here for the
          // idempotency key.
          verifiedChannelPayer = payerAccount(payment.credential.source)
          channelVoucher = {
            challengeId: payment.challenge.id,
            acceptedAmount: String(payment.credential.payload.amount),
            previousAmount,
            action,
          }
          if (action === 'close') {
            settledPayment = {
              paymentId: payment.challenge.id,
              paymentTx: payment.receipt.reference,
              payer: payerAccount(payment.credential.source),
              recipient: getRouterStellarAddress(env),
              asset: channelCurrencyForVerify!,
              amountAtomic: String(payment.request.amount),
              mode: 'channel',
            }
          }
        })
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
        // `meta` is server-defined correlation data that mppx 0.7 binds into
        // the challenge `opaque` and re-checks at verify time (it MUST be
        // identical between issue and verify, or the credential is rejected
        // with "credential opaque does not match this route's requirements").
        // So meta may ONLY contain values that are stable across the two 402
        // round-trips for the same payment. `route.id` is stable; the upstream
        // merchant challenge id (`parsed.id`) is NOT — the merchant issues a
        // fresh challenge id on every probe, so putting it here made the
        // verify-time opaque diverge from the issue-time opaque and broke all
        // charge payments after the mppx 0.4->0.7 upgrade. Reconciliation with
        // the upstream challenge is done elsewhere (the proxy logs/links the
        // ids per request); it must not ride in the HMAC-bound opaque.
        meta: {
          route: route.id,
        },
      })(mppxInput)
    }
  } catch (err: any) {
    if (channelContractForVerify && channelDeliveryLockId) {
      try {
        await releaseChannelDeliveryLock(env, channelContractForVerify, channelDeliveryLockId)
      } catch (error: any) {
        console.error(`[channel] rate-limit lock release failed: ${error.message}`)
      }
      channelDeliveryLockId = undefined
    }
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
    if (channelContractForVerify && channelDeliveryLockId) {
      await releaseChannelDeliveryLock(env, channelContractForVerify, channelDeliveryLockId)
      channelDeliveryLockId = undefined
    }
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

  if (
    authKind === 'stellar.channel' && !channelVoucher && authHeader &&
    channelPreviousAmount !== undefined && channelCurrencyForVerify
  ) {
    try {
      const credential = Credential.deserialize(authHeader) as any
      const receipt = Receipt.fromResponse(verifyResult.withReceipt(new Response(null)))
      const action = credential.payload.action === 'close' ? 'close' : 'voucher'
      // The plain 'voucher' action never builds a settledPayment (only
      // 'close' does), so without this the channel path would have no
      // payer to scope an idempotency key to and would lose retry
      // protection entirely. `credential` here has already been verified
      // by mppx above — same trust level the close branch relies on.
      verifiedChannelPayer = payerAccount(credential.source)
      channelVoucher = {
        challengeId: credential.challenge.id,
        acceptedAmount: String(credential.payload.amount),
        previousAmount: channelPreviousAmount,
        action,
      }
      if (action === 'close') {
        settledPayment = {
          paymentId: credential.challenge.id,
          paymentTx: receipt.reference,
          payer: payerAccount(credential.source),
          recipient: getRouterStellarAddress(env),
          asset: channelCurrencyForVerify,
          amountAtomic: String(credential.challenge.request.amount),
          mode: 'channel',
        }
      }
    } catch (error: any) {
      console.error(`[refund] channel proof recovery failed: ${error.message}`)
    }
  }

  // Every response after inbound settlement must carry the same immutable
  // charge evidence, including cache hits, async 202s and refund/error paths.
  // The OpenAI facade ledger consumes these headers; omitting them would turn
  // a real customer charge into a misleading passthrough/$0 row.
  const withFacadeChargeEvidence = (
    response: Response,
    upstreamCost = baseUnitsToDecimalString(parsed.request.amount, TEMPO_DEFAULT_DECIMALS),
  ): Response => {
    const wrapped = new Response(response.body, response)
    const amount = baseUnitsToDecimalString(parsed.request.amount, TEMPO_DEFAULT_DECIMALS)
    wrapped.headers.set('X-MPPRouter-Quoted-Amount', amount)
    wrapped.headers.set('X-MPPRouter-Upstream-Cost', upstreamCost)
    const payer = settledPayment?.payer ?? verifiedChannelPayer
    if (payer) wrapped.headers.set('X-MPPRouter-Payer', payer)
    return wrapped
  }

  if (authKind === 'stellar.channel' && !channelVoucher) {
    const response = new Response(JSON.stringify({
      error: 'Channel payment verified but delivery stopped for refund safety',
      detail: 'Operator reconciliation required; no upstream call was attempted.',
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Refund-Status': 'manual-review' },
    })
    return verifyResult.withReceipt(withFacadeChargeEvidence(response, '0'))
  }

  // Defensive recovery path: observer callbacks are intentionally isolated by
  // mppx, so reconstruct the same proof from the credential that has just been
  // cryptographically verified plus the SDK-generated payment receipt.
  if (authKind !== 'stellar.channel' && !settledPayment && authHeader) {
    try {
      const credential = Credential.deserialize(authHeader) as any
      const receipt = Receipt.fromResponse(verifyResult.withReceipt(new Response(null)))
      settledPayment = {
        paymentId: credential.challenge.id,
        paymentTx: receipt.reference,
        payer: payerAccount(credential.source),
        recipient: credential.challenge.request.recipient,
        asset: credential.challenge.request.currency,
        amountAtomic: String(credential.challenge.request.amount),
        mode: 'charge',
      }
    } catch (error: any) {
      console.error(`[refund] payment proof recovery failed: ${error.message}`)
    }
  }

  if (authKind !== 'stellar.channel' && !settledPayment) {
    console.error('[refund] CRITICAL: Stellar charge settled but payment proof capture was unavailable')
    const response = new Response(JSON.stringify({
      error: 'Payment settled but delivery was stopped for refund safety',
      detail: 'Operator reconciliation required; no upstream charge was attempted.',
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Refund-Status': 'manual-review' },
    })
    return verifyResult.withReceipt(withFacadeChargeEvidence(response, '0'))
  }

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
  //
  // Rate-limit slot consumed HERE (credential just verified above, we
  // are about to make the real upstream call) — never on the
  // unpaid/handshake leg (the earlier peek only). See consumeRateLimitSlotOrReject.
  // Idempotency lookup. Placement is load-bearing in both directions:
  //
  //   - AFTER credential verification and settlement (the payer has
  //     already been charged by the mppx verify above), so a cache hit is
  //     never a way to obtain a paid merchant response for free, and the
  //     key can be scoped to a payer we have actually authenticated.
  //   - BEFORE the merchant call, so it still does what the cache is for:
  //     stop a retry from spending the Tempo pool twice on the same
  //     upstream call.
  //   - BEFORE the rate-limit slot is consumed, because a hit makes no
  //     upstream request. Consuming a slot here would let honest retries
  //     burn the payer's quota, and could even 429 a caller away from a
  //     response we were about to hand them from KV.
  //
  // The key covers everything that can change the merchant response —
  // payer, route, method, resolved upstream path + forwarded query, and
  // the body — so a hit can only return this caller's own earlier
  // response to the very same upstream call.
  const idempotencyPayer = settledPayment?.payer ?? verifiedChannelPayer
  const idempotencyKey = requestId && idempotencyPayer
    ? await buildIdempotencyKey({
        requestId,
        routeId: route.id,
        payer: idempotencyPayer,
        method: request.method,
        upstreamPath,
        forwardedSearch,
        body: requestBody,
      })
    : undefined
  if (idempotencyKey) {
    const cached = await env.MPP_STORE.get(idempotencyKey)
    if (cached) {
      if (channelContractForVerify && channelDeliveryLockId) {
        await releaseChannelDeliveryLock(env, channelContractForVerify, channelDeliveryLockId)
        channelDeliveryLockId = undefined
      }
      const response = new Response(cached, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Idempotent': 'true' },
      })
      return verifyResult.withReceipt(withFacadeChargeEvidence(response, '0'))
    }
  }

  const rateLimitRejectMppx = await consumeRateLimitSlotOrReject()
  if (rateLimitRejectMppx) {
    if (
      authKind === 'stellar.channel' && channelContractForVerify &&
      channelVoucher?.action === 'voucher'
    ) {
      let rolledBack = false
      try {
        rolledBack = await rollbackFailedChannelVoucher(
          env,
          channelContractForVerify,
          channelVoucher.acceptedAmount,
          channelVoucher.previousAmount,
          channelVoucher.challengeId,
        )
      } catch (error: any) {
        console.error(`[refund] rate-limit channel rollback failed: ${error.message}`)
      }
      rateLimitRejectMppx.headers.set(
        'Refund-Status',
        rolledBack ? 'voucher-not-consumed' : 'manual-review',
      )
      rateLimitRejectMppx.headers.set('Refund-Mode', 'channel-remainder')
    } else if (settledPayment) {
      const orderId = newOrderId()
      const orderRecorded = await recordOrder(env, {
        order_id: orderId,
        ts: new Date().toISOString(),
        route_id: route.id,
        payer: settledPayment.payer ?? null,
        amount_usd: baseUnitsToDecimalString(parsed.request.amount, TEMPO_DEFAULT_DECIMALS),
        settlement_ref: settledPayment.paymentTx ?? null,
        request_path: `${upstreamPath}${forwardedSearch}`,
        upstream_status: 429,
        latency_ms: 0,
        refund_status: 'pending',
      })
      try {
        const refund = await enqueueRefund(env, {
          proof: settledPayment,
          reason: 'non_fulfillment',
          merchant: merchantHost,
          routeId: route.id,
          ...(orderRecorded ? { orderId } : {}),
        })
        rateLimitRejectMppx.headers.set('Refund-Id', refund.publicId)
        rateLimitRejectMppx.headers.set('Refund-Status', 'pending')
        rateLimitRejectMppx.headers.set('Refund-Status-Url', `${url.origin}/v1/refunds/${refund.publicId}`)
      } catch (error: any) {
        console.error(`[refund] CRITICAL: rate-limit refund persistence failed: ${error.message}`)
        if (orderRecorded) await updateOrderRefundStatus(env, orderId, 'unknown')
        rateLimitRejectMppx.headers.set('Refund-Status', 'manual-review')
      }
    } else {
      rateLimitRejectMppx.headers.set('Refund-Status', 'manual-review')
    }
    if (channelContractForVerify && channelDeliveryLockId) {
      try {
        await releaseChannelDeliveryLock(env, channelContractForVerify, channelDeliveryLockId)
      } catch (error: any) {
        console.error(`[channel] rate-limit lock release failed: ${error.message}`)
      }
      channelDeliveryLockId = undefined
    }
    return verifyResult.withReceipt(withFacadeChargeEvidence(rateLimitRejectMppx, '0'))
  }

  let payResult: MerchantPayResult
  try {
    payResult = await payMerchantAndGetBody(
      env,
      ctx,
      route,
      parsed,
      merchantUrl,
      request,
      requestBody,
    )
  } catch (error: any) {
    console.error(`[proxy] Merchant delivery threw after payment: ${error.message}`)
    payResult = {
      kind: 'error',
      refundReason: 'timeout',
      response: new Response(JSON.stringify({
        error: 'Merchant delivery failed',
        detail: error.message,
      }), { status: 502, headers: { 'Content-Type': 'application/json' } }),
    }
  }
  if (payResult.kind === 'error') {
    // Per-call order ledger, failure leg. Until 2026-08-18 recordOrder was
    // only reached on the success path, so a call the agent PAID for and did
    // not receive left no trace in GET /v1/ledger at all — exactly the calls
    // a settlement ledger exists to show. Reproduced on
    // /v1/services/anthropic/chat_completions (paid, merchant leg 403, auto-
    // refunded ~25s later): two settlements, zero ledger rows.
    //
    // Recorded only when `settledPayment` exists, i.e. the agent's money
    // actually moved on chain. A channel voucher that gets rolled back below
    // never settles, and a merchant failure before settlement (the x402
    // branch pays the merchant first) costs the agent nothing — neither is a
    // settlement, so neither belongs in a settlement ledger.
    const failedLegOrderId = settledPayment ? newOrderId() : undefined
    /**
     * Returns the write so the caller can decide whether to await it. The
     * refund branch MUST await: `enqueueRefund` makes the job visible to the
     * refund executor, and an executor that leases and confirms before this
     * row exists would find nothing to update and leave the call publicly
     * `refund_pending` forever (codex review, 2026-08-18). One KV put on a
     * path that already awaits the enqueue is a cheap price for that.
     */
    const recordFailedLeg = (refundStatus: RefundStatus): Promise<boolean> => {
      if (!settledPayment || !failedLegOrderId || payResult.kind !== 'error') {
        return Promise.resolve(false)
      }
      return recordOrder(env, {
        order_id: failedLegOrderId,
        ts: new Date().toISOString(),
        route_id: route.id,
        payer: settledPayment.payer ?? null,
        amount_usd: baseUnitsToDecimalString(parsed.request.amount, TEMPO_DEFAULT_DECIMALS),
        settlement_ref: settledPayment.paymentTx ?? null,
        request_path: `${upstreamPath}${forwardedSearch}`,
        // 0 means "the merchant never answered" (transport error/throw);
        // every branch where it did answer carries the real status.
        upstream_status: payResult.merchantStatus ?? 0,
        latency_ms: payResult.latencyMs ?? 0,
        refund_status: refundStatus,
      })
    }

    if (
      authKind === 'stellar.channel' && channelContractForVerify &&
      channelVoucher?.action === 'voucher'
    ) {
      let rolledBack = false
      try {
        rolledBack = await rollbackFailedChannelVoucher(
          env,
          channelContractForVerify,
          channelVoucher.acceptedAmount,
          channelVoucher.previousAmount,
          channelVoucher.challengeId,
        )
        if (rolledBack && channelDeliveryLockId) {
          await releaseChannelDeliveryLock(env, channelContractForVerify, channelDeliveryLockId)
          channelDeliveryLockId = undefined
        }
      } catch (error: any) {
        console.error(`[refund] channel voucher rollback failed: ${error.message}`)
      }
      // A rolled-back voucher was never consumed, so nothing settled and
      // there is nothing to put in the ledger. A rollback that FAILED is the
      // opposite: value may have left the channel with no refund queued, so
      // record it as `unknown` if a settlement exists for it.
      // No refund job is created on this branch, so nothing races the write;
      // keep it off the response path.
      if (!rolledBack) ctx.waitUntil(recordFailedLeg('unknown'))
      const response = new Response(payResult.response.body, payResult.response)
      response.headers.set('Refund-Mode', 'channel-remainder')
      response.headers.set('Refund-Status', rolledBack ? 'voucher-not-consumed' : 'manual-review')
      response.headers.set('Refund-Channel', channelContractForVerify)
      return verifyResult.withReceipt(withFacadeChargeEvidence(response, rolledBack ? '0' : undefined))
    }
    if (settledPayment && payResult.refundReason) {
      // Before the enqueue, not after: see the note on recordFailedLeg.
      const orderRecorded = await recordFailedLeg('pending')
      let refund
      try {
        refund = await enqueueRefund(env, {
          proof: settledPayment,
          reason: payResult.refundReason,
          merchant: merchantHost,
          routeId: route.id,
          ...(orderRecorded && failedLegOrderId ? { orderId: failedLegOrderId } : {}),
        })
      } catch (error: any) {
        console.error(`[refund] CRITICAL: merchant-failure refund persistence failed: ${error.message}`)
        if (orderRecorded && failedLegOrderId) {
          await updateOrderRefundStatus(env, failedLegOrderId, 'unknown')
        }
        const response = new Response(payResult.response.body, payResult.response)
        response.headers.set('Refund-Status', 'manual-review')
        if (channelContractForVerify && channelDeliveryLockId) {
          try {
            await releaseChannelDeliveryLock(env, channelContractForVerify, channelDeliveryLockId)
          } catch (releaseError: any) {
            console.error(`[channel] refund-failure lock release failed: ${releaseError.message}`)
          }
          channelDeliveryLockId = undefined
        }
        return verifyResult.withReceipt(withFacadeChargeEvidence(response))
      }
      if (channelContractForVerify && channelDeliveryLockId) {
        try {
          await releaseChannelDeliveryLock(env, channelContractForVerify, channelDeliveryLockId)
        } catch (error: any) {
          console.error(`[channel] refund-pending lock release failed: ${error.message}`)
        }
        channelDeliveryLockId = undefined
      }
      const response = new Response(payResult.response.body, payResult.response)
      response.headers.set('Refund-Id', refund.publicId)
      response.headers.set('Refund-Status', 'pending')
      response.headers.set('Refund-Status-Url', `${url.origin}/v1/refunds/${refund.publicId}`)
      return verifyResult.withReceipt(withFacadeChargeEvidence(response))
    }
    // Settled, undelivered, and no refund could be queued (no refundReason,
    // e.g. a route-level rejection after settlement). `unknown` says so
    // plainly rather than leaving the call invisible. No refund job exists to
    // race this write, so it stays off the response path.
    ctx.waitUntil(recordFailedLeg('unknown'))
    const response = new Response(payResult.response.body, payResult.response)
    response.headers.set('Refund-Status', 'manual-review')
    if (channelContractForVerify && channelDeliveryLockId) {
      try {
        await releaseChannelDeliveryLock(env, channelContractForVerify, channelDeliveryLockId)
      } catch (error: any) {
        console.error(`[channel] manual-review lock release failed: ${error.message}`)
      }
      channelDeliveryLockId = undefined
    }
    return verifyResult.withReceipt(withFacadeChargeEvidence(response))
  }

  // Check for async 202 — store job auth and return early with poll URL
  const asyncResponse = await handleAsyncJob(
    env, payResult, route, authHeader, url, settledPayment,
    channelContractForVerify && channelDeliveryLockId && channelVoucher
      ? {
          channelContract: channelContractForVerify,
          lockId: channelDeliveryLockId,
          challengeId: channelVoucher.challengeId,
          acceptedAmount: channelVoucher.acceptedAmount,
          previousAmount: channelVoucher.previousAmount,
          action: channelVoucher.action,
        }
      : undefined,
  )
  if (asyncResponse) return verifyResult.withReceipt(withFacadeChargeEvidence(asyncResponse))

  if (channelContractForVerify && channelDeliveryLockId) {
    await releaseChannelDeliveryLock(env, channelContractForVerify, channelDeliveryLockId)
    channelDeliveryLockId = undefined
  }

  const { body, contentType } = payResult

  // Async tasks: broadcast Stellar tx (handled by mppx store), log, cache idempotency
  ctx.waitUntil((async () => {
    console.log(
      `[payment] route=${route.id} merchant=${merchantHost} upstreamPath=${upstreamPath}`,
    )
    if (idempotencyKey) {
      await env.MPP_STORE.put(idempotencyKey, body, { expirationTtl: 86400 })
    }
  })())

  // Per-call order ledger (design doc §2.9). Recorded for EVERY settled
  // call — see the note on the stellar.x402 branch above.
  {
    ctx.waitUntil(recordOrder(env, {
      order_id: newOrderId(),
      ts: new Date().toISOString(),
      route_id: route.id,
      payer: settledPayment?.payer ?? null,
      amount_usd: baseUnitsToDecimalString(parsed.request.amount, TEMPO_DEFAULT_DECIMALS),
      settlement_ref: settledPayment?.paymentTx ?? null,
      request_path: `${upstreamPath}${forwardedSearch}`,
      upstream_status: payResult.merchantStatus,
      latency_ms: payResult.latencyMs ?? 0,
      refund_status: 'none' as RefundStatus,
    }))
  }

  const merchantContent = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      // Facade metering consumes these values after handleProxy returns. They
      // are also useful reconciliation evidence for direct API clients. The
      // upstream cash cost equals the accepted merchant challenge amount:
      // payMerchant authorizes that exact charge, while session mode advances
      // its cumulative channel by that exact amount.
      'X-MPPRouter-Quoted-Amount': baseUnitsToDecimalString(parsed.request.amount, TEMPO_DEFAULT_DECIMALS),
      'X-MPPRouter-Upstream-Cost': baseUnitsToDecimalString(parsed.request.amount, TEMPO_DEFAULT_DECIMALS),
      ...(settledPayment?.payer ?? verifiedChannelPayer
        ? { 'X-MPPRouter-Payer': (settledPayment?.payer ?? verifiedChannelPayer)! }
        : {}),
    },
  })
  return verifyResult.withReceipt(merchantContent)
}
