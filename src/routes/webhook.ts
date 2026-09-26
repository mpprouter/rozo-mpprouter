import type { Env } from '../index'
import { getBaseUsdcBalance } from '../utils/base-usdc-balance'
import { baseLinkIdOf } from '../mpp/contract-variant'
import { sendDingTalkAlert } from '../utils/dingtalk'
import {
  isStripeOrderId,
  handleStripeWebhookEvent,
  invoiceKeyFromOrderId,
  loadStripeRecordForStatus,
  pickStripeRouterStateSafe,
  reconcileStripeRecordWithProvider,
} from './stripe-fulfillment'
import { redactForAlert } from '../utils/alert-redaction'
import { claimInvoiceKey } from './invoice-claim'
import { acquireCoinbaseExecGate, releaseCoinbaseExecGate } from './coinbase-exec-gate'

// Funder wallet — same wallet that receives caller USDC AND pays
// Coinbase invoices via agentapi's admin-bypass. Configured in
// Rozo merchant `wallet_rozopay` and used as `destination.receiverAddress`
// in create-invoice.ts. Exported for the coupon redemption path, which
// gates on the same funder balance.
export const FUNDER_WALLET = '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739'

const AGENTAPI_PAY_INVOICE_URL = 'https://agentapi.rozo.ai/pay-invoice'

// Rozo signs `${timestamp}.${rawBody}` with HMAC-SHA256(secret).
// X-Rozo-Signature is `sha256=<hex>`.
// X-Rozo-Timestamp is unix ms.
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return hexFromBytes(new Uint8Array(sig))
}

interface WebhookEvent {
  event_id?: string
  type?: 'payment_payin_completed' | 'payment_payout_completed' | string
  timestamp?: string
  data?: {
    id?: string
    appId?: string
    orderId?: string | null
    status?: string
    source?: {
      amount?: string
      tokenAddress?: string
      chainId?: string
      txHash?: string | null
    }
    destination?: {
      amount?: string
      receiverAddress?: string
      chainId?: string
      txHash?: string | null
    }
  }
}

export type FulfillmentStatus =
  | 'payin_seen'
  | 'paying'
  | 'paid'
  // pay-invoice answered 2xx but Coinbase had not captured yet. The pay
  // request WAS sent, so this is terminal for paying: no path may call
  // pay-invoice again. The cron sweep (coinbase-sweep.ts) moves it to `paid`
  // or `manual_review` by reading Coinbase only.
  | 'capture_pending'
  // Needs a human: Coinbase failed/expired or stayed pending too long after
  // the pay request. Never re-paid automatically.
  | 'manual_review'
  | 'failed_insufficient_balance'
  | 'failed_pay_invoice'
  // The invoice was claimed by another channel (UPI fiat) before this
  // crypto payin could settle it. Terminal: the caller's crypto needs a
  // human refund, and the invoice must NOT be paid a second time.
  | 'claimed_by_other_channel'

export interface FulfillmentRecord {
  status: FulfillmentStatus
  pl_id: string | null
  rozoPaymentId: string | null
  invoiceAmountAtomic: string | null
  funderBalanceAtomic: string | null
  paidAt: string | null
  // Set when the record enters `paying`; the sweep's 10/30-minute windows are
  // measured from here (never from the events array).
  payingAt?: string | null
  coinbaseResult: any | null
  failureReason: string | null
  webhookEventIds: string[]
  events: Array<{
    kind: string
    at: string
    event_id?: string
    detail?: unknown
  }>
  // Delivery confirmation reported to Rozo (POST /payments/<id>/delivered).
  // Only an HTTP 200 sets it; it never goes back to false.
  deliveredReported?: boolean
  deliveredReportAttempts?: number
  // One-shot alert / bookkeeping flags written by the cron sweep.
  alertedStuck?: boolean
  alertedManualReview?: boolean
  alertedDeliveredGiveUp?: boolean
  alertedQueryFailing?: boolean
  coinbaseQueryFailingSince?: string | null
  stuckSince?: string | null
}

// Statuses from which no path may call pay-invoice again. A non-terminal
// write never overwrites one of these (saveRecordGuarded).
export const TERMINAL_STATUSES: ReadonlySet<FulfillmentStatus> = new Set<FulfillmentStatus>([
  'paid',
  'capture_pending',
  'manual_review',
  'claimed_by_other_channel',
  'failed_pay_invoice',
])

export function fulfillmentKvKey(plId: string) {
  return `invoice-fulfillment:${plId}`
}

function eventKvKey(eventId: string) {
  return `webhook-event:${eventId}`
}

export async function loadRecord(env: Env, plId: string): Promise<FulfillmentRecord | null> {
  const raw = await env.MPP_STORE.get(fulfillmentKvKey(plId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as FulfillmentRecord
  } catch {
    return null
  }
}

async function saveRecord(env: Env, plId: string, rec: FulfillmentRecord): Promise<void> {
  // 7-day TTL: Coinbase Payment Link preApprovalExpiry is ~24h so 7 days
  // is plenty of audit headroom while keeping KV bounded.
  await env.MPP_STORE.put(fulfillmentKvKey(plId), JSON.stringify(rec), {
    expirationTtl: 60 * 60 * 24 * 7,
  })
}

function mergeEvents(
  a: FulfillmentRecord['events'],
  b: FulfillmentRecord['events'],
): FulfillmentRecord['events'] {
  const seen = new Set<string>()
  const out: FulfillmentRecord['events'] = []
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    const k = JSON.stringify(e)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0))
}

