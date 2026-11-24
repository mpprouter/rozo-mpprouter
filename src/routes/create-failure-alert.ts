/**
 * Ops alert when an order cannot be created for a system-side reason.
 *
 * 2026-11-24 (founder: "if create order error, we should receive alerts so
 * that we know xxx is failed"): after the funder tier change, Lightning orders
 * under $200 were refused at creation for about 4.5 hours (rozo-intents-api
 * answered 400 "payout address is fixed server-side", the router relayed a
 * 502 INTENTS_API_FAILED) and nothing alerted; it was found by reading code.
 *
 * This module looks at the response a create route already built and, when it
 * is a system-side failure, sends one Lark alert to Rozo Ops:
 *   - user-caused refusals (expired or paid link, over a cap, below a minimum,
 *     unsupported coin, rate limit, blocked address, a switched-off or paused
 *     coin, ...) never alert;
 *   - everything else alerts, including an unknown code or an unclassified
 *     upstream error (fail towards alerting);
 *   - one alert per (route, reason, source chain, token) per 30 minutes, taken
 *     with one CAS on a dedicated AtomicStoreDO instance, so a broken path
 *     alerts once, not per request.
 *
 * It never changes the response and never delays it: the caller hands the
 * work to ctx.waitUntil. Every failure inside is swallowed.
 *
 * Alert content: route, chain id and token, an amount band (not the amount),
 * HTTP statuses, error codes (format-checked identifiers only, never upstream
 * free text) and a masked invoice id. Never a payment link, coupon, address
 * or secret (redactForAlert also runs over the text as a backstop).
 */

import type { Env } from '../index'
import { alertSinkConfigured, sendAlert } from '../utils/alert'
import { redactForAlert } from '../utils/alert-redaction'
import { casUpdate } from './stripe-atomic'

export type CreateRoute = 'create-invoice' | 'tron-ton-alpha'

/** What the handler knew about the attempt; every field is optional. */
export interface CreateFailureNote {
  /** Validated source chain id (never raw caller input). */
  chainId?: string
  /** Validated source token symbol. */
  tokenSymbol?: string
  /** Merchant invoice amount, USDC atomic (6 decimals). Only its band is reported. */
  invoiceAtomic?: bigint
  /** Provider branch: 'coinbase' | 'stripe_crypto' | 'bitrefill'. */
  provider?: string
  /** Route-specific reason not visible in the body (alpha upstream reason). */
  detail?: string
}

export const CREATE_FAILURE_ALERT_WINDOW_S = 30 * 60
// After a failed delivery the window shrinks to this, so a recovered channel
// hears about a still-broken path soon (same rule as the UPI v2 alerts).
export const CREATE_FAILURE_ALERT_RETRY_S = 10 * 60
export const CREATE_FAILURE_ALERT_DO_INSTANCE = 'create-failure-alerts'

/**
 * Router codes that mean the caller or the invoice cannot be served as asked,
 * or a coin, route or intake that is deliberately off, paused or full (those
 * states are set by an operator and have their own alerts). Never alerted.
 */
