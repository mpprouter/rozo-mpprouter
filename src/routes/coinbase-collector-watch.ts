/**
 * Unknown Coinbase token collector watch (alert only, never blocks).
 *
 * Background (2026-11-13, order fd92846d): Coinbase moved the ERC-3009
 * recipient of its payments from ERC3009PaymentCollector v1.0 to v1.1. The
 * reward path in pay-invoice refused to sign (REWARD_TOKEN_COLLECTORS did not
 * list v1.1) and the UPI order was refunded. Operators want to hear about such
 * a change the first time any payment meets it.
 *
 * Founder decision 2026-11-13: alert, do not block, at any amount. So:
 *   - pay-invoice reports `signed_collector: { chain_id, to, value_atomic }`
 *     in its response once it reached the signing step (cash path only);
 *   - after each cash pay-invoice call the router compares `chain_id:to`
 *     with KNOWN_COINBASE_TOKEN_COLLECTORS and, if it is not there, sends one
 *     Lark ops alert (deduped per contract);
 *   - the payment outcome, the record state machine and every caller's
 *     control flow are untouched. The watch never throws and waits at most
 *     COLLECTOR_ALERT_BUDGET_MS before letting the caller continue.
 *
 * Reward calls (expected_binding) are skipped: the signer enforces its own
 * allowlist there and does not report the field.
 */

import type { Env } from '../index'
import { casUpdate } from './stripe-atomic'
import { alertSinkConfigured, sendAlert } from '../utils/alert'
import { redactForAlert } from '../utils/alert-redaction'

/**
 * `<chainId>:<lowercase address>` of Coinbase ERC-3009 token collectors seen in
 * real payments from our funder. Public on-chain contract addresses, not
 * secrets. Same values as the verified REWARD_TOKEN_COLLECTORS baseline in
 * ainative ops_patrol W28 (2026-11-13).
 */
export const KNOWN_COINBASE_TOKEN_COLLECTORS: ReadonlySet<string> = new Set([
  '8453:0x0e3df9510de65469c4518d7843919c0b8c7a7757', // ERC3009PaymentCollector v1.0
  '8453:0x8612dfdc421f80336cd14e8ef9cb1e765db5ab88', // ERC3009PaymentCollector v1.1 (live since 2026-11)
])

/** One alert per unknown contract per window; the first payment alerts at once. */
export const UNKNOWN_COLLECTOR_ALERT_WINDOW_S = 6 * 60 * 60
/** Large payments get their own, shorter window so a big one is never hidden by a small one. */
export const UNKNOWN_COLLECTOR_LARGE_WINDOW_S = 60 * 60
/** 100 USDC (6 decimals). */
export const UNKNOWN_COLLECTOR_LARGE_ATOMIC = 100_000_000n
/** Claim window taken before sending; stays in force when no channel confirms delivery. */
export const UNKNOWN_COLLECTOR_RETRY_AFTER_FAILED_DELIVERY_S = 10 * 60
/** Longest the caller waits for the watch before continuing. */
export const COLLECTOR_ALERT_BUDGET_MS = 2_000

export type PayLine = 'checkout' | 'coupon' | 'upi_v1' | 'admin_pay'

export interface SignedCollector {
  chainId: number
  to: string
  valueAtomic: bigint
}

/** Strict parse of the signer's `signed_collector`; null when absent or malformed. */
export function parseSignedCollector(body: unknown): SignedCollector | null {
  if (!body || typeof body !== 'object') return null
  const sc = (body as Record<string, unknown>).signed_collector
  if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return null
  const { chain_id, to, value_atomic } = sc as Record<string, unknown>
  if (typeof chain_id !== 'number' || !Number.isSafeInteger(chain_id) || chain_id <= 0) return null
  if (typeof to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(to)) return null
  if (typeof value_atomic !== 'string' || !/^[0-9]{1,30}$/.test(value_atomic)) return null
  return { chainId: chain_id, to: to.toLowerCase(), valueAtomic: BigInt(value_atomic) }
}