// Monotonic progress rank for guarded saves. A write never moves a record to a
// lower rank than what is stored.
const STATUS_RANK: Record<FulfillmentStatus, number> = {
  payin_seen: 0,
  failed_insufficient_balance: 0,
  paying: 1,
  capture_pending: 2,
  manual_review: 3,
  failed_pay_invoice: 3,
  claimed_by_other_channel: 3,
  paid: 4,
}

function keepStoredStatus(stored: FulfillmentStatus, next: FulfillmentStatus): boolean {
  const s = STATUS_RANK[stored] ?? 0
  const n = STATUS_RANK[next] ?? 0
  if (n < s) return true
  // Equal rank keeps the stored status, except in the pre-pay rank 0 where
  // payin_seen <-> failed_insufficient_balance are ordinary transitions
  // (a payout event with a short balance must be able to record the failure).
  if (n === s && s > 0) return stored !== next
  return false
}

/**
 * Save with a re-read so the webhook and the cron sweep cannot roll each other
 * back: a write never lowers the stored status rank (STATUS_RANK); on a kept
 * status the events are still merged. `deliveredReported` and the one-shot
 * alert flags only go false → true.
 *
 * NOTE: the KV re-read + write is NOT atomic (KV has no conditional write), so
 * this narrows races but cannot close them. Money safety does not rely on it:
 * at most one pay-invoice request per link is guaranteed by the exec gate
 * (coinbase-exec-gate.ts, DO CAS). Returns what was written.
 */
export async function saveRecordGuarded(
  env: Env,
  plId: string,
  rec: FulfillmentRecord,
): Promise<FulfillmentRecord> {
  const stored = await loadRecord(env, plId)
  let out: FulfillmentRecord = rec
  if (stored) {
    const keepStored = keepStoredStatus(stored.status, rec.status)
    const base = keepStored ? stored : rec
    out = {
      ...base,
      events: mergeEvents(stored.events, rec.events),
      webhookEventIds: Array.from(
        new Set([...(stored.webhookEventIds ?? []), ...(rec.webhookEventIds ?? [])]),
      ),
      deliveredReported: Boolean(stored.deliveredReported || rec.deliveredReported),
      deliveredReportAttempts: Math.max(
        stored.deliveredReportAttempts ?? 0,
        rec.deliveredReportAttempts ?? 0,
      ),
      alertedStuck: Boolean(stored.alertedStuck || rec.alertedStuck),
      alertedManualReview: Boolean(stored.alertedManualReview || rec.alertedManualReview),
      alertedDeliveredGiveUp: Boolean(stored.alertedDeliveredGiveUp || rec.alertedDeliveredGiveUp),
      alertedQueryFailing: Boolean(stored.alertedQueryFailing || rec.alertedQueryFailing),
    }
    if (keepStored) {
      console.warn(
        `[webhook] saveRecordGuarded kept stored status ${stored.status} over ${rec.status} for ${plId}`,
      )
    }
  }
  await saveRecord(env, plId, out)
  return out
}

function emptyRecord(plId: string): FulfillmentRecord {
  return {
    status: 'payin_seen',
    pl_id: plId,
    rozoPaymentId: null,
    invoiceAmountAtomic: null,
    funderBalanceAtomic: null,
    paidAt: null,
    payingAt: null,
    coinbaseResult: null,
    failureReason: null,
    webhookEventIds: [],
    events: [],
  }
}

// Parses a decimal USDC string like "1.00" / "0.99" into atomic units (6 decimals).
function parseUsdcAtomic(decimal: string): bigint | null {
  const m = decimal.match(/^(\d+)(?:\.(\d+))?$/)
  if (!m) return null
  const whole = BigInt(m[1])
  const fracRaw = (m[2] ?? '').padEnd(6, '0').slice(0, 6)
  return whole * 1_000_000n + BigInt(fracRaw)
}

// ── Invoice failure ops alerts (DingTalk) ────────────────────────────────
//
// Reuses the same sendDingTalkAlert transport as the Tempo low-balance
// alert in proxy.ts. Both terminal-ish failure states of the fulfillment
// state machine (`failed_insufficient_balance`, `failed_pay_invoice`)
// fire an ops ping so a human can top up / investigate and replay the
// webhook. Alerting is strictly best-effort: it must never break the
// payment path (see sendInvoiceFailureAlert).

