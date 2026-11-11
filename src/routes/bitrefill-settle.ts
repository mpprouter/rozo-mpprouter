/**
 * Bitrefill funder model: settlement (webhook) and reconciliation (cron).
 *
 * Contract with pay-invoice (provider "bitrefill"): see the identical text at
 * the top of both PR bodies and bitrefill-binding.ts. In short:
 *   - Only a merchant_openrouter order bitrefill_<uuid> that intents has PAID
 *     OUT to the funder is paid, and only for the invoice amount frozen at
 *     create time (metadata.bitrefill, HMAC bound). The router re-checks all of
 *     it here; pay-invoice re-checks it again from its own order read.
 *   - Only invoices on BITREFILL_FUNDER_ALLOWED_INVOICES (or "*") are paid;
 *     any other is deferred before the ledger, the gate or pay-invoice.
 *   - At most one pay-invoice request per invoice: the same non re-entrant
 *     exec gate as the Coinbase line (coinbase-exec-gate.ts). Order before a
 *     send: gate -> daily reservation -> persist `paying` -> call. Every exit
 *     before the call releases what was taken; the gate is never released
 *     once the request was sent. The gate holder is unique per attempt.
 *   - Unknown outcomes (`pay_invoice_unknown`, or `paying` older than 10 min)
 *     are resolved ONLY by reading USDC.authorizationState(funder, nonce);
 *     "unused" needs two independent RPC endpoints. Nothing here ever sends a
 *     second request, and nothing in the router re-pays a Bitrefill invoice.
 *     The nonce is deterministic per invoice, so even a manual re-pay (direct
 *     admin call to pay-invoice, private ops runbook) can never execute twice.
 */
import type { Env } from '../index'
import { alertSinkConfigured, sendAlert } from '../utils/alert'
import { redactForAlert } from '../utils/alert-redaction'
import { FALLBACK_BASE_RPCS, getBaseUsdcBalance, redactRpcUrl } from '../utils/base-usdc-balance'
import { acquireCoinbaseExecGate, releaseCoinbaseExecGate } from './coinbase-exec-gate'
import { checkoutDeliveryPaused } from './checkout-control'
import { OPENROUTER_APP_ID, readPaymentStatus } from './existing-order'
import { bitrefillDailyCapAtomic, releaseBitrefillDaily, reserveBitrefillDaily } from './stripe-fulfillment'
import { computeServiceFeeAtomic, parseUsdcAtomic } from './checkout-web-pricing'
import { BITREFILL_MAX_USDC, BITREFILL_ORDER_PREFIX, bitrefillInvoiceAllowed, isBitrefillOrderId } from './bitrefill-invoice'
import {
  BITREFILL_FEE_BPS,
  bitrefillNonce,
  bitrefillReceiverRefusal,
  computeBitrefillBinding,
  readBitrefillFacts,
  type BitrefillFrozenFacts,
} from './bitrefill-binding'
import {
  type CoinbaseEventInput,
  type FulfillmentRecord,
  FUNDER_WALLET,
  TERMINAL_STATUSES,
  deferForCheckoutPause,
  deliveredReportEnabled,
  deliveredReportStillPending,
  emptyRecord,
  forgetWebhookEvent,
  fetchRozoPaymentById,
  loadRecord,
  maskAddresses,
  reportDeliveredToRozo,
  saveRecordGuarded,
} from './webhook'

export const BITREFILL_PAY_INVOICE_URL = 'https://agentapi.rozo.ai/pay-invoice'
export const BITREFILL_PAY_TIMEOUT_MS = 60_000
export const BITREFILL_PRESIGN_RETRY_DELAY_MS = 2_000
/** Do not start a payment with less than this left on the invoice (pay-invoice uses the same). */
export const BITREFILL_SEND_MIN_REMAINING_MS = 2 * 60 * 1000
/** pay-invoice never signs an authorization valid for longer than this. */
export const BITREFILL_MAX_AUTH_VALIDITY_MS = 300 * 1000
/** Slack after validBefore before "unused" is treated as final. */
export const BITREFILL_UNKNOWN_GRACE_MS = 120 * 1000
export const BITREFILL_PAYING_STALE_MS = 10 * 60 * 1000
export const BITREFILL_SWEEP_MAX_RECORDS = 20
/** Stop starting new re-drives after this much wall time in one sweep run (cron runs every 2 min). */
export const BITREFILL_SWEEP_REDRIVE_BUDGET_MS = 60 * 1000
/** pay-invoice never signs a validBefore later than the invoice expiry minus this. */
export const BITREFILL_EXPIRY_MARGIN_MS = 60 * 1000
/** Per-endpoint timeout of one authorizationState read. */
export const BITREFILL_RPC_TIMEOUT_MS = 10 * 1000
export const BITREFILL_DELIVERED_MAX_ATTEMPTS = 5
// Computed at call time: bitrefill-invoice.ts and this module import each
// other through webhook.ts, so its exports are not initialized at load.
const kvPrefix = () => `invoice-fulfillment:${BITREFILL_ORDER_PREFIX}`
const ORDER_PAID_OUT: ReadonlySet<string> = new Set(['payment_payout_completed', 'payment_completed'])

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function invoiceIdOf(plId: string): string {
  return plId.slice(BITREFILL_ORDER_PREFIX.length)
}

function decimalAtomic(v: unknown): bigint | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v)
  if (!/^\d+(?:\.\d{1,6})?$/.test(s)) return null
  return parseUsdcAtomic(s)
}