export const USER_CAUSED_CODES: ReadonlySet<string> = new Set([
  // Request shape and caller input.
  'INVALID_INPUT', 'INVALID_SOURCE', 'UNSUPPORTED_SOURCE', 'INVALID_INTENT', 'INVALID_EMAIL',
  'INVALID_ADDRESS', 'INVALID_AMOUNT', 'BLOCKED_ADDRESS', 'REFUND_ADDRESS_REQUIRED',
  'REFUND_ADDRESS_MISMATCH', 'ZEC_SHIELDED_ADDRESS_NOT_SUPPORTED',
  'ZEC_SHIELDED_REFUND_ADDRESS_NOT_APPLICABLE', 'ZEC_REQUIRES_EXACT_OUT', 'BTC_REQUIRES_EXACT_OUT',
  'BTC_DESTINATION_UNSUPPORTED',
  // Rate limits.
  'RATE_LIMITED',
  // Link or invoice state.
  'LINK_USED_OR_EXPIRED', 'LINK_NOT_FOUND', 'LINK_NOT_PAYABLE', 'LINK_CLAIMED', 'LINK_EXPIRES_TOO_SOON',
  'MERCHANT_LINK_EXPIRES_TOO_SOON', 'BTC_LINK_TOO_SOON', 'PAYMENT_ALREADY_PAID', 'PAYMENT_EXPIRED',
  'PAYMENT_DETECTED', 'ORDER_ALREADY_ACTIVE', 'ORDER_CREATE_CONFLICT', 'INTENT_MISMATCH',
  'LEGACY_PRICING_ORDER_PENDING', 'QUOTE_RECEIPT_INVALID_OR_EXPIRED', 'QUOTE_RECEIPT_REQUIRED',
  'QUOTE_DRIFT', 'REUSED_SOURCE_MISMATCH', 'ZEC_RECEIVE_MODE_MISMATCH', 'DUPLICATE_INVOICE',
  'INVOICE_CLAIMED', 'INVOICE_EXPIRING', 'BITREFILL_INVOICE_NOT_ALLOWED', 'CELO_NOT_VERIFIED',
  'ALPHA_ORDER_CONFLICT', 'ALPHA_ORDER_CLOSED', 'ALPHA_ORDER_EXPIRED',
  // Amount limits.
  'EXCEEDS_LIMIT', 'AMOUNT_OUT_OF_RANGE', 'BTC_AMOUNT_TOO_LOW', 'BTC_AMOUNT_TOO_HIGH', 'ALPHA_AMOUNT_TOO_HIGH',
  // Deliberately off, paused or full.
  'ZEC_NOT_ENABLED', 'ZEC_SHIELDED_NOT_ENABLED', 'BTC_NOT_ENABLED', 'BTC_APP_NOT_ALLOWED', 'CELO_NOT_ENABLED',
  'BITREFILL_DISABLED', 'ALPHA_UNAVAILABLE', 'ZEC_PAUSED', 'BTC_PAUSED', 'CHECKOUT_INTAKE_PAUSED',
  'CHECKOUT_PAUSED', 'ZEC_DAILY_CAP_REACHED', 'ZEC_CAPACITY_BUSY', 'BTC_CAPACITY_BUSY', 'ALPHA_CAPACITY',
  // The create-invoice global circuit breaker: it sends its own alert.
  'SERVICE_UNAVAILABLE',
])

/**
 * rozo-intents-api payment-api codes that are the caller's or the invoice's
 * (amount below a minimum or above a cap, bad email, rate limit). An
 * INTENTS_API_FAILED / INTENTS_API_REJECTED carrying one of these does not
 * alert. `invalidRequest` is deliberately absent: it is what payment-api
 * answered for today's tier mismatch.
 */
export const UPSTREAM_USER_CODES: ReadonlySet<string> = new Set([
  'amountTooLow', 'amountTooHigh', 'AMOUNT_TOO_SMALL', 'BELOW_MIN_PAYOUT', 'FEE_EXCEEDS_AMOUNT',
  'EXCEEDS_LIMIT', 'invalidEmail', 'emailNotAcceptable', 'rateLimited', 'rate_limited',
  'invalidTokenSymbol', 'unsupportedCurrency', 'unsupported', 'invalidAmount',
])

/** Router codes that are system-side (they alert). Listed so they can be shown. */
export const SYSTEM_CODES: ReadonlySet<string> = new Set([
  'INTENTS_API_FAILED', 'INTENTS_API_REJECTED', 'QUOTE_FETCH_FAILED', 'QUOTE_UNAVAILABLE', 'UPSTREAM_ERROR',
  'SERVER_MISCONFIGURED', 'FUNDER_TIER_REFUSED', 'FUNDER_TIER_RECEIVER_MISMATCH', 'FUNDER_TIER_MISMATCH',
  'FUNDER_RECEIVER_NOT_TIER_WALLET', 'SEED_FAILED', 'BTC_RESERVE_FAILED', 'BTC_UNAVAILABLE',
  'BTC_MONITOR_STALE', 'ZEC_MONITOR_STALE', 'BITREFILL_NOT_CONFIGURED', 'RETRY_LATER',
  'ALPHA_UPSTREAM_FAILED', 'ALPHA_PRICE_UNAVAILABLE',
])