// Masks blockchain addresses to first-6 + last-4 so alert payloads never
// carry a full address (EVM 0x…, Stellar G/C…, Solana-style base58).
export function maskAddresses(text: string): string {
  return text
    .replace(/0x[a-fA-F0-9]{40}/g, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`)
    .replace(/\b[GC][A-Z2-7]{55}\b/g, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`)
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`)
}

export interface InvoiceFailureAlertParams {
  kind: 'failed_insufficient_balance' | 'failed_pay_invoice'
  plId: string
  invoiceAtomic: bigint | null
  funderBalanceAtomic: bigint | null
  availableAtomic?: bigint | null
  failureReason: string
  detail?: string
}

function fmtUsdcAtomic(atomic: bigint | null | undefined): string {
  if (atomic === null || atomic === undefined) return '?'
  return (Number(atomic) / 1e6).toFixed(2)
}

export function buildInvoiceFailureAlert(params: InvoiceFailureAlertParams): string {
  const funderMasked = maskAddresses(FUNDER_WALLET)
  const headline =
    params.kind === 'failed_insufficient_balance'
      ? '🚨 Invoice fulfillment BLOCKED: insufficient funder balance'
      : '🚨 Invoice fulfillment FAILED: pay-invoice call did not succeed'
  const action =
    params.kind === 'failed_insufficient_balance'
      ? 'Caller already paid — top up the funder wallet, then replay the webhook.'
      : 'Caller already paid — investigate, then replay the webhook.'
  const lines = [
    `[MPP Router] ${headline}`,
    `Invoice: ${params.plId} (${fmtUsdcAtomic(params.invoiceAtomic)} USDC)`,
    `Funder ${funderMasked}: balance ${fmtUsdcAtomic(params.funderBalanceAtomic)} USDC` +
      (params.availableAtomic !== undefined
        ? `, available ${fmtUsdcAtomic(params.availableAtomic)} USDC`
        : ''),
    `Reason: ${params.failureReason}`,
  ]
  if (params.detail) {
    // Mask BEFORE truncating so the slice can never cut a full address
    // in a way that leaves most of it exposed.
    lines.push(`Detail: ${maskAddresses(params.detail).slice(0, 300)}`)
  }
  lines.push(`At: ${new Date().toISOString()}`)
  lines.push(action)
  // Final defensive pass over the whole message (idempotent on already-
  // masked forms — the `…` breaks every pattern).
  return maskAddresses(lines.join('\n'))
}

// Never throws. Missing token degrades to a structured warn log so the
// gap is still observable in `wrangler tail`.
export async function sendInvoiceFailureAlert(
  env: Env,
  params: InvoiceFailureAlertParams,
): Promise<void> {
  try {
    if (!env.DINGTALK_ACCESS_TOKEN) {
      console.warn(
        `[webhook] invoice failure alert SKIPPED (DINGTALK_ACCESS_TOKEN not set): ` +
          JSON.stringify({
            alert: 'invoice_failure',
            kind: params.kind,
            pl_id: params.plId,
            reason: params.failureReason,
          }),
      )
      return
    }
    await sendDingTalkAlert(env.DINGTALK_ACCESS_TOKEN, redactForAlert(buildInvoiceFailureAlert(params)))
  } catch (err) {
    console.warn(
      `[webhook] invoice failure alert error (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

// Shared with the coupon redemption path (routes/coupon.ts) — both flows
// settle Coinbase links through the same agentapi pay-invoice call.
export async function callAgentApiPayInvoice(
  env: Env,
  plId: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const resp = await fetch(AGENTAPI_PAY_INVOICE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET,
    },
    body: JSON.stringify({ payment_id: plId }),
  })
  const text = await resp.text()
  let parsed: any = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  return { ok: resp.ok, status: resp.status, body: parsed }
}

export async function handleRozoWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }
  if (!env.ROZO_WEBHOOK_SECRET) {
    return json(500, { error: 'ROZO_WEBHOOK_SECRET not configured' })
  }
  if (!env.PAYINVOICE_ADMIN_SECRET) {
    return json(500, { error: 'PAYINVOICE_ADMIN_SECRET not configured' })
  }

  // 1. Read raw body once. Critical: sign the bytes we received, never
  // parse-and-reserialize.
  const rawBody = await request.text()

  const timestampHeader = request.headers.get('x-rozo-timestamp')
  const signatureHeader = request.headers.get('x-rozo-signature')
  if (!timestampHeader || !signatureHeader) {
    return json(401, { error: 'missing signature headers' })
  }

  // 2. Timestamp replay protection.
  const ts = Number(timestampHeader)
  if (!Number.isFinite(ts)) return json(401, { error: 'bad timestamp' })
  const now = Date.now()
  if (Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) {
    return json(401, {
      error: 'timestamp outside 5-minute window',
      now,
      ts,
      drift_ms: now - ts,
    })
  }

  // 3. Verify HMAC.
  const expectedSig = await hmacSha256Hex(
    env.ROZO_WEBHOOK_SECRET,
    `${timestampHeader}.${rawBody}`,
  )
  const provided = signatureHeader.replace(/^sha256=/, '')
  if (!timingSafeEqualHex(expectedSig, provided)) {
    return json(401, { error: 'invalid signature' })
  }

  // 4. Parse body. From here on signature is trusted.
  let evt: WebhookEvent
  try {
    evt = JSON.parse(rawBody)
  } catch {
    return json(400, { error: 'invalid JSON body' })
  }

  const eventId = evt.event_id ?? null
  const eventType = evt.type ?? null
  // A contract-supersede order carries a `__contract*`-suffixed orderId; the
  // real Coinbase link id (and the KV fulfillment record both sibling orders
  // share) is the base id. Normalize BEFORE any provider or KV use.
  const rawOrderId = evt.data?.orderId ?? null
  const plId = typeof rawOrderId === 'string' ? baseLinkIdOf(rawOrderId) : null
  const rozoPaymentId = evt.data?.id ?? null

  if (!eventId || !eventType || !plId) {
    return json(200, {
      ok: true,
      ignored: 'missing event_id / type / orderId',
      eventId,
      eventType,
      plId,
    })
  }

  // 5. Dedup by event_id. If we've seen this exact event before, return
  // 200 and bail. Rozo doesn't retry but our own infra (worker invocation,
  // proxies) could double-deliver.
  const seen = await env.MPP_STORE.get(eventKvKey(eventId))
  if (seen) {
    return json(200, { ok: true, dedup: true, eventId })
  }
  await env.MPP_STORE.put(eventKvKey(eventId), '1', {
    expirationTtl: 60 * 60 * 24 * 7,
  })

  // 5b. Provider routing. Stripe Crypto invoices use a provider-qualified
  // orderId (stripe_crypto_cpis_*) + a separate KV namespace + a per-invoice
  // reservation guard. Coinbase (pl_*) falls through to the unchanged logic
  // below. This keeps the two providers fully isolated (design §9 Layer 1/2).
  if (isStripeOrderId(plId)) {
    const settlement = handleStripeWebhookEvent(
      env,
      {
        eventId,
        eventType,
        orderId: plId,
        rozoPaymentId,
        invoiceAmountStr:
          evt.data?.destination?.amount ?? evt.data?.source?.amount ?? null,
      },
      new Date(now),
    )
    // Rozo's sender aborts delivery at 10s (merchant-webhook.ts). The
    // settlement above claims the record and then calls pay-invoice inline,
    // which can take longer than that; when the client disconnects the
    // runtime may cancel this invocation, leaving the record stuck in
    // provider_paying (2026-09-17 incident). Registering the promise with
    // waitUntil keeps the settlement running to its finalize step even after
    // the sender gives up. We still await it so a fast path answers with the
    // real summary.
    ctx?.waitUntil(settlement.catch(() => undefined))
    const summary = await settlement
    return json(200, summary)
  }

  // 6. Coinbase settlement. Same reasoning as the Stripe branch above: Rozo's
  // sender aborts at 10s and pay-invoice can take longer, so a cancelled
  // invocation used to leave the record in `paying` forever (2026-09-25
  // incident: c48c20a2 / e3dbde9d were captured on Coinbase but never
  // finalized here). waitUntil keeps the settlement running to its finalize
  // step after the sender disconnects; we still await it for the summary.
  const settlement = settleCoinbaseEvent(env, {
    eventId,
    eventType,
    plId,
    rozoPaymentId,
    evt,
    now,
  })
  ctx?.waitUntil(settlement.catch(() => undefined))
  const summary = await settlement
  return json(200, summary)
}