async function sendBitrefillAlert(env: Env, lines: string[]): Promise<void> {
  try {
    const text = maskAddresses([...lines, `At: ${new Date().toISOString()}`].join('\n'))
    if (!alertSinkConfigured(env)) {
      console.warn(`[bitrefill-settle] alert SKIPPED (no alert channel configured): ${text}`)
      return
    }
    await sendAlert(env, redactForAlert(text))
  } catch (err) {
    console.warn(`[bitrefill-settle] alert error (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** F3: the only manual re-pay path; there is no admin route that clears the exec gate for Bitrefill. */
const MANUAL_REPAY_TEXT =
  'Nothing in the router re-pays a Bitrefill invoice. A manual re-pay is a direct admin call to pay-invoice with the same ids (same nonce) following the private ops runbook, only after the nonce reads unused past validBefore and while the invoice is still open; otherwise refund the payer by hand.'

function fmt(atomic: bigint | string | null | undefined): string {
  if (atomic === null || atomic === undefined) return '?'
  try {
    return (Number(BigInt(atomic)) / 1e6).toFixed(2)
  } catch {
    return '?'
  }
}

// ── Order verification (router side) ────────────────────────────────────────

export type BitrefillOrderCheck =
  | { ok: true; facts: BitrefillFrozenFacts }
  | { ok: false; terminal: boolean; reason: string }

/**
 * Re-read the order and check, before any send: it is the merchant_openrouter
 * order for this invoice, marked Bitrefill with a valid binding, paid out to
 * the funder on Base for at least invoice + fee. Not terminal = could not
 * verify right now.
 */
export async function verifyBitrefillOrder(
  env: Env,
  plId: string,
  rozoPaymentId: string | null,
): Promise<BitrefillOrderCheck> {
  if (!rozoPaymentId) return { ok: false, terminal: true, reason: 'webhook carries no Rozo payment id' }
  const order = await fetchRozoPaymentById(env, rozoPaymentId)
  if (!order || typeof order !== 'object') return { ok: false, terminal: false, reason: 'Rozo order unreadable' }
  if (order.appId !== OPENROUTER_APP_ID) return { ok: false, terminal: true, reason: `order appId ${order.appId ?? 'missing'} is not ${OPENROUTER_APP_ID}` }
  if (order.orderId !== plId) return { ok: false, terminal: true, reason: 'order belongs to a different invoice' }
  const facts = readBitrefillFacts(order)
  if (!facts) return { ok: false, terminal: true, reason: 'order is not marked as a v1 Bitrefill order' }
  if (facts.invoiceId !== invoiceIdOf(plId)) return { ok: false, terminal: true, reason: 'frozen invoiceId differs from the order id' }
  if (!env.PAYINVOICE_ADMIN_SECRET) return { ok: false, terminal: false, reason: 'PAYINVOICE_ADMIN_SECRET not configured' }
  const expected = await computeBitrefillBinding(env.PAYINVOICE_ADMIN_SECRET, facts)
  if (expected !== facts.binding) return { ok: false, terminal: true, reason: 'binding HMAC does not verify' }
  const refusal = bitrefillReceiverRefusal(facts.address)
  if (refusal) return { ok: false, terminal: true, reason: `receiver refused: ${refusal}` }
  if (facts.amountAtomic <= 0n || facts.amountAtomic > BigInt(BITREFILL_MAX_USDC) * 1_000_000n) {
    return { ok: false, terminal: true, reason: 'invoice amount outside (0, cap]' }
  }
  if (
    facts.feeBps !== BITREFILL_FEE_BPS ||
    facts.serviceFeeAtomic !== computeServiceFeeAtomic(facts.amountAtomic, facts.feeBps) ||
    facts.callerPaysAtomic !== facts.amountAtomic + facts.serviceFeeAtomic
  ) {
    return { ok: false, terminal: true, reason: 'frozen pricing is not invoice + 1%' }
  }
  const status = readPaymentStatus(order) ?? ''
  if (!ORDER_PAID_OUT.has(status)) return { ok: false, terminal: false, reason: `order status ${status || 'missing'} is not paid out yet` }
  const dest = order.destination ?? {}
  if (String(dest.receiverAddress ?? '').toLowerCase() !== FUNDER_WALLET.toLowerCase()) {
    return { ok: false, terminal: true, reason: 'order destination is not the funder' }
  }
  if (String(dest.chainId ?? '') !== '8453' || String(dest.tokenSymbol ?? '').toUpperCase() !== 'USDC') {
    return { ok: false, terminal: true, reason: 'order destination is not Base USDC' }
  }
  if (typeof dest.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(dest.txHash)) {
    return { ok: false, terminal: false, reason: 'order payout tx hash not visible yet' }
  }
  let delivered = decimalAtomic(dest.amount)
  if (delivered === null) return { ok: false, terminal: false, reason: 'order destination amount unreadable' }
  const actual = order.payout?.actualAmount
  if (actual !== undefined && actual !== null) {
    const a = decimalAtomic(actual)
    if (a === null) return { ok: false, terminal: false, reason: 'order payout.actualAmount unreadable' }
    if (a < delivered) delivered = a
  }
  if (delivered < facts.callerPaysAtomic) {
    return { ok: false, terminal: true, reason: `payout ${delivered} below invoice + fee ${facts.callerPaysAtomic}` }
  }
  return { ok: true, facts }
}

// ── pay-invoice call ────────────────────────────────────────────────────────

export interface BitrefillPayResult {
  status: number // 0 = transport error / timeout
  body: any
}

export async function callBitrefillPayInvoice(
  env: Env,
  payload: Record<string, unknown>,
  timeoutMs = BITREFILL_PAY_TIMEOUT_MS,
): Promise<BitrefillPayResult> {
  try {
    const resp = await fetch(BITREFILL_PAY_INVOICE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await resp.text()
    let body: any = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    return { status: resp.status, body }
  } catch (err: any) {
    return { status: 0, body: { error: err?.name ?? 'fetch threw' } }
  }
}

export type BitrefillPayVerdict =
  | 'paid'
  | 'refused'
  | 'expired'
  | 'presign_transient'
  | 'unknown'
  // 409 NONCE_USED_WITHOUT_PAY_LOG (nonce consumed, no matching pay log row)
  // or 409 NONCE_USED_TRANSFER_NOT_PROVEN (nonce consumed, transfer not
  // proven). Humans check the chain; gate and ledger kept.
  | 'nonce_used_unlogged'

/** Map a pay-invoice answer onto the contract table. Anything unproven is unknown. */
export function classifyBitrefillPayResult(r: BitrefillPayResult): BitrefillPayVerdict {
  const b = r.body
  const fromUs = b && typeof b === 'object' && b.provider === 'bitrefill'
  if (r.status === 200 && fromUs && b.ok === true && (b.status === 'paid' || b.status === 'already_paid')) return 'paid'
  // pay-invoice's generic pre-branch refusals (402 when the admin secret is
  // missing or wrong, 500 when its key is missing or malformed) carry
  // signed:false but no provider tag: nothing was signed.
  if (b && typeof b === 'object' && !fromUs && b.signed === false && (r.status === 402 || r.status === 500)) return 'refused'
  // pay-invoice's own allowlist disagrees with ours (403, signed:false, before
  // any order read). Accepted with or without the provider tag: signed:false
  // plus this exact code means nothing was signed.
  if (
    r.status === 403 && b && typeof b === 'object' && b.signed === false &&
    (b.code === 'bitrefill_invoice_not_allowlisted' || b.error === 'bitrefill_invoice_not_allowlisted')
  ) {
    return 'refused'
  }
  if (fromUs && b.signed === false && b.ok === false) {
    if (r.status === 409 && b.code === 'INVOICE_EXPIRED') return 'expired'
    // An earlier signature for this invoice can still execute: NOT a refusal.
    // Treated like an unknown outcome (gate and ledger kept, sweep resolves by
    // nonce after validBefore / the invoice expiry).
    if (r.status === 409 && b.code === 'PAY_IN_FLIGHT') return 'unknown'
    if (r.status === 409 && (b.code === 'NONCE_USED_WITHOUT_PAY_LOG' || b.code === 'NONCE_USED_TRANSFER_NOT_PROVEN')) return 'nonce_used_unlogged'
    // The signer could not prove the transfer from the chain right now: the
    // authorization may have executed. Unknown (gate and ledger kept, no
    // immediate retry); the sweep resolves it under the round 3 rule.
    if (r.status === 503 && b.code === 'TRANSFER_PROOF_UNAVAILABLE') return 'unknown'
    // 422 PAYOUT_NOT_PROVEN_ON_CHAIN and every other provider-tagged 4xx
    // (signed:false) is a definite refusal.
    if (r.status >= 400 && r.status < 500 && r.status !== 408) return 'refused'
    if (r.status === 503) return 'presign_transient'
  }
  return 'unknown'
}

// ── Webhook settlement ──────────────────────────────────────────────────────

export async function settleBitrefillFunderEvent(
  env: Env,
  input: CoinbaseEventInput,
): Promise<Record<string, unknown>> {
  const { eventId, eventType, plId, rozoPaymentId, evt, now } = input
  const nowIso = () => new Date().toISOString()

  // Legacy direct orders (wallet_bitrefillpay) settle as a Rozo payout to the
  // Bitrefill address; the router has nothing to pay. Never write a record.
  const eventAppId = evt.data?.appId ?? null
  if (eventAppId && eventAppId !== OPENROUTER_APP_ID) {
    return { ok: true, ignored: 'bitrefill order settles directly', plId }
  }

  if (!eventAppId && rozoPaymentId) {
    const order = await fetchRozoPaymentById(env, rozoPaymentId)
    if (order && typeof order === 'object' && order.appId && order.appId !== OPENROUTER_APP_ID) {
      return { ok: true, ignored: 'bitrefill order settles directly', plId }
    }
  }

  let rec = await loadRecord(env, plId)
  if (!rec) rec = emptyRecord(plId)
  if (rec.rozoPaymentId && rozoPaymentId && rec.rozoPaymentId !== rozoPaymentId) {
    rec.events.push({ kind: 'duplicate_payment', at: nowIso(), event_id: eventId, detail: { extra: rozoPaymentId } })
    await saveRecordGuarded(env, plId, rec)
    await sendBitrefillAlert(env, [
      '[MPP Router] 🚨 Bitrefill invoice has a second Rozo order',
      `Invoice: ${plId}; recorded ${rec.rozoPaymentId.slice(0, 8)}, extra ${rozoPaymentId.slice(0, 8)}`,
      'The extra order is never used to pay. Refund it by hand.',
    ])
    return { ok: true, duplicate_payment: true, plId }
  }
  if (!rec.rozoPaymentId && rozoPaymentId) rec.rozoPaymentId = rozoPaymentId
  if (!rec.webhookEventIds.includes(eventId)) rec.webhookEventIds.push(eventId)
  rec.events.push({
    kind: eventType,
    at: new Date(now).toISOString(),
    event_id: eventId,
    detail: { dest_tx: evt.data?.destination?.txHash ?? null },
  })

  if (TERMINAL_STATUSES.has(rec.status)) {
    await saveRecordGuarded(env, plId, rec)
    return { ok: true, alreadyTerminal: rec.status, plId }
  }
  // Only a completed payout proves the funder holds the money.
  if (eventType !== 'payment_payout_completed' && eventType !== 'payment_completed') {
    await saveRecordGuarded(env, plId, rec)
    return { ok: true, waiting: 'payout', eventType, plId }
  }
  if (rec.status === 'paying') {
    await saveRecordGuarded(env, plId, rec)
    return { ok: true, already_paying: true, plId }
  }
  // Persist the payout event first: every later deferral (and the sweep's
  // bounded re-drive, which keys on a saved payout event) depends on it.
  rec = await saveRecordGuarded(env, plId, rec)

  if (String(env.BITREFILL_FUNDER_SEND_ENABLED ?? '').toLowerCase() !== 'true') {
    const alert = !rec.alertedStuck
    rec.alertedStuck = true
    rec.events.push({ kind: 'bitrefill_funder_send_disabled', at: nowIso(), event_id: eventId })
    await saveRecordGuarded(env, plId, rec)
    // Nothing was sent: a replay of this same event after the switch is
    // turned on must be processed.
    await forgetWebhookEvent(env, eventId)
    if (alert) {
      await sendBitrefillAlert(env, [
        '[MPP Router] 🚨 Bitrefill invoice NOT paid: funder send is switched off',
        `Invoice: ${plId}, Rozo payment ${(rozoPaymentId ?? '?').slice(0, 8)}`,
        'The payer paid and the funder holds the money. Turn BITREFILL_FUNDER_SEND_ENABLED on and replay the webhook, or refund by hand.',
      ])
    }
    return { ok: true, deferred: 'funder_send_disabled', plId }
  }

  // Single-invoice isolation: a non-listed invoice is deferred exactly like
  // the switch-off case (no reservation, no gate, no pay-invoice call). Adding
  // it to the list (or "*") later lets the sweep re-drive this payout while it
  // is younger than 2 hours.
  if (!bitrefillInvoiceAllowed(env, invoiceIdOf(plId))) {
    const alert = !rec.alertedStuck
    rec.alertedStuck = true
    rec.events.push({ kind: 'bitrefill_invoice_not_allowlisted', at: nowIso(), event_id: eventId })
    await saveRecordGuarded(env, plId, rec)
    await forgetWebhookEvent(env, eventId)
    if (alert) {
      await sendBitrefillAlert(env, [
        '[MPP Router] 🚨 Bitrefill invoice NOT paid: invoice is not on BITREFILL_FUNDER_ALLOWED_INVOICES',
        `Invoice: ${plId}, Rozo payment ${(rozoPaymentId ?? '?').slice(0, 8)}`,
        'The payer paid and the funder holds the money. Adding the invoice to the list (or "*") within 2 hours of the payout lets the sweep pay it automatically; otherwise refund by hand.',
      ])
    }
    return { ok: true, deferred: 'invoice_not_allowlisted', plId }
  }

  if (await checkoutDeliveryPaused(env)) {
    return deferForCheckoutPause(env, plId, rec, eventType, eventId)
  }

  const check = await verifyBitrefillOrder(env, plId, rozoPaymentId)
  if (!check.ok) {
    if (check.terminal) {
      rec.status = 'order_binding_failed'
      rec.failureReason = `bitrefill order binding: ${check.reason}`
      rec.events.push({ kind: 'order_binding_failed', at: nowIso(), event_id: eventId, detail: { reason: check.reason } })
      const saved = await saveRecordGuarded(env, plId, rec)
      await sendBitrefillAlert(env, [
        '[MPP Router] 🚨 Bitrefill invoice REFUSED: Rozo order does not match',
        `Invoice: ${plId}`,
        `Reason: ${check.reason}`,
        'Nothing was paid. Check the order by hand before any manual payment.',
      ])
      return { ok: true, status: saved.status, plId, reason: check.reason }
    }
    rec.events.push({ kind: 'order_binding_deferred', at: nowIso(), event_id: eventId, detail: { reason: check.reason } })
    await saveRecordGuarded(env, plId, rec)
    await forgetWebhookEvent(env, eventId)
    return { ok: true, deferred: 'order_binding_unverified', reason: check.reason, plId }
  }
  const facts = check.facts
  rec.invoiceAmountAtomic = facts.amountAtomic.toString()
  rec.bitrefill = {
    invoiceId: facts.invoiceId,
    nonce: bitrefillNonce(facts.invoiceId),
    address: facts.address,
    amountAtomic: facts.amountAtomic.toString(),
    expiresAt: facts.expiresAt,
    validBefore: rec.bitrefill?.validBefore ?? null,
    transaction: rec.bitrefill?.transaction ?? null,
  }

  // Late payin: the invoice can no longer be paid safely. Refunds are manual.
  if (Date.parse(facts.expiresAt) - Date.now() < BITREFILL_SEND_MIN_REMAINING_MS) {
    rec.status = 'manual_review'
    rec.failureReason = 'bitrefill invoice expired before the payout reached the funder (late payin)'
    const alert = !rec.alertedManualReview
    rec.alertedManualReview = true
    rec.events.push({ kind: 'bitrefill_late_payin', at: nowIso(), event_id: eventId, detail: { expiresAt: facts.expiresAt } })
    const saved = await saveRecordGuarded(env, plId, rec)
    if (alert) {
      await sendBitrefillAlert(env, [
        '[MPP Router] 🚨 Bitrefill invoice NOT paid: payin arrived after the invoice expired',
        `Invoice: ${plId} (${fmt(facts.amountAtomic)} USDC), expired ${facts.expiresAt}`,
        'Nothing was sent to Bitrefill. The funder holds the money; refund the payer by hand.',
      ])
    }
    return { ok: true, status: saved.status, plId, reason: 'late_payin' }
  }

  // Read-only pre-check; nothing is taken yet.
  const balance = (await getBaseUsdcBalance(FUNDER_WALLET, env.BASE_RPC_URL)).balance
  if (balance !== null && balance < facts.amountAtomic) {
    rec.status = 'failed_insufficient_balance'
    rec.failureReason = `funder balance ${balance} < invoice ${facts.amountAtomic}`
    rec.events.push({ kind: 'balance_check', at: nowIso(), detail: { balance: balance.toString(), sufficient: false } })
    await saveRecordGuarded(env, plId, rec)
    await forgetWebhookEvent(env, eventId)
    await sendBitrefillAlert(env, [
      '[MPP Router] 🚨 Bitrefill invoice BLOCKED: insufficient funder balance',
      `Invoice: ${plId} (${fmt(facts.amountAtomic)} USDC), funder balance ${fmt(balance)} USDC`,
      'Top up the funder, then replay the webhook before the invoice expires.',
    ])
    return { ok: true, deferred: 'insufficient_balance', plId }
  }

  // Order before a send: gate -> reservation -> persist `paying` -> call.
  // Every exit before the call releases what was taken. The holder is unique
  // per attempt, so a release can never drop a gate another attempt holds
  // (webhook dedup stays keyed on the real event id).
  const gateHolder = `${eventId}#${crypto.randomUUID()}`
  let gate: Awaited<ReturnType<typeof acquireCoinbaseExecGate>>
  try {
    gate = await acquireCoinbaseExecGate(env, plId, gateHolder, new Date(), rozoPaymentId ?? undefined)
  } catch {
    // Nothing was sent. The CAS may or may not have committed: give back a
    // gate held by this attempt (no-op otherwise), keep the record
    // re-drivable, and let a replay of this event through.
    await releaseCoinbaseExecGate(env, plId, gateHolder).catch(() => false)
    rec.events.push({ kind: 'exec_gate_unavailable', at: nowIso(), event_id: eventId })
    await saveRecordGuarded(env, plId, rec)
    await forgetWebhookEvent(env, eventId)
    return { ok: true, deferred: 'exec_gate_unavailable', plId }
  }
  if (!gate.ok) {
    rec.events.push({ kind: 'exec_gate_held', at: nowIso(), event_id: eventId, detail: { holder: gate.holder.holder } })
    await saveRecordGuarded(env, plId, rec)
    return { ok: true, exec_gate_held: true, plId }
  }
  const releaseGate = () => releaseCoinbaseExecGate(env, plId, gateHolder).catch(() => false)
  if (await checkoutDeliveryPaused(env)) {
    await releaseGate()
    return deferForCheckoutPause(env, plId, rec, eventType, eventId)
  }

  // Daily ledger (always enforced for this line; DO error = fail closed).
  // Taken only while the gate is held. The reservation is held under this
  // invoice (stripe-fulfillment.ts reserveBitrefillDaily): idempotent per
  // invoice and day, and a release removes exactly what this invoice holds.
  const spendDay = new Date()
  let reservation: 'ok' | 'replay' | null
  try {
    reservation = await reserveBitrefillDaily(env, spendDay, plId, facts.amountAtomic)
  } catch {
    // The CAS may or may not have committed. Release exactly this invoice's
    // hold (no-op if it did not commit). If that release fails too, the hold
    // stays attributable: the next attempt the same day answers 'replay'
    // (no second increment) and any later refusal releases it.
    const released = await releaseBitrefillDaily(env, spendDay, plId).then(() => true, () => false)
    await releaseGate()
    rec.events.push({
      kind: released ? 'daily_cap_unavailable' : 'daily_reservation_uncertain',
      at: nowIso(),
      event_id: eventId,
      detail: { day: spendDay.toISOString().slice(0, 10) },
    })
    await saveRecordGuarded(env, plId, rec)
    await forgetWebhookEvent(env, eventId)
    return { ok: true, deferred: 'daily_cap_unavailable', plId }
  }
  if (reservation === null) {
    await releaseGate()
    rec.status = 'failed_insufficient_balance'
    rec.failureReason = `bitrefill daily cap ${bitrefillDailyCapAtomic(env)} reached`
    rec.events.push({ kind: 'daily_cap_reached', at: nowIso(), event_id: eventId })
    await saveRecordGuarded(env, plId, rec)
    await forgetWebhookEvent(env, eventId)
    await sendBitrefillAlert(env, [
      '[MPP Router] 🚨 Bitrefill invoice BLOCKED: daily cap reached',
      `Invoice: ${plId} (${fmt(facts.amountAtomic)} USDC)`,
      'Nothing was paid. Raise BITREFILL_SETTLE_DAILY_CAP_USD or wait for 00:00 UTC, then replay the webhook before the invoice expires.',
    ])
    return { ok: true, deferred: 'daily_cap_reached', plId }
  }
  let reserved = true
  const releaseReservation = async () => {
    if (!reserved) return
    reserved = false
    await releaseBitrefillDaily(env, spendDay, plId).catch(() => false)
  }

  rec.status = 'paying'
  rec.payingAt = nowIso()
  try {
    rec = await saveRecordGuarded(env, plId, rec)
  } catch (err) {
    await releaseReservation()
    await releaseGate()
    throw err
  }
  if (rec.status !== 'paying') {
    await releaseReservation()
    await releaseGate()
    return { ok: true, alreadyTerminal: rec.status, plId }
  }

  // From here the gate is never released.
  const payload = {
    provider: 'bitrefill',
    bitrefill_invoice_id: facts.invoiceId,
    rozo_payment_id: rozoPaymentId,
    expected: { address: facts.address, amount_atomic: facts.amountAtomic.toString() },
  }
  let result = await callBitrefillPayInvoice(env, payload)
  let verdict = classifyBitrefillPayResult(result)
  if (verdict === 'presign_transient') {
    // Nothing was signed: one retry under the same gate is safe (and the
    // nonce is fixed per invoice regardless).
    await sleepMs(BITREFILL_PRESIGN_RETRY_DELAY_MS)
    result = await callBitrefillPayInvoice(env, payload)
    verdict = classifyBitrefillPayResult(result)
  }
  const vb = Number(result.body?.validBefore)
  if (rec.bitrefill && Number.isSafeInteger(vb) && vb > 0) rec.bitrefill.validBefore = vb
  if (rec.bitrefill && typeof result.body?.transaction === 'string') rec.bitrefill.transaction = result.body.transaction

  const detail = { status: result.status, code: result.body?.code ?? null, payStatus: result.body?.status ?? null }
  if (verdict === 'paid') {
    rec.status = 'paid'
    rec.paidAt = nowIso()
    rec.coinbaseResult = { provider: 'bitrefill', status: result.body.status, transaction: result.body.transaction ?? null }
    rec.events.push({ kind: 'pay_invoice_succeeded', at: rec.paidAt, detail })
  } else if (verdict === 'expired') {
    await releaseReservation()
    rec.status = 'manual_review'
    rec.failureReason = 'pay-invoice refused: Bitrefill invoice expired (late payin), nothing signed'
    rec.alertedManualReview = true
    rec.events.push({ kind: 'bitrefill_late_payin', at: nowIso(), detail })
  } else if (verdict === 'nonce_used_unlogged') {
    // Gate and ledger kept: the authorization slot is consumed on chain.
    // The sweep keeps re-checking (rule A): only a transfer proof bound to
    // this authorization (AuthorizationUsed(funder, nonce) and the exact
    // Transfer to the frozen address in one successful transaction, two
    // hosts) can flip it to paid. That proof shows the invoice WAS paid by
    // this nonce, whatever pay-invoice's log or own proof said, so it is
    // safe for both NONCE_USED_WITHOUT_PAY_LOG and
    // NONCE_USED_TRANSFER_NOT_PROVEN; a disproof stops the re-check.
    rec.bitrefillUnknownOrigin = true
    rec.status = 'manual_review'
    rec.failureReason = result.body?.code === 'NONCE_USED_TRANSFER_NOT_PROVEN'
      ? 'pay-invoice: nonce consumed on chain, transfer not proven (NONCE_USED_TRANSFER_NOT_PROVEN)'
      : 'pay-invoice: nonce already used on chain but no matching pay log row (NONCE_USED_WITHOUT_PAY_LOG)'
    rec.alertedManualReview = true
    rec.events.push({ kind: 'bitrefill_nonce_used_without_pay_log', at: nowIso(), detail })
  } else if (verdict === 'refused' || verdict === 'presign_transient') {
    await releaseReservation()
    rec.status = 'failed_pay_invoice'
    rec.failureReason = `pay-invoice bitrefill ${result.status} ${result.body?.code ?? ''} (nothing signed)`.trim()
    rec.events.push({ kind: 'pay_invoice_failed', at: nowIso(), detail })
  } else {
    rec.status = 'pay_invoice_unknown'
    rec.failureReason = `pay-invoice bitrefill ${result.status} (outcome unknown)`
    rec.events.push({ kind: 'pay_invoice_unknown', at: nowIso(), detail })
  }
  rec = await saveRecordGuarded(env, plId, rec)

  if (verdict !== 'paid') {
    await sendBitrefillAlert(env, [
      verdict === 'unknown'
        ? '[MPP Router] 🚨 Bitrefill payment UNKNOWN: sent, outcome not known'
        : verdict === 'nonce_used_unlogged'
          ? result.body?.code === 'NONCE_USED_TRANSFER_NOT_PROVEN'
            ? '[MPP Router] 🚨 Bitrefill invoice needs a human: nonce consumed, transfer not proven'
            : '[MPP Router] 🚨 Bitrefill invoice needs a human: nonce used on chain without a pay log row'
          : '[MPP Router] 🚨 Bitrefill invoice NOT paid',
      `Invoice: ${plId} (${fmt(facts.amountAtomic)} USDC)`,
      `Reason: ${rec.failureReason}`,
      verdict === 'unknown'
        ? 'Do NOT re-pay and do NOT refund. The cron sweep reads authorizationState(funder, nonce) from two RPC sources and moves it to paid or manual_review.'
        : verdict === 'expired'
          ? 'Nothing was sent. The funder holds the money; refund the payer by hand.'
          : verdict === 'nonce_used_unlogged'
            ? 'The authorization for this invoice was consumed on chain. Check the chain by hand (who executed it, to which address, how much). Do not re-pay with the same nonce, do not refund until checked.'
            : `Nothing was signed. ${MANUAL_REPAY_TEXT}`,
    ])
  } else {
    await reportDelivered(env, plId, rec)
  }
  return { ok: true, plId, status: rec.status, paid: rec.status === 'paid' }
}

// Overlapping sweep / webhook runs may both reach this before either saves
// deliveredReported (KV is not atomic). That is safe without a router lock:
// intents POST /payments/<id>/delivered is idempotent. Its handler
// (rozo-intents-api supabase/functions/payment-api/merchant-delivered.ts:146-153)
// stamps merchant_delivered_at with one conditional UPDATE
// (... .is('merchant_delivered_at', null)), and a repeat answers 200 with the
// original time and alreadyDelivered:true (:205-211). The Coinbase line uses
// the same reportDeliveredToRozo with no lock either (webhook.ts, coinbase-sweep.ts).
async function reportDelivered(env: Env, plId: string, rec: FulfillmentRecord, now = Date.now()): Promise<void> {
  if (rec.status !== 'paid' || rec.deliveredReported || !rec.rozoPaymentId || !deliveredReportEnabled(env)) return
  const rep = await reportDeliveredToRozo(env, rec.rozoPaymentId, plId)
  const pending = deliveredReportStillPending(rep, rec, now)
  if (rep.ok) rec.deliveredReported = true
  else if (!pending) rec.deliveredReportAttempts = (rec.deliveredReportAttempts ?? 0) + 1
  else rec.deliveredPendingAt = new Date(now).toISOString()
  const giveUp =
    !rep.ok && (rec.deliveredReportAttempts ?? 0) >= BITREFILL_DELIVERED_MAX_ATTEMPTS && !rec.alertedDeliveredGiveUp
  if (giveUp) rec.alertedDeliveredGiveUp = true
  rec.events.push({
    kind: rep.ok ? 'delivered_reported' : pending ? 'delivered_report_pending' : 'delivered_report_failed',
    at: new Date(now).toISOString(),
    detail: { status: rep.status },
  })
  await saveRecordGuarded(env, plId, rec)
  if (giveUp) {
    await sendBitrefillAlert(env, [
      `[MPP Router] ⚠️ Bitrefill delivery report to Rozo failed ${rec.deliveredReportAttempts} times (last HTTP ${rep.status})`,
      `Invoice: ${plId}, Rozo payment ${rec.rozoPaymentId.slice(0, 8)}`,
      'The Bitrefill invoice IS paid; only the Rozo delivered marker is missing. Report it by hand (POST /payments/<id>/delivered).',
    ])
  }
}

// ── Chain read: USDC.authorizationState(funder, nonce) ─────────────────────
//
// Evidence rules (fix batch round 3). An RPC error, timeout, malformed answer
// or HTTP error is never evidence either way.
//   nonce quorum : "used" = at least 2 distinct hosts read authorizationState
//                  true and none false; "unused" the mirror image; anything
//                  else is no decision this round.
//   paid         : nonce quorum used AND a transfer proof BOUND TO THIS
//                  AUTHORIZATION confirmed by at least 2 distinct hosts (one
//                  successful transaction whose receipt holds, both from the
//                  USDC contract and not removed, AuthorizationUsed(funder,
//                  nonce) and Transfer(funder -> frozen address, exact frozen
//                  amount)); see readBitrefillTransferProof. There is no
//                  "paid on the nonce quorum alone" path.
//   manual_review: nonce quorum unused past deadline + grace; or used with the
//                  proof disproven (stop re-checking); or used with the proof
//                  unavailable past deadline + grace (keep re-checking).
// Host distinctness is by hostname only: it does not prove independent
// operators or independent chain data. BASE_RPC_URL should be a provider we
// pay for; the public fallbacks are best effort.
// The signer's own 200 paid / already_paid answer stays sufficient at settle
// (the signer proves the transfer from the receipt and the nonce first).

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
// keccak256("authorizationState(address,bytes32)")[0:4]
export const AUTHORIZATION_STATE_SELECTOR = '0xe94a0102'
// keccak256("Transfer(address,address,uint256)")
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// keccak256("AuthorizationUsed(address,bytes32)"), pinned by a viem test.
export const AUTHORIZATION_USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'
/** Same threshold for the nonce quorum (both directions) and the transfer proof. */
export const BITREFILL_CHAIN_QUORUM = 2
/** Base produces a block every 2 s. */
const BASE_BLOCK_MS = 2_000
/** The log window starts this long before payingAt (signing happens after payingAt). */
const LOG_WINDOW_LEAD_MS = 10 * 60 * 1000
/** Further safety margin in blocks below that lower bound. */
const LOG_WINDOW_MARGIN_BLOCKS = 600
/** The log window ends this long after the authorization deadline (plus a block margin). */
const LOG_WINDOW_TAIL_MS = 5 * 60 * 1000
const LOG_WINDOW_TAIL_BLOCKS = 150
/** Total time one host may spend on one record's proof (each call also has its own 10 s timeout). */
export const BITREFILL_PROOF_HOST_BUDGET_MS = 20 * 1000
/**
 * Widest eth_getLogs window we ask for (~5 h of Base blocks). The window is
 * anchored to the payment ([payingAt - 10 min, deadline + 5 min] plus block
 * margins, see paymentLogWindow), so for a 60-minute invoice it is about
 * 3,000 blocks however old the record is. Public RPC log range limits are
 * unverified. A wider window is "proof unavailable" (never paid); a recorded
 * transaction hash needs no window.
 */
export const BITREFILL_LOG_MAX_BLOCKS = 9_000

function rpcEndpoints(env: Env): Array<{ host: string; url: string }> {
  const candidates = env.BASE_RPC_URL ? [env.BASE_RPC_URL, ...FALLBACK_BASE_RPCS] : [...FALLBACK_BASE_RPCS]
  const byHost = new Map<string, string>()
  for (const url of candidates) {
    try {
      const host = new URL(url).host
      if (!byHost.has(host)) byHost.set(host, url)
    } catch {
      // unparseable URL: skipped
    }
  }
  return [...byHost.entries()].map(([host, url]) => ({ host, url }))
}

/** One JSON-RPC call. ok only for an HTTP 200 with a `result` field and no `error`. */
async function rpcCall(url: string, method: string, params: unknown[]): Promise<{ ok: true; result: unknown } | { ok: false }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(BITREFILL_RPC_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false }
    const json = (await res.json()) as { result?: unknown; error?: unknown }
    if (!json || typeof json !== 'object' || json.error !== undefined || !('result' in json)) return { ok: false }
    return { ok: true, result: json.result }
  } catch {
    console.warn(`[bitrefill-settle] ${method} via ${redactRpcUrl(url)} failed`)
    return { ok: false }
  }
}