/**
 * payment-api codes that may be shown in an alert (rozo-intents-api
 * payment-api vocabulary, 2026-11-24). Any other upstream value is shown and
 * keyed as `otherUpstreamCode`: a raw upstream string can be a coupon code or
 * an address redactForAlert does not mask, so only listed values leave.
 */
const KNOWN_UPSTREAM_CODES: ReadonlySet<string> = new Set([
  ...UPSTREAM_USER_CODES,
  'invalidRequest', 'checkoutNotAllowed', 'databaseError', 'providerUnavailable', 'providerError',
  'configError', 'NEAR_QUOTE_FAILED', 'NEAR_QUOTE_UNREADABLE', 'NEAR_HUB_UNCONFIGURED',
  'NEAR_DEPOSIT_PERSIST_FAILED', 'INVALID_PROVIDER', 'ROUTE_NOT_SUPPORTED_BY_PROVIDER',
  'insufficientLiquidity', 'INSUFFICIENT_LIQUIDITY', 'priceCheckUnavailable', 'rateLimitUnavailable',
  'destinationTierUnavailable', 'NEGATIVE_ROUTE_ECONOMICS', 'SOLANA_ATA_UNDETERMINED', 'UNAUTHORIZED',
  'unsupportedField', 'invalidChainId', 'orderIdConflict', 'paymentNotFound', 'statusChanged',
  'ZEC_REQUIRES_EXACT_OUT', 'ZEC_CAPACITY_BUSY', 'BTC_REQUIRES_EXACT_OUT',
])

const KNOWN_STAGES: ReadonlySet<string> = new Set([
  'order_lookup', 'create_unreachable', 'create_http_error', 'create_non_json', 'btc_rail_mismatch',
])

/**
 * Alpha note details (tron-ton-alpha.ts): `option_<status>_<upstream reason>`
 * or `business_order_<reason>[_<status>]`. Only listed reasons are shown.
 */
const ALPHA_DETAIL_RE = new RegExp(
  '^(?:option_\\d{3}_(?:alpha_disabled|app_not_allowed|unsupported_asset|order_conflict|' +
  'provider_invoice_conflict|order_not_open|order_expired|order_cap_exceeded|daily_budget_exhausted|' +
  'amount_space_exhausted|payment_reference_exhausted|increment_budget_unset|price_unavailable|' +
  'ton_native_disabled|order_already_fulfilled|exposure_full|unknown)' +
  '|business_order_(?:lookup_failed|create_failed|retired_funder|funder_tier)(?:_\\d{3})?)$',
)

/** Alpha upstream reasons behind ALPHA_CAPACITY that are configuration, not load. */
const ALPHA_CONFIG_DETAIL_RE = /_increment_budget_unset$/

export interface CreateFailureVerdict {
  alert: boolean
  /** Dedupe and display key, e.g. INTENTS_API_FAILED:create_http_error:400:invalidRequest. */
  reason: string
  code: string | null
  stage: string | null
  upstreamStatus: number | null
  upstreamCode: string | null
}

const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function safeCode(v: unknown): string | null {
  return typeof v === 'string' && CODE_RE.test(v) ? v : null
}

/**
 * The upstream code from a relayed payment-api body (possibly truncated).
 * Only the code: upstream free text can carry coupon codes or addresses that
 * redactForAlert does not recognise (TRON, Solana, BTC, TON), so no message
 * text ever reaches an alert.
 */
function parseUpstreamCode(hint: unknown): string | null {
  if (typeof hint !== 'string' || !hint) return null
  try {
    const j: any = JSON.parse(hint)
    return safeCode(j?.error?.code) ?? safeCode(j?.code) ?? safeCode(j?.error)
  } catch {
    // Truncated at 500 chars: read the field directly.
    return /"code"\s*:\s*"([A-Za-z][A-Za-z0-9_]{0,63})"/.exec(hint)?.[1] ?? null
  }
}