// True only when the pay-invoice response proves Coinbase CAPTURED the
// payment. A 2xx alone is not enough: agentapi answers 200 with
// `{ success: false, coinbase: { captured: false, session: { status:
// 'PAYMENT_SESSION_STATUS_CAPTURE_PENDING' } } }` when the capture had not
// landed by the end of its poll window. In admin mode `success` mirrors
// `coinbase.captured`.
export function payInvoiceCaptured(body: any): boolean {
  if (!body || typeof body !== 'object') return false
  const cb = body.coinbase && typeof body.coinbase === 'object' ? body.coinbase : null
  if (body.success === true || body.captured === true || cb?.captured === true) return true
  const sessionStatus = cb?.session?.status ?? body.session?.status
  if (sessionStatus === 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED') return true
  // v1 payment link: settled once usageCount reaches maxUsage.
  const link = cb?.link ?? body.link
  if (link && typeof link.usageCount === 'number' && link.usageCount >= (link.maxUsage ?? 1)) {
    return true
  }
  return false
}

// Delivery reporting is off until rozo-intents-api serves /delivered.
export function deliveredReportEnabled(env: Env): boolean {
  return env.ROZO_DELIVERED_REPORT_ENABLED === 'true' && Boolean(env.ROZO_INTENTS_API_KEY)
}

// Tell Rozo the merchant side is delivered (Coinbase captured). Only HTTP 200
// counts. Never throws; returns whether the report was accepted.
export async function reportDeliveredToRozo(
  env: Env,
  rozoPaymentId: string,
  plId: string,
): Promise<{ ok: boolean; status: number }> {
  if (!deliveredReportEnabled(env)) return { ok: false, status: 0 }
  try {
    const r = await fetch(
      `${ROZO_PAYMENT_BY_ID}/${encodeURIComponent(rozoPaymentId)}/delivered`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': env.ROZO_INTENTS_API_KEY,
        },
        body: JSON.stringify({ reference: plId }),
      },
    )
    return { ok: r.status === 200, status: r.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

interface CoinbaseEventInput {
  eventId: string
  eventType: string
  plId: string
  rozoPaymentId: string | null
  evt: WebhookEvent
  now: number
}

async function settleCoinbaseEvent(
  env: Env,
  input: CoinbaseEventInput,
): Promise<Record<string, unknown>> {
  const { eventId, eventType, plId, rozoPaymentId, evt, now } = input

  // Load or create fulfillment record.
  let rec = await loadRecord(env, plId)
  if (!rec) rec = emptyRecord(plId)
  if (!rec.rozoPaymentId) rec.rozoPaymentId = rozoPaymentId
  if (!rec.webhookEventIds.includes(eventId)) rec.webhookEventIds.push(eventId)
  rec.events.push({
    kind: eventType,
    at: new Date(now).toISOString(),
    event_id: eventId,
    detail: {
      source_amount: evt.data?.source?.amount,
      source_tx: evt.data?.source?.txHash,
      dest_tx: evt.data?.destination?.txHash,
    },
  })

  // If already paid, submitted (capture_pending), parked or terminally
  // failed, just persist the event and 200. None of these may pay again.
  if (TERMINAL_STATUSES.has(rec.status)) {
    await saveRecordGuarded(env, plId, rec)
    return { ok: true, alreadyTerminal: rec.status, plId }
  }

  // 7. Decide whether to attempt pay-invoice for this event.
  // - payin_completed: optimistic. Check balance and fire only if the
  //   funder already has enough.
  // - payout_completed: confirmed. The destination tx landed, the wallet
  //   definitely has the funds (or had them just now). Fire.
  const shouldAttempt =
    eventType === 'payment_payin_completed' ||
    eventType === 'payment_payout_completed'
  if (!shouldAttempt) {
    await saveRecordGuarded(env, plId, rec)
    return { ok: true, ignored_type: eventType, plId }
  }

  // Already in-flight? Don't double-fire. (Advisory only: KV is not atomic.
  // The exec gate below is the real at-most-once guard.)
  if (rec.status === 'paying') {
    await saveRecordGuarded(env, plId, rec)
    return { ok: true, already_paying: true, plId }
  }

  // 8. Balance check against the funder's real on-chain USDC balance.
  // There is no shared reservation counter any more (removed 2026-09-26: it
  // was a non-atomic KV read-modify-write that leaked whenever a record got
  // stuck in `paying`, and blocked payable invoices). Two concurrent invoices
  // can both pass this check; agentapi pay-invoice re-checks the funder
  // balance itself and the loser fails into failed_pay_invoice + alert.
  const invoiceAmountStr = evt.data?.destination?.amount ?? evt.data?.source?.amount ?? null
  const invoiceAtomic = invoiceAmountStr ? parseUsdcAtomic(invoiceAmountStr) : null
  rec.invoiceAmountAtomic = invoiceAtomic?.toString() ?? null

  const balanceResult = await getBaseUsdcBalance(FUNDER_WALLET, env.BASE_RPC_URL)
  const balance = balanceResult.balance
  rec.funderBalanceAtomic = balance?.toString() ?? null
  console.log(
    `[webhook] balance for ${FUNDER_WALLET}: ${balance?.toString() ?? 'null'} (rpcs: ${JSON.stringify(balanceResult.rpcsTried)})`,
  )

  if (invoiceAtomic === null) {
    // Couldn't parse invoice amount — defer (this is a Rozo payload bug).
    rec.events.push({
      kind: 'invoice_unmeasurable',
      at: new Date().toISOString(),
      detail: { invoice: invoiceAmountStr },
    })
    await saveRecordGuarded(env, plId, rec)
    return { ok: true, deferred: 'invoice_unmeasurable', plId }
  }

  // If balance read failed (all RPCs down), don't sit forever — agentapi
  // pay-invoice will check funder balance itself and reject if low, so
  // we can safely attempt and let it be the gate.
  if (balance === null) {
    rec.events.push({
      kind: 'balance_check_skipped_attempt_anyway',
      at: new Date().toISOString(),
      detail: { rpcsTried: balanceResult.rpcsTried },
    })
    console.log(
      `[webhook] balance unmeasurable but attempting pay-invoice anyway for ${plId} (eventType=${eventType})`,
    )
  }

  rec.events.push({
    kind: 'balance_check',
    at: new Date().toISOString(),
    detail: {
      balance: balance?.toString() ?? null,
      invoice: invoiceAtomic.toString(),
      sufficient: balance === null ? 'unknown_attempt_anyway' : balance >= invoiceAtomic,
    },
  })

  if (balance !== null && balance < invoiceAtomic) {
    // Insufficient. For payin_completed this is normal — wait for the
    // destination tx (payout_completed) to credit the funder.
    // For payout_completed this is a real funding problem — flag it.
    if (eventType === 'payment_payout_completed') {
      rec.status = 'failed_insufficient_balance'
      rec.failureReason = `funder balance ${balance} < invoice ${invoiceAtomic}`
      // Ops alert: the caller HAS paid (payout landed) but we can't settle
      // the Coinbase link. sendInvoiceFailureAlert never throws.
      await sendInvoiceFailureAlert(env, {
        kind: 'failed_insufficient_balance',
        plId,
        invoiceAtomic,
        funderBalanceAtomic: balance,
        failureReason: rec.failureReason,
      })
    }
    await saveRecordGuarded(env, plId, rec)
    return {
      ok: true,
      deferred: 'insufficient_balance',
      eventType,
      plId,
      balance: balance?.toString() ?? null,
      invoice: invoiceAtomic.toString(),
    }
  }

  // 8b. Cross-channel claim (linearizable DO CAS, see invoice-claim.ts). If
  // the UPI channel already holds this invoice, never pay it again from here:
  // the caller's crypto is refunded by a human, the invoice is settled once.
  const claim = await claimInvoiceKey(env, plId, 'crypto', plId)
  if (!claim.ok) {
    rec.status = 'claimed_by_other_channel'
    rec.failureReason = `invoice already claimed by ${claim.holder.channel} channel`
    rec.events.push({ kind: 'claimed_by_other_channel', at: new Date().toISOString() })
    await sendInvoiceFailureAlert(env, {
      kind: 'failed_pay_invoice',
      plId,
      invoiceAtomic,
      funderBalanceAtomic: balance,
      failureReason: rec.failureReason,
    })
    await saveRecordGuarded(env, plId, rec)
    return { ok: true, status: rec.status, plId }
  }

  // 8c. Execution gate (coinbase-exec-gate.ts): the non-re-entrant "at most
  // one pay-invoice request per link" lock. The claim above is re-entrant for
  // the same channel/ref, so a resent or racing payout event would pass it.
  // Held → someone already sent (or is sending) pay-invoice for this link:
  // record it and do NOT pay.
  const gate = await acquireCoinbaseExecGate(env, plId, eventId)
  if (!gate.ok) {
    rec.events.push({
      kind: 'exec_gate_held',
      at: new Date().toISOString(),
      event_id: eventId,
      detail: { holder: gate.holder.holder, since: gate.holder.at },
    })
    await saveRecordGuarded(env, plId, rec)
    return { ok: true, exec_gate_held: true, plId }
  }

  // 9. Transition to paying, persist BEFORE calling pay-invoice. If the
  // worker dies after the call, the cron sweep sees `paying` + payingAt and
  // resolves it from Coinbase (never by paying again).
  rec.status = 'paying'
  rec.payingAt = new Date().toISOString()
  try {
    rec = await saveRecordGuarded(env, plId, rec)
  } catch (err) {
    // Definite failure BEFORE the pay request was sent: give the gate back so
    // a later event can retry. This is the only release path.
    await releaseCoinbaseExecGate(env, plId, eventId).catch(() => false)
    throw err
  }
  if (rec.status !== 'paying') {
    // A concurrent writer (sweep / another event) holds a terminal state.
    // Nothing was sent yet, so release the gate and stop.
    await releaseCoinbaseExecGate(env, plId, eventId).catch(() => false)
    return { ok: true, alreadyTerminal: rec.status, plId }
  }

  // 10. Trigger pay-invoice. From here the gate is never released.
  let payResult: { ok: boolean; status: number; body: any }
  try {
    payResult = await callAgentApiPayInvoice(env, plId)
  } catch (err: any) {
    payResult = { ok: false, status: 0, body: { error: err?.message ?? 'fetch threw' } }
  }

  // 11. Finalize from Coinbase's real outcome, not just the HTTP status.
  const captured = payResult.ok && payInvoiceCaptured(payResult.body)
  if (captured) {
    rec.status = 'paid'
    rec.paidAt = new Date().toISOString()
    rec.coinbaseResult = payResult.body
    rec.events.push({
      kind: 'pay_invoice_succeeded',
      at: rec.paidAt,
      detail: { status: payResult.status },
    })
  } else if (payResult.ok) {
    // Submitted but not captured yet. Terminal for paying; the sweep
    // confirms against Coinbase and moves it to paid / manual_review.
    rec.status = 'capture_pending'
    rec.coinbaseResult = payResult.body
    rec.events.push({
      kind: 'pay_invoice_capture_pending',
      at: new Date().toISOString(),
      detail: {
        status: payResult.status,
        session_status: payResult.body?.coinbase?.session?.status ?? null,
      },
    })
  } else {
    rec.status = 'failed_pay_invoice'
    rec.failureReason = `agentapi pay-invoice ${payResult.status}`
    rec.events.push({
      kind: 'pay_invoice_failed',
      at: new Date().toISOString(),
      detail: { status: payResult.status, body: payResult.body },
    })
    // Ops alert: caller paid but the Coinbase settlement call failed —
    // terminal state, needs a human. sendInvoiceFailureAlert never throws.
    await sendInvoiceFailureAlert(env, {
      kind: 'failed_pay_invoice',
      plId,
      invoiceAtomic,
      funderBalanceAtomic: balance,
      failureReason: rec.failureReason,
      detail: JSON.stringify(payResult.body),
    })
  }
  rec = await saveRecordGuarded(env, plId, rec)

  // 12. Best-effort delivery report to Rozo (the sweep retries). Never throws.
  if (rec.status === 'paid' && !rec.deliveredReported && rec.rozoPaymentId && deliveredReportEnabled(env)) {
    try {
      const rep = await reportDeliveredToRozo(env, rec.rozoPaymentId, plId)
      if (rep.ok) rec.deliveredReported = true
      else rec.deliveredReportAttempts = (rec.deliveredReportAttempts ?? 0) + 1
      rec.events.push({
        kind: rep.ok ? 'delivered_reported' : 'delivered_report_failed',
        at: new Date().toISOString(),
        detail: { status: rep.status },
      })
      rec = await saveRecordGuarded(env, plId, rec)
    } catch (err) {
      console.warn(
        `[webhook] delivered report error (non-fatal) for ${plId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  return {
    ok: true,
    plId,
    status: rec.status,
    paid: rec.status === 'paid',
    coinbaseResult: payResult.ok ? payResult.body : null,
    error: payResult.ok ? null : payResult.body,
  }
}

// Public read-only status endpoint.
//
// Two different queries, each authoritative for a different side of the flow:
//
//   ?rozo_payment_id=<uuid>  → asks Rozo intents API "did the caller's
//                              payment to us land?" (payin/payout state,
//                              source.txHash). Source of truth for the
//                              caller → 0x2352... leg.
//
//   ?payment_id=<Coinbase id> → asks Coinbase "did the underlying invoice get
//                               settled?" Supports legacy pl_* links and v3
//                               paymentSession_* sessions.
//
// Either way we also return our own router KV state so the caller can
// tell which step the end-to-end flow is on.
const ROZO_PAYMENT_BY_ID =
  'https://intentapiv4.rozo.ai/functions/v1/payment-api/payments'
const COINBASE_PAYMENTS_BASE = 'https://payments.coinbase.com'

function isPlId(s: string): boolean {
  return /^pl_[0-9a-zA-Z]+$/.test(s)
}

function isPaymentSessionId(s: string): boolean {
  return /^paymentSession_[A-Za-z0-9_-]+$/.test(s)
}

export function isCoinbasePaymentId(s: string): boolean {
  return isPlId(s) || isPaymentSessionId(s)
}

export async function fetchCoinbasePayment(paymentId: string): Promise<any | null> {
  try {
    const resource = isPaymentSessionId(paymentId)
      ? 'payment-sessions'
      : 'payment-links'
    const r = await fetch(
      `${COINBASE_PAYMENTS_BASE}/next-api/${resource}/${encodeURIComponent(paymentId)}`,
      {
        headers: {
          Accept: 'application/json',
          Origin: COINBASE_PAYMENTS_BASE,
          Referer: `${COINBASE_PAYMENTS_BASE}/${resource}/${encodeURIComponent(paymentId)}`,
        },
      },
    )
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export async function fetchRozoPaymentById(env: Env, rozoId: string): Promise<any | null> {
  if (!env.ROZO_INTENTS_API_KEY) return null
  try {
    const r = await fetch(
      `${ROZO_PAYMENT_BY_ID}/${encodeURIComponent(rozoId)}`,
      { headers: { 'X-API-Key': env.ROZO_INTENTS_API_KEY } },
    )
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

// Server-confirmed payin — the ONLY signal a checkout UI may use to tell a
// customer their payment is complete.
//
// Everything here is derived from an upstream we control or trust (Rozo's
// on-chain confirmation, the provider's own settlement, or our fulfillment
// record). A wallet/SDK callback in the browser saying "completed" means the
// client believes it submitted something; it is NOT proof that money arrived,
// and it must never reach this field.
//
// Callers used to have only `coinbase.settled` to go on, which is always null
// for Stripe orders (they take a different branch below) — so a Stripe checkout
// had no server-truth signal at all and the UI fell back to the client
// callback, showing "Payment Complete" for orders that were never paid.
//
// `confirmed` means the CUSTOMER's payin landed. It does not mean we have
// settled the merchant invoice yet; `rozoPayment.status` /
// `routerState.status` still carry that.

// Router states that are only reachable after the payin was observed.
const ROUTER_STATES_IMPLYING_PAYIN = new Set([
  'payin_seen',
  'payout_seen',
  'provider_paying',
  'provider_submitted',
  'provider_submitted_ambiguous',
  'provider_disabled',
  'paid',
  'capture_pending',
  'manual_review',
  'claimed_by_other_channel',
])

const ROZO_STATUSES_IMPLYING_PAYIN = new Set([
  'payment_payin_completed',
  'payment_payout_completed',
])

function derivePayinTruth(
  rozoPayment: any,
  coinbase: any,
  routerState: any,
): { confirmed: boolean; confirmedAt: string | null; via: string | null } {
  const confirmedAt = rozoPayment?.source?.confirmedAt ?? null
  if (confirmedAt) {
    return { confirmed: true, confirmedAt, via: 'rozo_payin' }
  }
  if (typeof rozoPayment?.status === 'string' && ROZO_STATUSES_IMPLYING_PAYIN.has(rozoPayment.status)) {
    return { confirmed: true, confirmedAt: null, via: 'rozo_payin' }
  }
  if (coinbase?.settled === true) {
    return { confirmed: true, confirmedAt: null, via: 'coinbase_settlement' }
  }
  if (typeof routerState?.status === 'string' && ROUTER_STATES_IMPLYING_PAYIN.has(routerState.status)) {
    return { confirmed: true, confirmedAt: routerState.paidAt ?? null, via: 'router_fulfillment' }
  }
  return { confirmed: false, confirmedAt: null, via: null }
}

function pickRozoCallerSafe(rp: any) {
  if (!rp) return null
  return {
    id: rp.id,
    status: rp.status,
    orderId: rp.orderId,
    createdAt: rp.createdAt,
    expiresAt: rp.expiresAt,
    paymentLink: rp.paymentLink,
    source: rp.source
      ? {
          amount: rp.source.amount,
          amountReceived: rp.source.amountReceived,
          txHash: rp.source.txHash,
          confirmedAt: rp.source.confirmedAt,
        }
      : null,
    destination: rp.destination
      ? {
          amount: rp.destination.amount,
          txHash: rp.destination.txHash,
          confirmedAt: rp.destination.confirmedAt,
        }
      : null,
  }
}

export function pickCoinbaseCallerSafe(cp: any) {
  if (!cp) return null
  if (typeof cp.paymentSessionId === 'string') {
    return {
      protocolVersion: 'v3',
      id: cp.paymentSessionId,
      status: cp.status,
      fiat: {
        amount: cp.amount,
        currency: cp.asset,
      },
      maxAmount: cp.amount,
      usageCount: null,
      maxUsage: null,
      preApprovalExpiry: cp.expiresAt,
      merchant: cp.customerDisplay?.merchantName
        ? { name: cp.customerDisplay.merchantName }
        : null,
      settled: cp.status === 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED',
    }
  }
  return {
    protocolVersion: 'v1',
    id: cp.id,
    status: cp.status,
    fiat: cp.fiat,
    maxAmount: cp.maxAmount,
    usageCount: cp.usageCount,
    maxUsage: cp.maxUsage,
    preApprovalExpiry: cp.preApprovalExpiry,
    merchant: cp.merchant?.name ? { name: cp.merchant.name } : null,
    settled: typeof cp.usageCount === 'number' && cp.usageCount >= (cp.maxUsage ?? 1),
  }
}

// Stripe Crypto status (design §11). Reconciles an in-flight record against
// Stripe's live session state BEFORE reporting, so a settlement whose webhook
// request died mid-flight (or whose pay-invoice answer was ambiguous) still
// reaches `paid` / an honest terminal state through this read path.
async function stripeInvoiceStatus(
  env: Env,
  invoiceKey: string,
  rozoId: string | null,
  prefetchedRozo: any | null,
): Promise<Response> {
  let reconcile: unknown = null
  try {
    reconcile = await reconcileStripeRecordWithProvider(env, invoiceKey, new Date())
  } catch {
    // Reconciliation is best-effort; the status read below must never fail
    // because the provider check did.
    reconcile = { checked: false, reason: 'reconcile_threw' }
  }
  const stripeRec = await loadStripeRecordForStatus(env, invoiceKey)
  let rozoPayment: any = prefetchedRozo
  const rid = rozoId ?? stripeRec?.rozoPaymentId ?? null
  if (!rozoPayment && rid) rozoPayment = await fetchRozoPaymentById(env, rid)
  if (!stripeRec && !rozoPayment) {
    return json(404, {
      ok: false,
      error: 'no Stripe fulfillment record or Rozo payment found',
      provider: 'stripe_crypto',
    })
  }
  const stripeRouterState = pickStripeRouterStateSafe(stripeRec)
  const stripeRozo = pickRozoCallerSafe(rozoPayment)
  return json(200, {
    ok: true,
    provider: 'stripe_crypto',
    invoiceKey,
    rozo_payment_id: rid,
    // Stripe orders never carry a Coinbase object; the key is present and
    // null so a caller can tell "no Coinbase side" from "field missing".
    coinbase: null,
    payin: derivePayinTruth(stripeRozo, null, stripeRouterState),
    routerState: stripeRouterState,
    rozoPayment: stripeRozo,
    reconcile,
  })
}

export async function handleInvoiceStatus(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return json(405, { error: 'Method not allowed' })
  }

  const url = new URL(request.url)
  let plId = url.searchParams.get('payment_id') ?? url.searchParams.get('pl') ?? null
  let rozoId =
    url.searchParams.get('rozo_payment_id') ?? url.searchParams.get('id') ?? null

  // Stripe Crypto branch (design §11). Accepts invoice_key=cpis_*, or a
  // payment_id/pl that is a cpis_ session id or a stripe_crypto_ orderId.
  const invoiceKeyParam = url.searchParams.get('invoice_key')
  // Accepted spellings of a Stripe key: cpis_*, stripe_crypto_cpis_* (the Rozo
  // orderId) and stripe:<either> (what some callers prefix the provider with).
  if (plId && plId.startsWith('stripe:')) plId = plId.slice('stripe:'.length)
  const stripeKeyCandidate =
    invoiceKeyParam ??
    (plId && (plId.startsWith('cpis_') || isStripeOrderId(plId)) ? plId : null)
  if (stripeKeyCandidate) {
    const invoiceKey = isStripeOrderId(stripeKeyCandidate)
      ? invoiceKeyFromOrderId(stripeKeyCandidate)
      : stripeKeyCandidate
    return stripeInvoiceStatus(env, invoiceKey, rozoId, null)
  }

  // Accept payment_id with a uuid value (some callers will paste the
  // Rozo payment id into payment_id without knowing the convention).
  if (plId && !isCoinbasePaymentId(plId) && /^[0-9a-f-]{36}$/i.test(plId)) {
    rozoId = plId
    plId = null
  }

  if (!plId && !rozoId) {
    return json(400, {
      error: 'provide payment_id=<pl_* or paymentSession_*> (Coinbase), invoice_key=cpis_* (Stripe), or rozo_payment_id=<uuid>',
    })
  }

  // Query the authoritative upstream for whichever id was given.
  // We do NOT cross-query the other upstream by default — caller is asking
  // a specific question, give them that answer.
  let coinbase: any = null
  let rozo: any = null

  if (plId) {
    coinbase = await fetchCoinbasePayment(plId)
  }
  if (rozoId) {
    rozo = await fetchRozoPaymentById(env, rozoId)
    // A Rozo payment whose orderId is a Stripe order belongs to the Stripe
    // branch: the checkout UI polls by rozo_payment_id, and without this it
    // never saw routerState (nor triggered reconciliation) for Stripe orders.
    if (isStripeOrderId(rozo?.orderId)) {
      return stripeInvoiceStatus(env, invoiceKeyFromOrderId(rozo.orderId), rozoId, rozo)
    }
    // If Rozo lookup returned a Coinbase orderId, surface
    // the corresponding Coinbase state too (caller may want both).
    const inferredPl =
      typeof rozo?.orderId === 'string' ? baseLinkIdOf(rozo.orderId) : rozo?.orderId
    if (typeof inferredPl === 'string' && isCoinbasePaymentId(inferredPl) && !coinbase) {
      plId = inferredPl
      coinbase = await fetchCoinbasePayment(plId)
    }
  }

  // Router-side KV state, keyed by pl_id.
  let rec: FulfillmentRecord | null = null
  if (plId) rec = await loadRecord(env, plId)

  if (!coinbase && !rozo && !rec) {
    return json(404, {
      error: 'not found in Coinbase, Rozo, or router KV',
      plId,
      rozoId,
    })
  }

  const callerCoinbase = pickCoinbaseCallerSafe(coinbase)
  const callerRozo = pickRozoCallerSafe(rozo)
  const callerRouterState = rec
    ? {
        status: rec.status,
        paidAt: rec.paidAt,
        invoiceAmountAtomic: rec.invoiceAmountAtomic,
        funderBalanceAtomic: rec.funderBalanceAtomic,
        failureReason: rec.failureReason,
      }
    : null

  return json(200, {
    ok: true,
    pl_id: plId,
    rozo_payment_id: rozoId ?? rozo?.id ?? null,
    payin: derivePayinTruth(callerRozo, callerCoinbase, callerRouterState),
    routerState: callerRouterState,
    coinbase: callerCoinbase,
    rozoPayment: callerRozo,
  })
}