export interface AuthorizationQuorumRead {
  /** true / false only under the symmetric quorum rule above; null = no decision this round. */
  used: boolean | null
  answers: Array<{ endpoint: string; used: boolean | null }>
}

/**
 * Read USDC.authorizationState(funder, nonce) at `latest` from every
 * configured endpoint (BASE_RPC_URL plus the public fallbacks, de-duplicated
 * by host), in parallel. Symmetric quorum: a decision needs two distinct hosts
 * agreeing and no host disagreeing.
 */
export async function readAuthorizationQuorum(env: Env, funder: string, nonce: string): Promise<AuthorizationQuorumRead> {
  const data =
    AUTHORIZATION_STATE_SELECTOR +
    funder.toLowerCase().replace(/^0x/, '').padStart(64, '0') +
    nonce.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const answers = await Promise.all(
    rpcEndpoints(env).map(async ({ host, url }) => {
      const r = await rpcCall(url, 'eth_call', [{ to: BASE_USDC, data }, 'latest'])
      if (r.ok && typeof r.result === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r.result)) {
        return { endpoint: host, used: BigInt(r.result) !== 0n }
      }
      return { endpoint: host, used: null }
    }),
  )
  const usedN = answers.filter((a) => a.used === true).length
  const unusedN = answers.filter((a) => a.used === false).length
  let used: boolean | null = null
  if (usedN >= BITREFILL_CHAIN_QUORUM && unusedN === 0) used = true
  else if (unusedN >= BITREFILL_CHAIN_QUORUM && usedN === 0) used = false
  return { used, answers }
}