/** First 6 + last 4 of every EVM address, for log lines. */
function maskHex(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{40}/g, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`)
}

export function collectorKey(c: { chainId: number; to: string }): string {
  return `${c.chainId}:${c.to.toLowerCase()}`
}

export function isKnownCollector(c: { chainId: number; to: string }): boolean {
  return KNOWN_COINBASE_TOKEN_COLLECTORS.has(collectorKey(c))
}

/** Short, non-reversible label for an invoice id (enough to find it in logs). */
export function shortInvoiceId(id: string): string {
  const m = id.match(/^(pl_|paymentSession_)(.*)$/)
  if (m) return `${m[1]}${m[2].slice(0, 8)}…`
  return `${id.slice(0, 8)}…`
}

const LINE_LABEL: Record<PayLine, string> = {
  checkout: 'crypto checkout order (Rozo Intents)',
  coupon: 'coupon redemption',
  upi_v1: 'UPI cash order (MuggleLink)',
  admin_pay: 'admin pay-invoice endpoint',
}

function fmtUsdc(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const frac = (atomic % 1_000_000n).toString().padStart(6, '0').slice(0, 2)
  return `${whole}.${frac}`
}

export function buildUnknownCollectorAlert(p: {
  collector: SignedCollector
  invoiceId: string
  line: PayLine
  ref?: string
  signerStatus: number
  large: boolean
}): string {
  const windowH = p.large ? UNKNOWN_COLLECTOR_LARGE_WINDOW_S / 3600 : UNKNOWN_COLLECTOR_ALERT_WINDOW_S / 3600
  const chain = p.collector.chainId === 8453 ? 'Base (8453)' : `chain ${p.collector.chainId}`
  const lines = [
    `[MPP Router] ⚠️ Coinbase payment signed to an UNKNOWN collector contract (not blocked; outcome follows the normal flow)`,
    `Amount: ${fmtUsdc(p.collector.valueAtomic)} USDC${p.large ? ` (LARGE, at least ${fmtUsdc(UNKNOWN_COLLECTOR_LARGE_ATOMIC)} USDC)` : ''}`,
    `Line: ${LINE_LABEL[p.line]}${p.ref ? `, order ${p.ref.slice(0, 8)}` : ''}`,
    `Invoice: ${shortInvoiceId(p.invoiceId)} (signer HTTP ${p.signerStatus}; 2xx = submitted, 5xx = outcome unknown)`,
    `Chain: ${chain}`,
    `Collector: ${p.collector.to} (known: v1.0 0x0E3dF9510de65469C4518D7843919c0b8C7A7757, v1.1 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88)`,
    `At: ${new Date().toISOString()}`,
    'Check on Basescan that the contract is a Coinbase ERC-3009 token collector. If it is, add it to KNOWN_COINBASE_TOKEN_COLLECTORS (mpprouter) and to REWARD_TOKEN_COLLECTORS (pay-invoice secret): UPI reward orders are refused before signing until then. If it is not, stop checkout delivery (admin stop checkout) and escalate.',
    `Same contract is re-alerted at most every ${windowH}h${p.large ? ' for large payments' : ` (payments of ${fmtUsdc(UNKNOWN_COLLECTOR_LARGE_ATOMIC)} USDC or more alert separately, every ${UNKNOWN_COLLECTOR_LARGE_WINDOW_S / 3600}h)`}.`,
  ]
  // redactForAlert masks every address to first-6 + last-4.
  return lines.join('\n')
}

async function alertUnknownCollector(
  env: Env,
  p: { collector: SignedCollector; invoiceId: string; line: PayLine; ref?: string; signerStatus: number },
): Promise<void> {
  if (!alertSinkConfigured(env)) {
    console.warn(`[collector-watch] alert SKIPPED (no alert channel configured): ${maskHex(collectorKey(p.collector))}`)
    return
  }
  const large = p.collector.valueAtomic >= UNKNOWN_COLLECTOR_LARGE_ATOMIC
  const key = `coinbase-collector-alert:${collectorKey(p.collector)}${large ? ':large' : ''}`
  const ttlS = large ? UNKNOWN_COLLECTOR_LARGE_WINDOW_S : UNKNOWN_COLLECTOR_ALERT_WINDOW_S
  const nowMs = Date.now()
  // Claim first with the SHORT window, extend to the full window only after a
  // channel confirmed delivery. If the invocation is cancelled mid-send (or no
  // channel confirms), the contract is suppressed for at most the short
  // window, never for the full one without an alert having gone out.
  const claimUntil = new Date(nowMs + UNKNOWN_COLLECTOR_RETRY_AFTER_FAILED_DELIVERY_S * 1000).toISOString()
  // One atomic CAS takes the send right, so concurrent payments cannot all fire.
  const won = await casUpdate<boolean>(env, key, (cur) => {
    const end = cur ? Date.parse(cur) : NaN
    if (Number.isFinite(end) && end > nowMs) return { op: 'noop', result: false }
    return { op: 'set', value: claimUntil, result: true }
  })
  if (!won) return
  const delivered = await sendAlert(env, redactForAlert(buildUnknownCollectorAlert({ ...p, large })))
  if (delivered) {
    const fullUntil = new Date(nowMs + ttlS * 1000).toISOString()
    await casUpdate<void>(env, key, (cur) =>
      cur === claimUntil ? { op: 'set', value: fullUntil, result: undefined } : { op: 'noop', result: undefined },
    )
  }
}

/**
 * Inspect one pay-invoice response. Known collector or no field: returns at
 * once with no I/O. Unknown collector: alerts (deduped). Never throws, never
 * waits longer than `budgetMs`; a slower alert keeps running, registered with
 * `waitUntil` when the caller has an execution context. Without one it may be
 * cancelled when the invocation ends; the dedupe window then only covers the
 * short claim, so the next payment alerts again.
 */
export async function watchSignedCollector(
  env: Env,
  p: {
    invoiceId: string
    line: PayLine
    ref?: string
    signerStatus: number
    body: unknown
    /** When given, the alert is registered so it outlives the caller's response. */
    waitUntil?: (p: Promise<unknown>) => void
  },
  budgetMs: number = COLLECTOR_ALERT_BUDGET_MS,
): Promise<void> {
  let collector: SignedCollector | null
  try {
    collector = parseSignedCollector(p.body)
    if (!collector || isKnownCollector(collector)) return
  } catch {
    return
  }
  const work = alertUnknownCollector(env, {
    collector,
    invoiceId: p.invoiceId,
    line: p.line,
    ref: p.ref,
    signerStatus: p.signerStatus,
  }).catch((e) => {
    console.warn(`[collector-watch] alert error (non-fatal): ${maskHex(e instanceof Error ? e.message : String(e))}`)
  })
  try {
    p.waitUntil?.(work)
  } catch {
    // no execution context: the claim-then-extend window above bounds the loss
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs)
  })
  try {
    await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
