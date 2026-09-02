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
} from './stripe-fulfillment'
import { redactForAlert } from '../utils/alert-redaction'

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

interface FulfillmentRecord {
  status:
    | 'payin_seen'
    | 'paying'
    | 'paid'
    | 'failed_insufficient_balance'
    | 'failed_pay_invoice'
  pl_id: string | null
  rozoPaymentId: string | null
  invoiceAmountAtomic: string | null
  funderBalanceAtomic: string | null
  paidAt: string | null
  coinbaseResult: any | null
  failureReason: string | null
  webhookEventIds: string[]
  events: Array<{
    kind: string
    at: string
    event_id?: string
    detail?: unknown
  }>
}

function kvKey(plId: string) {
  return `invoice-fulfillment:${plId}`
}

function eventKvKey(eventId: string) {
  return `webhook-event:${eventId}`
}

async function loadRecord(env: Env, plId: string): Promise<FulfillmentRecord | null> {
  const raw = await env.MPP_STORE.get(kvKey(plId))
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
  await env.MPP_STORE.put(kvKey(plId), JSON.stringify(rec), {
    expirationTtl: 60 * 60 * 24 * 7,
  })
}

function emptyRecord(plId: string): FulfillmentRecord {
  return {
    status: 'payin_seen',
    pl_id: plId,
    rozoPaymentId: null,
    invoiceAmountAtomic: null,
    funderBalanceAtomic: null,
    paidAt: null,
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

// Computes the sum of pending (paying / payin_seen-not-yet-paid) invoice
// amounts. Used to compute the "reserved" balance so concurrent invoices
// don't all see the same funder balance and decide they can each pay.
// Shared with the coupon redemption path (routes/coupon.ts) so webhook
// fulfillments and coupon redemptions reserve against the same pool.
export async function reservedAtomic(env: Env): Promise<bigint> {
  // Listing KV is expensive; instead we keep a running counter at a
  // single key. Bumped on 'paying' transition, decremented on 'paid' /
  // 'failed_*'. Updates are best-effort — a single read+write race
  // could understate by one invoice, which is acceptable for this
  // application (rare concurrent webhooks, small dollar amounts).
  const raw = await env.MPP_STORE.get('funder-reserved-atomic')
  if (!raw) return 0n
  try {
    return BigInt(raw)
  } catch {
    return 0n
  }
}

export async function bumpReserved(env: Env, deltaAtomic: bigint): Promise<void> {
  const cur = await reservedAtomic(env)
  const next = cur + deltaAtomic
  await env.MPP_STORE.put(
    'funder-reserved-atomic',
    (next < 0n ? 0n : next).toString(),
  )
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

export async function handleRozoWebhook(request: Request, env: Env): Promise<Response> {
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
    const summary = await handleStripeWebhookEvent(
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
    return json(200, summary)
  }

  // 6. Load or create fulfillment record.
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

  // If already paid or terminally failed, just persist the event and 200.
  if (rec.status === 'paid' || rec.status === 'failed_pay_invoice') {
    await saveRecord(env, plId, rec)
    return json(200, { ok: true, alreadyTerminal: rec.status, plId })
  }

  // 7. Decide whether to attempt pay-invoice for this event.
  // - payin_completed: optimistic. Check balance (after reserved) and fire
  //   only if the funder already has enough.
  // - payout_completed: confirmed. The destination tx landed, the wallet
  //   definitely has the funds (or had them just now). Fire.
  const shouldAttempt =
    eventType === 'payment_payin_completed' ||
    eventType === 'payment_payout_completed'
  if (!shouldAttempt) {
    await saveRecord(env, plId, rec)
    return json(200, { ok: true, ignored_type: eventType, plId })
  }

  // Already in-flight? Don't double-fire.
  if (rec.status === 'paying') {
    await saveRecord(env, plId, rec)
    return json(200, { ok: true, already_paying: true, plId })
  }

  // 8. Balance check (with reserved subtraction).
  // For payin_completed we want to be conservative — the destination tx
  // hasn't landed yet on the funder wallet for this very payment, but if
  // other deposits have built up balance, we can fire eagerly. The Rozo
  // payment uses Base USDC, and the funder wallet only holds USDC for
  // this purpose, so balanceOf is the right metric.
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
    await saveRecord(env, plId, rec)
    return json(200, { ok: true, deferred: 'invoice_unmeasurable', plId })
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
    // Fall through to pay-invoice attempt below (skipping reservation
    // arithmetic since we don't know balance).
  }

  // If balance is null we skip reservation arithmetic and just attempt.
  const reserved = balance !== null ? await reservedAtomic(env) : 0n
  const available = balance !== null ? balance - reserved : null
  rec.events.push({
    kind: 'balance_check',
    at: new Date().toISOString(),
    detail: {
      balance: balance?.toString() ?? null,
      reserved: reserved.toString(),
      available: available?.toString() ?? null,
      invoice: invoiceAtomic.toString(),
      sufficient: available === null ? 'unknown_attempt_anyway' : available >= invoiceAtomic,
    },
  })

  if (available !== null && available < invoiceAtomic) {
    // Insufficient. For payin_completed this is normal — wait for the
    // destination tx (payout_completed) to credit the funder.
    // For payout_completed this is a real funding problem — flag it.
    if (eventType === 'payment_payout_completed') {
      rec.status = 'failed_insufficient_balance'
      rec.failureReason = `funder balance ${balance} (avail ${available}) < invoice ${invoiceAtomic}`
      // Ops alert: the caller HAS paid (payout landed) but we can't settle
      // the Coinbase link. Awaited — handleRozoWebhook has no ctx.waitUntil,
      // and sendInvoiceFailureAlert never throws.
      await sendInvoiceFailureAlert(env, {
        kind: 'failed_insufficient_balance',
        plId,
        invoiceAtomic,
        funderBalanceAtomic: balance,
        availableAtomic: available,
        failureReason: rec.failureReason,
      })
    }
    await saveRecord(env, plId, rec)
    return json(200, {
      ok: true,
      deferred: 'insufficient_balance',
      eventType,
      plId,
      balance: balance?.toString() ?? null,
      available: available?.toString() ?? null,
      invoice: invoiceAtomic.toString(),
    })
  }

  // 9. Reserve, transition to paying, persist BEFORE calling pay-invoice.
  // Order matters: if pay-invoice succeeds but the worker crashes before
  // we record 'paid', a later retry (manual or via /invoice-status reconciler)
  // will see status=paying and can poll Rozo + Coinbase to recover.
  rec.status = 'paying'
  await bumpReserved(env, invoiceAtomic)
  await saveRecord(env, plId, rec)

  // 10. Trigger pay-invoice. Best-effort; never throw out of the handler.
  let payResult: { ok: boolean; status: number; body: any }
  try {
    payResult = await callAgentApiPayInvoice(env, plId)
  } catch (err: any) {
    payResult = { ok: false, status: 0, body: { error: err?.message ?? 'fetch threw' } }
  }

  // 11. Finalize.
  await bumpReserved(env, -invoiceAtomic)
  if (payResult.ok) {
    rec.status = 'paid'
    rec.paidAt = new Date().toISOString()
    rec.coinbaseResult = payResult.body
    rec.events.push({
      kind: 'pay_invoice_succeeded',
      at: rec.paidAt,
      detail: { status: payResult.status },
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
    // terminal state, needs a human (fix cause, then replay webhook).
    // Awaited — no ctx.waitUntil here; sendInvoiceFailureAlert never throws.
    await sendInvoiceFailureAlert(env, {
      kind: 'failed_pay_invoice',
      plId,
      invoiceAtomic,
      funderBalanceAtomic: balance,
      failureReason: rec.failureReason,
      detail: JSON.stringify(payResult.body),
    })
  }
  await saveRecord(env, plId, rec)

  return json(200, {
    ok: true,
    plId,
    status: rec.status,
    paid: rec.status === 'paid',
    coinbaseResult: payResult.ok ? payResult.body : null,
    error: payResult.ok ? null : payResult.body,
  })
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

function isCoinbasePaymentId(s: string): boolean {
  return isPlId(s) || isPaymentSessionId(s)
}

async function fetchCoinbasePayment(paymentId: string): Promise<any | null> {
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

async function fetchRozoPaymentById(env: Env, rozoId: string): Promise<any | null> {
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

function pickCoinbaseCallerSafe(cp: any) {
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
  const stripeKeyCandidate =
    invoiceKeyParam ??
    (plId && (plId.startsWith('cpis_') || isStripeOrderId(plId)) ? plId : null)
  if (stripeKeyCandidate) {
    const invoiceKey = isStripeOrderId(stripeKeyCandidate)
      ? invoiceKeyFromOrderId(stripeKeyCandidate)
      : stripeKeyCandidate
    const stripeRec = await loadStripeRecordForStatus(env, invoiceKey)
    let rozoPayment: any = null
    const rid = rozoId ?? stripeRec?.rozoPaymentId ?? null
    if (rid) rozoPayment = await fetchRozoPaymentById(env, rid)
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
      // Stripe orders never carry a Coinbase object; the key is present and
      // null so a caller can tell "no Coinbase side" from "field missing".
      coinbase: null,
      payin: derivePayinTruth(stripeRozo, null, stripeRouterState),
      routerState: stripeRouterState,
      rozoPayment: stripeRozo,
    })
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