/** true / false / null under the symmetric quorum rule of readAuthorizationQuorum. */
export async function readAuthorizationUsed(env: Env, funder: string, nonce: string): Promise<boolean | null> {
  return (await readAuthorizationQuorum(env, funder, nonce)).used
}

const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')

function isUsdcLog(log: any): boolean {
  return !!log && typeof log === 'object' && log.removed !== true && String(log.address ?? '').toLowerCase() === BASE_USDC.toLowerCase()
}

/** AuthorizationUsed(authorizer = funder, nonce) from the USDC contract. */
function isAuthorizationUsedLog(log: any, funder: string, nonce: string): boolean {
  if (!isUsdcLog(log)) return false
  const t = log.topics
  return (
    Array.isArray(t) && t.length === 3 &&
    String(t[0]).toLowerCase() === AUTHORIZATION_USED_TOPIC &&
    String(t[1]).toLowerCase() === pad32(funder) &&
    String(t[2]).toLowerCase() === pad32(nonce)
  )
}

/** Transfer(funder -> `to`, exactly `amount`) from the USDC contract. */
function isExactTransferLog(log: any, funder: string, to: string, amount: bigint): boolean {
  if (!isUsdcLog(log)) return false
  const t = log.topics
  if (!Array.isArray(t) || t.length !== 3) return false
  if (String(t[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC) return false
  if (String(t[1]).toLowerCase() !== pad32(funder) || String(t[2]).toLowerCase() !== pad32(to)) return false
  if (typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(log.data)) return false
  return BigInt(log.data) === amount
}

export type TransferProof = {
  /**
   * proven     : at least 2 distinct hosts show the SAME successful transaction
   *              whose receipt holds AuthorizationUsed(funder, nonce) AND the
   *              exact Transfer funder -> frozen address, and no host shows the
   *              authorization's transaction without that Transfer.
   * disproven  : at least 2 distinct hosts show the SAME successful transaction
   *              with AuthorizationUsed(funder, nonce) and NO matching Transfer,
   *              and no host proves it.
   * unavailable: anything else (logs refused or empty, receipt unreadable, fewer
   *              than 2 hosts, hosts disagree, window over the cap). Never paid.
   */
  result: 'proven' | 'disproven' | 'unavailable'
  transaction?: string
  notes: string[]
}

type HostProof = { host: string; verdict: 'proven' | 'disproven' | 'unavailable'; tx?: string; note?: string }

/** Bound one host's proof work; running out of time = unavailable for that host. */
async function withHostBudget(host: string, work: Promise<HostProof>): Promise<HostProof> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<HostProof>((resolve) => {
    timer = setTimeout(() => resolve({ host, verdict: 'unavailable', note: 'host proof budget exceeded' }), BITREFILL_PROOF_HOST_BUDGET_MS)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function blockTimestampMs(url: string, n: bigint): Promise<number | null> {
  const r = await rpcCall(url, 'eth_getBlockByNumber', ['0x' + n.toString(16), false])
  const ts = (r.ok && r.result && typeof r.result === 'object' ? (r.result as any).timestamp : null) as unknown
  if (typeof ts !== 'string' || !/^0x[0-9a-fA-F]+$/.test(ts)) return null
  return Number(BigInt(ts)) * 1000
}

/**
 * Block range covering [lowMs, highMs], anchored to the payment (not to
 * `latest`), so its size is bounded by the invoice lifetime however old the
 * record is. Block numbers are estimated at 2 s per block from the latest
 * block's real timestamp, then VERIFIED with real block timestamps:
 * ts(from) <= lowMs and (to == latest or ts(to) >= highMs). Each bound may
 * step once (twice the measured shortfall plus a margin); still unproven
 * coverage = not ok (the caller treats it as unavailable, never disproven).
 */
async function paymentLogWindow(
  url: string,
  lowMs: number,
  highMs: number,
): Promise<{ ok: true; from: bigint; to: bigint } | { ok: false; note: string }> {
  const head = await rpcCall(url, 'eth_blockNumber', [])
  if (!head.ok || typeof head.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(head.result)) return { ok: false, note: 'block number unreadable' }
  const latest = BigInt(head.result)
  const latestTs = await blockTimestampMs(url, latest)
  if (latestTs === null) return { ok: false, note: 'latest block timestamp unreadable' }
  const blocksBack = (ms: number) => BigInt(Math.max(0, Math.ceil(ms / BASE_BLOCK_MS)))
  const clamp = (n: bigint) => (n < 0n ? 0n : n > latest ? latest : n)

  let from = clamp(latest - blocksBack(latestTs - lowMs) - BigInt(LOG_WINDOW_MARGIN_BLOCKS))
  let fromTs = await blockTimestampMs(url, from)
  if (fromTs === null) return { ok: false, note: 'fromBlock timestamp unreadable' }
  if (fromTs > lowMs && from > 0n) {
    from = clamp(from - 2n * blocksBack(fromTs - lowMs) - BigInt(LOG_WINDOW_MARGIN_BLOCKS))
    fromTs = await blockTimestampMs(url, from)
    if (fromTs === null) return { ok: false, note: 'fromBlock timestamp unreadable' }
  }
  if (fromTs > lowMs) return { ok: false, note: 'fromBlock does not reach back to payingAt - 10 min' }

  let to = latestTs <= highMs ? latest : clamp(latest - blocksBack(latestTs - highMs) + BigInt(LOG_WINDOW_TAIL_BLOCKS))
  if (to < latest) {
    let toTs = await blockTimestampMs(url, to)
    if (toTs === null) return { ok: false, note: 'toBlock timestamp unreadable' }
    if (toTs < highMs) {
      to = clamp(to + 2n * blocksBack(highMs - toTs) + BigInt(LOG_WINDOW_TAIL_BLOCKS))
      if (to < latest) {
        toTs = await blockTimestampMs(url, to)
        if (toTs === null || toTs < highMs) return { ok: false, note: 'toBlock does not reach the deadline + 5 min' }
      }
    }
  }
  if (to < from) return { ok: false, note: 'empty block window' }
  if (to - from > BigInt(BITREFILL_LOG_MAX_BLOCKS)) return { ok: false, note: `log window ${to - from} blocks over the ${BITREFILL_LOG_MAX_BLOCKS} cap` }
  return { ok: true, from, to }
}

/**
 * Look, on each host independently, for the transaction that consumed this
 * invoice's authorization: the recorded transaction hash if any, else
 * eth_getLogs [AuthorizationUsed, funder, nonce] over a bounded window. Then
 * check that transaction's receipt on the same host. A same-address,
 * same-amount Transfer in a different transaction is not proof.
 */
export async function readBitrefillTransferProof(env: Env, rec: FulfillmentRecord, now: number, nonce: string): Promise<TransferProof> {
  const b = rec.bitrefill
  const amount = b && /^\d+$/.test(b.amountAtomic ?? '') ? BigInt(b.amountAtomic) : null
  if (!b || amount === null || !/^0x[0-9a-fA-F]{40}$/.test(b.address ?? '')) {
    return { result: 'unavailable', notes: ['no frozen address/amount on the record'] }
  }
  const recorded = typeof b.transaction === 'string' && /^0x[0-9a-fA-F]{64}$/.test(b.transaction) ? b.transaction.toLowerCase() : null
  const startMs = msOf(rec.payingAt ?? null)
  const deadlineMs = authorizationDeadlineMs(rec)

  const checkReceipt = async (url: string, tx: string): Promise<HostProof['verdict'] | 'no_auth'> => {
    const r = await rpcCall(url, 'eth_getTransactionReceipt', [tx])
    if (!r.ok || !r.result || typeof r.result !== 'object') return 'unavailable'
    const receipt = r.result as any
    if (receipt.status !== '0x1' || !Array.isArray(receipt.logs)) return 'no_auth'
    if (!receipt.logs.some((l: any) => isAuthorizationUsedLog(l, FUNDER_WALLET, nonce))) return 'no_auth'
    return receipt.logs.some((l: any) => isExactTransferLog(l, FUNDER_WALLET, b.address, amount)) ? 'proven' : 'disproven'
  }

  const perHost = await Promise.all(
    rpcEndpoints(env).map(({ host, url }) => withHostBudget(host, (async (): Promise<HostProof> => {
      if (recorded) {
        const v = await checkReceipt(url, recorded)
        if (v === 'proven' || v === 'disproven') return { host, verdict: v, tx: recorded }
        // Recorded tx unreadable here or did not consume this authorization:
        // look the authorization up by its log instead.
      }
      if (startMs === null || deadlineMs === null) return { host, verdict: 'unavailable', note: 'no payingAt or deadline: log window unknown' }
      const w = await paymentLogWindow(url, startMs - LOG_WINDOW_LEAD_MS, deadlineMs + LOG_WINDOW_TAIL_MS)
      if (!w.ok) return { host, verdict: 'unavailable', note: w.note }
      const { from, to } = w
      const logs = await rpcCall(url, 'eth_getLogs', [
        {
          address: BASE_USDC,
          topics: [AUTHORIZATION_USED_TOPIC, pad32(FUNDER_WALLET), pad32(nonce)],
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16),
        },
      ])
      if (!logs.ok || !Array.isArray(logs.result)) return { host, verdict: 'unavailable', note: 'eth_getLogs refused or unsupported' }
      const hit = logs.result.find((l: any) => isAuthorizationUsedLog(l, FUNDER_WALLET, nonce) && typeof l.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(l.transactionHash))
      // Empty logs are never "disproven".
      if (!hit) return { host, verdict: 'unavailable', note: 'no AuthorizationUsed log in the window' }
      const tx = String(hit.transactionHash).toLowerCase()
      const v = await checkReceipt(url, tx)
      if (v === 'proven' || v === 'disproven') return { host, verdict: v, tx }
      return { host, verdict: 'unavailable', tx, note: 'receipt of the AuthorizationUsed transaction unreadable' }
    })())),
  )

  const notes = perHost.map((h) => `${h.host}:${h.verdict}${h.tx ? '@' + h.tx.slice(0, 10) : ''}${h.note ? ' (' + h.note + ')' : ''}`)
  const decided = perHost.filter((h) => h.verdict !== 'unavailable')
  const txs = new Set(decided.map((h) => h.tx))
  const verdicts = new Set(decided.map((h) => h.verdict))
  // Hosts must agree on both the transaction and the verdict.
  if (decided.length >= BITREFILL_CHAIN_QUORUM && txs.size === 1 && verdicts.size === 1) {
    return { result: decided[0].verdict as 'proven' | 'disproven', transaction: decided[0].tx, notes }
  }
  return { result: 'unavailable', notes }
}

// ── Cron sweep ──────────────────────────────────────────────────────────────

function msOf(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

type SweepAction = 'resolve' | 'recheck' | 'deliver' | 'redrive'

/** Bounded re-drives of a payout whose pre-send verification was deferred. */
export const BITREFILL_MAX_REDRIVES = 10
const REDRIVE_WINDOW_MS = 2 * 60 * 60 * 1000

function payoutSeenAtMs(rec: FulfillmentRecord): number | null {
  let first: number | null = null
  for (const e of rec.events ?? []) {
    if (e.kind !== 'payment_payout_completed' && e.kind !== 'payment_completed') continue
    const t = msOf(e.at)
    if (t !== null && (first === null || t < first)) first = t
  }
  return first
}

function redriveExhausted(rec: FulfillmentRecord, seenMs: number, now: number): boolean {
  return (rec.bitrefillRedrives ?? 0) >= BITREFILL_MAX_REDRIVES || now - seenMs > REDRIVE_WINDOW_MS
}

function classify(env: Env, plId: string, rec: FulfillmentRecord, now: number): SweepAction | null {
  if (rec.status === 'pay_invoice_unknown') return 'resolve'
  // The payout webhook came in, nothing was sent, and the pre-send check was
  // only deferred (order unreadable, payout tx not visible yet, ledger down).
  // Rozo will not resend a 200-acknowledged webhook, so the sweep re-drives
  // it, at most BITREFILL_MAX_REDRIVES times within REDRIVE_WINDOW_MS. Every
  // re-drive goes through the full settle path (exec gate included).
  if (rec.status === 'payin_seen' && rec.rozoPaymentId) {
    if (String(env.BITREFILL_FUNDER_SEND_ENABLED ?? '').toLowerCase() !== 'true') return null
    // Not on the invoice allowlist: not re-driven (same as switch off). Adding
    // the invoice (or "*") later re-drives payouts younger than 2 hours.
    if (!bitrefillInvoiceAllowed(env, invoiceIdOf(plId))) return null
    const seen = payoutSeenAtMs(rec)
    if (seen === null) return null
    // Window over or attempts used up: stop, but alert once.
    if (redriveExhausted(rec, seen, now)) return rec.alertedStuck ? null : 'redrive'
    return 'redrive'
  }
  if (rec.status === 'paying') {
    const since = msOf(rec.payingAt ?? null)
    return since !== null && now - since > BITREFILL_PAYING_STALE_MS ? 'resolve' : null
  }
  // A record that reached manual_review from an unknown outcome may still be
  // executed on chain by a signature we never saw: re-read its nonce for the
  // lifetime of the record (KV TTL 7 days from the last write).
  if (rec.status === 'manual_review' && rec.bitrefillUnknownOrigin) return 'recheck'
  if (rec.status === 'paid') {
    if (!deliveredReportEnabled(env) || rec.deliveredReported || !rec.rozoPaymentId) return null
    if ((rec.deliveredReportAttempts ?? 0) >= BITREFILL_DELIVERED_MAX_ATTEMPTS) return null
    return 'deliver'
  }
  return null
}

/**
 * Latest moment an authorization for this record can still execute, ms.
 * pay-invoice never signs a validBefore later than the frozen invoice expiry
 * minus 60 s, so that is a true upper bound whatever was (or was not)
 * reported back. With a recorded validBefore the later of the two is used:
 * it is never earlier than the recorded validBefore, and it still covers an
 * earlier or concurrent signature whose validBefore we never saw. Only when
 * the expiry is missing too does it fall back to payingAt + 300 s + timeout.
 */
export function authorizationDeadlineMs(rec: FulfillmentRecord): number | null {
  const vbRaw = rec.bitrefill?.validBefore
  const vb = typeof vbRaw === 'number' && vbRaw > 0 ? vbRaw * 1000 : null
  const exp = msOf(rec.bitrefill?.expiresAt ?? null)
  const expBound = exp === null ? null : exp - BITREFILL_EXPIRY_MARGIN_MS
  if (expBound !== null) return vb === null ? expBound : Math.max(vb, expBound)
  if (vb !== null) return vb
  const paying = msOf(rec.payingAt ?? null)
  // pay-invoice never signs validBefore beyond now + 300 s, and signs only
  // after the request arrived (after payingAt).
  return paying === null ? null : paying + BITREFILL_MAX_AUTH_VALIDITY_MS + BITREFILL_PAY_TIMEOUT_MS
}

export async function resolveBitrefillUnknown(env: Env, plId: string, rec: FulfillmentRecord, now: number): Promise<void> {
  const nonce = rec.bitrefill?.nonce ?? bitrefillNonce(invoiceIdOf(plId))
  const read = await readAuthorizationQuorum(env, FUNDER_WALLET, nonce)
  const used = read.used
  const nowIso = new Date(now).toISOString()
  if (used === null) return
  const deadline = authorizationDeadlineMs(rec)
  const pastDeadline = deadline !== null && now > deadline + BITREFILL_UNKNOWN_GRACE_MS
  if (used) {
    await applyChainUsed(env, plId, rec, now, read, nonce, false, pastDeadline)
    return
  }
  if (!pastDeadline || deadline === null) return
  const from = rec.status
  rec.status = 'manual_review'
  rec.failureReason = 'authorization expired unused: nothing was paid to Bitrefill'
  // Came from an unknown outcome: the sweep keeps re-reading the nonce.
  if (from === 'pay_invoice_unknown' || from === 'paying') rec.bitrefillUnknownOrigin = true
  const alert = !rec.alertedManualReview
  rec.alertedManualReview = true
  rec.events.push({
    kind: 'sweep_manual_review',
    at: nowIso,
    detail: { from, reason: rec.failureReason, deadline: new Date(deadline).toISOString(), unusedReads: read.answers.filter((a) => a.used === false).map((a) => a.endpoint) },
  })
  await saveRecordGuarded(env, plId, rec)
  if (alert) {
    await sendBitrefillAlert(env, [
      '[MPP Router] 🚨 Bitrefill invoice NOT paid: the signed authorization expired unused',
      `Invoice: ${plId} (${fmt(rec.invoiceAmountAtomic)} USDC), was ${from}, invoice expiry ${rec.bitrefill?.expiresAt ?? 'unknown'}`,
      `Two RPC sources read the nonce unused after ${new Date(deadline).toISOString()} + grace, none read it used, so no transfer is visible. The funder holds the money. The sweep keeps re-reading the nonce and alerts if it ever reads used.`,
      'Do not refund until the nonce is read unused after the invoice expiry time by two sources.',
      MANUAL_REPAY_TEXT,
    ])
  }
}

/**
 * The nonce quorum reads used (2+ hosts used, none unused). Require the
 * authorization-bound transfer proof from 2+ hosts (readBitrefillTransferProof):
 *   proven      -> paid, delivered report (loud alert when coming from manual_review)
 *   disproven   -> manual_review, loud alert, stop re-checking
 *   unavailable -> never paid. Before deadline + grace: no change. After it
 *                  (unknown records only): manual_review, keep re-checking,
 *                  alert once. Already in manual_review: no change.
 */
async function applyChainUsed(
  env: Env,
  plId: string,
  rec: FulfillmentRecord,
  now: number,
  read: AuthorizationQuorumRead,
  nonce: string,
  fromManualReview: boolean,
  pastDeadline: boolean,
): Promise<void> {
  const proof = await readBitrefillTransferProof(env, rec, now, nonce)
  const nowIso = new Date(now).toISOString()
  const from = rec.status
  const usedReads = read.answers.filter((a) => a.used === true).map((a) => a.endpoint)
  const detail = { from, usedReads, proof: proof.result, transaction: proof.transaction ?? null, notes: proof.notes }
  if (proof.result === 'unavailable') {
    if (fromManualReview || !pastDeadline) return
    rec.status = 'manual_review'
    rec.failureReason = 'nonce reads used on chain but the transfer could not be proven automatically'
    rec.bitrefillUnknownOrigin = true // keep trying to obtain the proof
    const alert = !rec.alertedManualReview
    rec.alertedManualReview = true
    rec.events.push({ kind: 'sweep_bitrefill_nonce_used_unproven', at: nowIso, detail })
    await saveRecordGuarded(env, plId, rec)
    if (alert) {
      await sendBitrefillAlert(env, [
        '[MPP Router] 🚨 Bitrefill invoice needs a human: nonce is used, transfer could not be proven automatically',
        `Invoice: ${plId} (${fmt(rec.invoiceAmountAtomic)} USDC), was ${from}`,
        'Check the chain by hand. Do NOT refund, do NOT re-pay. The sweep keeps trying to prove the transfer and marks it paid if it can.',
      ])
    }
    return
  }
  if (proof.result === 'disproven') {
    rec.status = 'manual_review'
    rec.failureReason = 'nonce consumed by a transaction that did not pay this invoice (no matching Transfer in the AuthorizationUsed transaction)'
    rec.bitrefillUnknownOrigin = false // stop re-checking
    rec.alertedManualReview = true
    rec.events.push({ kind: 'sweep_bitrefill_nonce_used_no_transfer', at: nowIso, detail })
    await saveRecordGuarded(env, plId, rec)
    await sendBitrefillAlert(env, [
      '[MPP Router] 🚨🚨 Bitrefill invoice needs a human: nonce consumed by something that did not pay this invoice',
      `Invoice: ${plId} (${fmt(rec.invoiceAmountAtomic)} USDC), was ${from}, transaction ${proof.transaction ?? '?'}`,
      'Two RPC sources show the AuthorizationUsed transaction for this nonce without a Base USDC Transfer from the funder to the invoice address for the invoice amount. Check the chain by hand. Do not re-pay, do not refund until checked.',
    ])
    return
  }
  rec.status = 'paid'
  rec.paidAt = rec.paidAt ?? nowIso
  if (rec.bitrefill && proof.transaction) rec.bitrefill.transaction = proof.transaction
  rec.events.push({ kind: fromManualReview ? 'sweep_bitrefill_late_execution' : 'sweep_bitrefill_authorization_used', at: nowIso, detail })
  const saved = await saveRecordGuarded(env, plId, rec)
  if (fromManualReview) {
    await sendBitrefillAlert(env, [
      '[MPP Router] 🚨🚨 Bitrefill invoice was manual_review, chain now shows paid',
      `Invoice: ${plId} (${fmt(rec.invoiceAmountAtomic)} USDC), Rozo payment ${(rec.rozoPaymentId ?? '?').slice(0, 8)}, transaction ${proof.transaction ?? '?'}`,
      `Two RPC sources show the authorization for this nonce executed with the exact transfer to the invoice address: the funder paid Bitrefill after the record went to manual review. If a refund was already sent to the payer, recover it.`,
    ])
  }
  if (saved.status === 'paid') await reportDelivered(env, plId, saved, now)
}

/**
 * manual_review records that came from an unknown outcome (or whose transfer
 * could not be proven yet): re-read under the same rule. Only an
 * authorization-bound proof from 2+ hosts moves it to paid (manual_review ->
 * paid is a rank increase, so saveRecordGuarded allows it; this re-check is
 * the only Bitrefill path that writes it). Unused, mixed, undecided or
 * unproven: no change.
 */
export async function recheckBitrefillManualReview(env: Env, plId: string, rec: FulfillmentRecord, now: number): Promise<void> {
  if (rec.status !== 'manual_review' || !rec.bitrefillUnknownOrigin) return
  const nonce = rec.bitrefill?.nonce ?? bitrefillNonce(invoiceIdOf(plId))
  const read = await readAuthorizationQuorum(env, FUNDER_WALLET, nonce)
  if (read.used !== true) return
  await applyChainUsed(env, plId, rec, now, read, nonce, true, true)
}

async function redriveDeferredPayout(env: Env, plId: string, rec: FulfillmentRecord, now: number): Promise<void> {
  const attempts = rec.bitrefillRedrives ?? 0
  const seen = payoutSeenAtMs(rec) ?? now
  if (redriveExhausted(rec, seen, now)) {
    rec.alertedStuck = true
    await saveRecordGuarded(env, plId, rec)
    await sendBitrefillAlert(env, [
      '[MPP Router] 🚨 Bitrefill invoice NOT paid: payout seen but the order could not be verified',
      `Invoice: ${plId}, Rozo payment ${(rec.rozoPaymentId ?? '?').slice(0, 8)}`,
      `Re-checked ${attempts} times. Nothing was sent. Check the order by hand, then replay the payout webhook before the invoice expires, or refund by hand.`,
    ])
    return
  }
  rec.bitrefillRedrives = attempts + 1
  await saveRecordGuarded(env, plId, rec)
  await settleBitrefillFunderEvent(env, {
    // Unique per attempt: two overlapping sweep runs never share an event id
    // (the exec gate holder derives from it). Not a webhook id, so webhook
    // dedup is unaffected.
    eventId: `bitrefill-sweep:${plId}:${attempts + 1}:${crypto.randomUUID()}`,
    eventType: 'payment_payout_completed',
    plId,
    rozoPaymentId: rec.rozoPaymentId,
    evt: { data: { id: rec.rozoPaymentId ?? undefined, appId: OPENROUTER_APP_ID, orderId: plId } },
    now,
  })
}

/**
 * Cron entry point. Never throws. Never sends a payment directly: the only
 * path that can lead to a send is a bounded re-drive of a deferred payout,
 * which runs the full webhook settle path (exec gate, paying-before-call).
 */
export async function sweepBitrefillFulfillments(
  env: Env,
  now: number = Date.now(),
  clock: () => number = Date.now,
): Promise<{ scanned: number; acted: number }> {
  const startedAt = clock()
  let scanned = 0
  let acted = 0
  try {
    // Cost model (not measured against Cloudflare limits, which are unverified
    // here): per run at most 5 KV list calls (1,000 keys each) plus one KV get
    // per bitrefill_ fulfillment key, then per action: re-drive = order read +
    // balance read + DO gate/ledger calls + up to 2 pay-invoice calls (60 s
    // timeout each); resolve/recheck = one eth_call per distinct RPC host (5,
    // 10 s timeout, in parallel); deliver = one POST. Records carry no list
    // metadata (webhook.ts saveRecord writes none), so terminal records cannot
    // be skipped before the get; adding status metadata there would touch the
    // Coinbase line and is left out of this change.
    const candidates: Array<{ plId: string; rec: FulfillmentRecord; action: SweepAction }> = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const res = await env.MPP_STORE.list({ prefix: kvPrefix(), cursor })
      for (const k of res.keys) {
        const plId = k.name.slice('invoice-fulfillment:'.length)
        if (!isBitrefillOrderId(plId)) continue
        scanned++
        const rec = await loadRecord(env, plId)
        if (!rec) continue
        const action = classify(env, plId, rec, now)
        if (action) candidates.push({ plId, rec, action })
      }
      if (res.list_complete) break
      cursor = (res as { cursor?: string }).cursor
      if (!cursor) break
    }
    // Each action gets its own budget so unresolvable unknowns cannot starve
    // the time-sensitive re-drives (invoice expiry) or the delivered reports.
    // Re-drives run first.
    const order: SweepAction[] = ['redrive', 'resolve', 'recheck', 'deliver']
    const picked = order.flatMap((a) => candidates.filter((c) => c.action === a).slice(0, BITREFILL_SWEEP_MAX_RECORDS))
    for (const { plId, rec, action } of picked) {
      // A re-drive can take ~2 minutes (pay-invoice timeout + retry): stop
      // starting new ones once the run has used its wall budget so it does not
      // overlap the next cron tick. Skipped ones are picked up by a later run.
      // Same wall budget for the chain reads (resolve / recheck): one record
      // costs at most BITREFILL_PROOF_HOST_BUDGET_MS per host (hosts run in
      // parallel) on top of the nonce quorum (10 s per host, parallel).
      if (action !== 'deliver' && clock() - startedAt > BITREFILL_SWEEP_REDRIVE_BUDGET_MS) continue
      acted++
      try {
        if (action === 'resolve') await resolveBitrefillUnknown(env, plId, rec, now)
        else if (action === 'recheck') await recheckBitrefillManualReview(env, plId, rec, now)
        else if (action === 'redrive') await redriveDeferredPayout(env, plId, rec, now)
        else await reportDelivered(env, plId, rec, now)
      } catch (err) {
        console.warn(`[bitrefill-sweep] ${plId} ${action} error (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    console.warn(`[bitrefill-sweep] sweep error (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }
  return { scanned, acted }
}