/**
 * Pure. Decide whether a create response is a system-side failure.
 * `body` is the parsed JSON body (anything else is treated as no body).
 */
export function classifyCreateFailure(
  status: number,
  body: unknown,
  note: CreateFailureNote = {},
): CreateFailureVerdict {
  const b: any = body && typeof body === 'object' ? body : {}
  const code = safeCode(b.code) ?? safeCode(b.error?.code) ?? (typeof b.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(b.error) ? b.error : null)
  const stage = safeCode(b.stage)
  const upstreamStatus = typeof b.upstream_status === 'number' ? b.upstream_status : null
  const upstreamCode = safeCode(b.upstream_code) ?? parseUpstreamCode(b.hint)
  const detail = safeCode(note.detail)
  // Classification reads the raw values; display and the dedupe key use only
  // listed values, so no caller- or upstream-chosen string leaves the Worker
  // and the key space stays bounded.
  const shownCode = code === null ? null : USER_CAUSED_CODES.has(code) || SYSTEM_CODES.has(code) ? code : 'OTHER_CODE'
  const shownStage = stage === null ? null : KNOWN_STAGES.has(stage) ? stage : 'other_stage'
  const shownUpstream = upstreamCode === null ? null : KNOWN_UPSTREAM_CODES.has(upstreamCode) ? upstreamCode : 'otherUpstreamCode'
  const shownDetail = detail === null ? null : ALPHA_DETAIL_RE.test(detail) ? detail : 'other_detail'
  const shownUpstreamStatus = upstreamStatus !== null && Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599
    ? upstreamStatus
    : null
  const reason = [
    shownCode ?? `HTTP_${status}`,
    shownStage,
    shownUpstreamStatus !== null ? String(shownUpstreamStatus) : null,
    shownUpstream,
    shownDetail,
  ].filter(Boolean).join(':')
  const verdict = (alert: boolean): CreateFailureVerdict => ({
    alert, reason, code: shownCode, stage: shownStage, upstreamStatus: shownUpstreamStatus, upstreamCode: shownUpstream,
  })

  if (status < 400) return verdict(false)
  // Relayed rate limits (router or rozo-intents-api), whatever the body.
  if (status === 429) return verdict(false)
  // Funder tier: a 400 is the amount (over a cap, not positive); a 503 is a
  // tier wallet missing or misconfigured.
  if (code === 'FUNDER_TIER_REFUSED') return verdict(status >= 500)
  // Alpha capacity is load, except a budget that was never configured.
  if (code === 'ALPHA_CAPACITY') return verdict(detail !== null && ALPHA_CONFIG_DETAIL_RE.test(detail))
  if (code && USER_CAUSED_CODES.has(code)) return verdict(false)
  // A relayed payment-api refusal that is the caller's. Also when the router
  // body has no code of its own (the Stripe branch relays a codeless 502 with
  // the upstream body in `hint`).
  if ((code === null || code === 'INTENTS_API_FAILED' || code === 'INTENTS_API_REJECTED') && upstreamCode && UPSTREAM_USER_CODES.has(upstreamCode)) {
    return verdict(false)
  }
  // A router 4xx without any code is a request-shape refusal (wrong method,
  // ineligible Stripe invoice); a 5xx without a code is ours.
  if (!code && status < 500 && upstreamStatus === null) return verdict(false)
  // Everything else: system codes and anything unknown.
  return verdict(true)
}

/** Amount band only, never the amount. $200 is the T2 / T3 funder tier boundary. */
export function amountBand(atomic: bigint | undefined): string {
  if (atomic === undefined || atomic < 0n) return 'unknown'
  const usd = atomic / 1_000_000n
  if (usd < 50n) return 'under $50'
  if (usd < 200n) return '$50 to $200'
  if (usd < 1_000n) return '$200 to $1,000'
  if (usd < 5_000n) return '$1,000 to $5,000'
  return '$5,000 or more'
}

/** First 8 and last 4 characters of an invoice or link id; never the URL. */
export function maskId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return 'none'
  return id.length <= 14 ? `${id.slice(0, 4)}...` : `${id.slice(0, 8)}...${id.slice(-4)}`
}

function displayPart(v: string | undefined): string {
  return typeof v === 'string' && /^[A-Za-z0-9_.-]{1,24}$/.test(v) ? v : 'unresolved'
}

export function dedupeKey(route: CreateRoute, verdict: CreateFailureVerdict, note: CreateFailureNote): string {
  return `create-fail-alert:v1:${route}:${verdict.reason}:${displayPart(note.chainId)}:${displayPart(note.tokenSymbol)}`
}

export function createFailureAlertText(
  route: CreateRoute,
  status: number,
  verdict: CreateFailureVerdict,
  note: CreateFailureNote,
  linkId: unknown,
  now: Date = new Date(),
): string {
  const chain = displayPart(note.chainId)
  const token = displayPart(note.tokenSymbol)
  const lines = [
    `[MPP Router] 🚨 Order creation failing: ${route} ${chain}/${token} (${verdict.reason})`,
    `Route: ${route}${note.provider ? ` (provider ${displayPart(note.provider)})` : ''}; source chain ${chain}, token ${token}; amount band ${amountBand(note.invoiceAtomic)}`,
    `Customer got HTTP ${status}, code ${verdict.code ?? 'none'}${verdict.stage ? `, stage ${verdict.stage}` : ''}`,
    `Upstream: HTTP ${verdict.upstreamStatus ?? 'none'}, code ${verdict.upstreamCode ?? 'none'}`,
    `Invoice: ${maskId(linkId)}`,
    `At: ${now.toISOString()}`,
    `Customers on this path get an error instead of an order until it is fixed. Same route, reason, chain and token re-alert at most every ${CREATE_FAILURE_ALERT_WINDOW_S / 60} min.`,
  ]
  return lines.join('\n')
}

/**
 * Classify, dedupe and send. Never throws. `res` must be a response the caller
 * does not read (a clone).
 */
export async function reportCreateFailure(
  env: Env,
  route: CreateRoute,
  res: Response,
  note: CreateFailureNote,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    const body = await res.json().catch(() => null)
    const verdict = classifyCreateFailure(res.status, body, note)
    if (!verdict.alert) return
    const key = dedupeKey(route, verdict, note)
    const until = new Date(nowMs + CREATE_FAILURE_ALERT_WINDOW_S * 1000).toISOString()
    const won = await casUpdate<boolean>(env, key, (cur) => {
      const end = cur ? Date.parse(cur) : NaN
      if (Number.isFinite(end) && end > nowMs) return { op: 'noop', result: false }
      return { op: 'set', value: until, result: true }
    }, CREATE_FAILURE_ALERT_DO_INSTANCE)
    if (!won) return
    const b: any = body && typeof body === 'object' ? body : {}
    const linkId = b.link_id_detected ?? b.linkId ?? null
    const delivered = await sendAlert(env, redactForAlert(createFailureAlertText(route, res.status, verdict, note, linkId, new Date(nowMs))))
    if (!delivered) {
      const retryAt = new Date(nowMs + CREATE_FAILURE_ALERT_RETRY_S * 1000).toISOString()
      await casUpdate<void>(env, key, (cur) =>
        cur === until ? { op: 'set', value: retryAt, result: undefined } : { op: 'noop', result: undefined },
      CREATE_FAILURE_ALERT_DO_INSTANCE)
    }
  } catch (e) {
    console.warn(`[create-failure-alert] error (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Synchronous entry for a handler that is about to return `res`: clones it
 * (the customer keeps the original body) and hands the alert to waitUntil.
 * Nothing happens for a 2xx/3xx or when no alert sink is configured.
 */
export function scheduleCreateFailureAlert(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
  route: CreateRoute,
  res: Response,
  note: CreateFailureNote,
): void {
  try {
    if (res.status < 400 || !alertSinkConfigured(env)) return
    const work = reportCreateFailure(env, route, res.clone(), { ...note })
    if (ctx) ctx.waitUntil(work)
    else void work
  } catch (e) {
    console.warn(`[create-failure-alert] schedule error (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
  }
}
