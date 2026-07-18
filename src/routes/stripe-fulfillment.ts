// Stripe Crypto invoice fulfillment orchestration (Phase B shadow layer).
//
// This module is the MPP-Router-side orchestration for Stripe Crypto invoices.
// It does NOT move money and holds NO private key: signing lives entirely in the
// Supabase `pay-invoice` edge function (repo shawn-local-skills), which is
// fail-closed / disabled by default. This layer is the enable-blocking
// prerequisite for that branch: it owns
//
//   - provider-qualified identity + DO fulfillment record (design §9 Layer 1/2)
//   - the per-invoice reservation that serializes at most one in-flight
//     settlement per Stripe session (design §9 Layer 2 — the double-sign guard)
//   - passing the locked merchant/amount + daily-spend ledger into pay-invoice,
//     which the Stripe branch now REQUIRES before it will sign
//     (expected_merchant_account / expected_amount_atomic / spent_today_atomic)
//
// Coinbase fulfillment keeps its own KV record/state machine while sharing the
// DO-backed funder-balance reservation with Stripe and coupons. Stripe records
// use a separate provider-qualified namespace so provider state never collides.

import type { Env } from '../index'
import { getBaseUsdcBalance } from '../utils/base-usdc-balance'
import { casRead, casUpdate } from './stripe-atomic'
import { encryptCapability, decryptCapability } from './invoice-capability-crypto'
import {
  releaseFunderReservation,
  tryReserveFunder,
} from './funder-reservation'

// Provider-qualified order id. Rozo orderIds are used verbatim as our KV key
// discriminator, so we avoid ':' (design §6 fallback) and use underscores.
export const STRIPE_ORDER_PREFIX = 'stripe_crypto_'

/** True if a Rozo orderId belongs to a Stripe Crypto invoice. */
export function isStripeOrderId(orderId: string | null | undefined): boolean {
  return typeof orderId === 'string' && orderId.startsWith(STRIPE_ORDER_PREFIX)
}

/** Build the provider-qualified Rozo orderId for a Stripe session id (cpis_*). */
export function stripeOrderId(invoiceKey: string): string {
  return `${STRIPE_ORDER_PREFIX}${invoiceKey}`
}

/** Recover the Stripe session id (cpis_*) from a provider-qualified orderId. */
export function invoiceKeyFromOrderId(orderId: string): string {
  return orderId.startsWith(STRIPE_ORDER_PREFIX)
    ? orderId.slice(STRIPE_ORDER_PREFIX.length)
    : orderId
}

// Provider-qualified KV namespace (design §9 Layer 2). Distinct from the
// Coinbase key so the two providers never share a record.
export function stripeKvKey(invoiceKey: string): string {
  return `invoice-fulfillment:v2:stripe_crypto:${invoiceKey}`
}

// UTC-day daily-spend ledger key. The daily cap is enforced fail-closed inside
// pay-invoice; this counter is the caller-side ledger it reads via
// spent_today_atomic. Keyed by UTC date so it rolls at 00:00 UTC.
export function dailySpentKey(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `stripe-daily-spent:${y}-${m}-${d}`
}

// Router-side states for a Stripe fulfillment (design §8). This layer only ever
// advances up to `provider_submitted`; terminal `paid`/failure is decided by
// pay-invoice's response + the status reconciler.
export type StripeRouterStatus =
  | 'rozo_payment_created'
  | 'payin_seen'
  | 'payout_seen'
  | 'provider_paying'
  | 'provider_submitted'
  // Ambiguous outcome: the pay-invoice call did not return a definite result
  // (transport threw / timed out / 5xx / unparseable). pay-invoice MAY have
  // already signed, so this is NON-RETRYABLE and terminal for the automatic
  // path — it must be reconciled (status reconciler / human), never re-fired,
  // or we risk a double-sign. (design §9 Layer 4/5 — ambiguity stays in flight.)
  | 'provider_submitted_ambiguous'
  | 'provider_disabled'
  | 'paid'
  | 'failed_invoice_changed'
  | 'failed_invoice_expired'
  | 'failed_insufficient_balance'
  | 'failed_provider'
  | 'manual_review'

export interface StripeFulfillmentRecord {
  provider: 'stripe_crypto'
  invoiceKey: string // cpis_*
  orderId: string // stripe_crypto_cpis_*
  status: StripeRouterStatus
  rozoPaymentId: string | null
  // Locked at create-invoice time (design §6). These are what pay-invoice
  // revalidates the live session against before it will sign.
  merchantAccount: string | null // acct_*
  invoiceAmountAtomic: string | null // Base USDC atomic (original invoice, not discounted)
  invoiceCurrency: string | null
  lockFingerprint: string | null
  // The customer-facing Stripe pay URL, stored ENCRYPTED (design §6). It
  // carries a replayable /pay/<blob> session hash, so it is a capability:
  // sealed as an AES-256-GCM blob under INVOICE_CAPABILITY_ENCRYPTION_KEY
  // (see invoice-capability-crypto.ts). Never stored plaintext, never returned
  // in any API response, never logged. Decrypted only in memory in the webhook
  // path, only to hand to pay-invoice.
  stripeUrlEncrypted: string | null
  funderBalanceAtomic: string | null
  paidAt: string | null
  failureReason: string | null
  providerResult: unknown | null
  webhookEventIds: string[]
  events: Array<{ kind: string; at: string; event_id?: string; detail?: unknown }>
}

// The Stripe fulfillment record is stored in the AtomicStoreDO (single source
// of truth), NOT in KV — a KV+DO split would reintroduce the eventual-
// consistency divergence that lets two isolates race the double-sign guard.
// `stripeKvKey(invoiceKey)` is reused as the DO key namespace.

function parseRecord(raw: string | null): StripeFulfillmentRecord | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as StripeFulfillmentRecord
  } catch {
    return null
  }
}

async function loadStripeRecord(
  env: Env,
  invoiceKey: string,
): Promise<StripeFulfillmentRecord | null> {
  const { value } = await casRead(env, stripeKvKey(invoiceKey))
  return parseRecord(value)
}

// Monotonic rank of the fulfillment lifecycle. Used so a concurrent/replayed
// seed or transition can never roll a record BACKWARD to an earlier state
// (design §9 Layer 2 — the create-time seed must never clobber an in-flight or
// terminal record written by the webhook). Higher = further along.
const STATUS_RANK: Record<StripeRouterStatus, number> = {
  rozo_payment_created: 0,
  payin_seen: 1,
  payout_seen: 2,
  provider_paying: 3,
  provider_submitted: 4,
  provider_submitted_ambiguous: 4,
  provider_disabled: 4,
  // Terminal states rank highest so nothing overwrites them.
  paid: 9,
  failed_invoice_changed: 9,
  failed_invoice_expired: 9,
  failed_insufficient_balance: 9,
  failed_provider: 9,
  manual_review: 9,
}

/**
 * Atomically read-modify-write the Stripe fulfillment record via DO CAS.
 * `mutate` receives the current record (or a fresh empty one) and returns the
 * next record, or `null` to commit nothing (no-op). MUST be side-effect-free
 * and re-runnable — CAS retries it on conflict.
 */
async function updateStripeRecord<R>(
  env: Env,
  invoiceKey: string,
  orderId: string,
  mutate: (rec: StripeFulfillmentRecord) => { rec: StripeFulfillmentRecord; result: R } | { noop: R },
): Promise<R> {
  return casUpdate<R>(env, stripeKvKey(invoiceKey), (raw) => {
    const current = parseRecord(raw) ?? emptyStripeRecord(invoiceKey, orderId)
    const out = mutate(current)
    if ('noop' in out) return { op: 'noop', result: out.noop }
    return { op: 'set', value: JSON.stringify(out.rec), result: out.result }
  })
}

export function emptyStripeRecord(
  invoiceKey: string,
  orderId: string,
): StripeFulfillmentRecord {
  return {
    provider: 'stripe_crypto',
    invoiceKey,
    orderId,
    // Initial lifecycle state (rank 0). The webhook advances this to payin_seen
    // / payout_seen on the corresponding events; keeping the empty default at
    // the lowest rank makes the seed's monotonic guard behave correctly.
    status: 'rozo_payment_created',
    rozoPaymentId: null,
    merchantAccount: null,
    invoiceAmountAtomic: null,
    invoiceCurrency: null,
    lockFingerprint: null,
    stripeUrlEncrypted: null,
    funderBalanceAtomic: null,
    paidAt: null,
    failureReason: null,
    providerResult: null,
    webhookEventIds: [],
    events: [],
  }
}

// Seed a Stripe fulfillment record at create-invoice time. Persists the locked
// fields (merchant, amount, fingerprint, url) into the DO so the webhook can
// read them directly and never has to trust the Rozo webhook payload to carry
// metadata.
//
// Idempotent AND monotonic (design §9 Layer 2): if a record already exists it
// only FILLS MISSING lock fields — it never rolls the status backward. A
// concurrent/replayed create-invoice arriving after the webhook has already
// advanced the record to provider_paying/submitted/terminal must NOT reset it
// to rozo_payment_created (which would re-open the double-sign guard). Because
// this runs through DO CAS, the read-modify-write is linearizable.
//
// THROWS on a persistence failure so the caller can refuse to hand back a
// payable link for an order it can never settle (P1-1).
export async function seedStripeRecord(
  env: Env,
  args: {
    invoiceKey: string
    merchantAccount: string | null
    invoiceAmountAtomic: string
    invoiceCurrency: string
    lockFingerprint: string
    stripeUrl: string
    rozoPaymentId: string | null
  },
): Promise<void> {
  const orderId = stripeOrderId(args.invoiceKey)
  // Encrypt the capability BEFORE the CAS callback (crypto is async; the mutate
  // callback must stay synchronous, side-effect-free, and re-runnable). If no
  // key is configured this throws CapabilityCryptoError and seeding fails
  // closed — the caller then refuses to hand back a payable link (P1-1). We
  // never store a plaintext fallback.
  const stripeUrlEncrypted = await encryptCapability(args.stripeUrl, env)
  await updateStripeRecord<true>(env, args.invoiceKey, orderId, (rec) => {
    // Fill only missing lock fields; never overwrite values already locked.
    rec.merchantAccount = rec.merchantAccount ?? args.merchantAccount
    rec.invoiceAmountAtomic = rec.invoiceAmountAtomic ?? args.invoiceAmountAtomic
    rec.invoiceCurrency = rec.invoiceCurrency ?? args.invoiceCurrency
    rec.lockFingerprint = rec.lockFingerprint ?? args.lockFingerprint
    rec.stripeUrlEncrypted = rec.stripeUrlEncrypted ?? stripeUrlEncrypted
    if (!rec.rozoPaymentId && args.rozoPaymentId) rec.rozoPaymentId = args.rozoPaymentId
    // Monotonic: only set the initial state when the record is brand new
    // (still at rank 0). Never roll an advanced record back.
    if (STATUS_RANK[rec.status] < STATUS_RANK['rozo_payment_created'] ||
        rec.status === 'rozo_payment_created') {
      rec.status = 'rozo_payment_created'
    }
    rec.events.push({
      kind: 'rozo_payment_created',
      at: new Date().toISOString(),
      // NOTE: never log stripeUrl/merchant secrets — record only the masked key.
      detail: { invoiceKey: maskInvoiceKey(args.invoiceKey) },
    })
    return { rec, result: true }
  })
}

// Mask a Stripe session id for logs: keep the cpis_ prefix + last 4.
export function maskInvoiceKey(invoiceKey: string): string {
  if (!invoiceKey.startsWith('cpis_') || invoiceKey.length <= 12) return 'cpis_…'
  return `${invoiceKey.slice(0, 9)}…${invoiceKey.slice(-4)}`
}

// ── Daily-spend ledger ──────────────────────────────────────────────────────

function parseAtomic(raw: string | null): bigint {
  if (!raw) return 0n
  try {
    return BigInt(raw)
  } catch {
    return 0n
  }
}

/** Current UTC-day cumulative spend from the DO ledger (read-only). */
export async function readDailySpentAtomic(env: Env, now: Date): Promise<bigint> {
  const { value } = await casRead(env, dailySpentKey(now))
  return parseAtomic(value)
}

// Local mirror of the fail-closed daily cap default so the caller-side ledger
// can reject BEFORE calling pay-invoice (defence in depth — pay-invoice also
// enforces its own cap). Overridable via STRIPE_FULFILLMENT_DAILY_CAP_USD.
const DEFAULT_DAILY_CAP_ATOMIC = 200_000_000n // $200 in 6-dp USDC

function dailyCapAtomic(env: Env): bigint {
  const raw = env.STRIPE_FULFILLMENT_DAILY_CAP_USD
  if (!raw) return DEFAULT_DAILY_CAP_ATOMIC
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_CAP_ATOMIC
  return BigInt(Math.floor(n * 1_000_000))
}

/**
 * Atomically RESERVE `deltaAtomic` against today's spend ledger BEFORE signing
 * (design §9): read current spend, and only if `current + delta <= cap` commit
 * the incremented total. Returns the pre-reservation spend (to pass to
 * pay-invoice as spent_today_atomic) on success, or null if the reservation
 * would exceed the cap (caller must NOT sign). Linearizable via DO CAS, so
 * concurrent invoices can never both reserve the same headroom.
 */
export async function reserveDailySpend(
  env: Env,
  now: Date,
  deltaAtomic: bigint,
): Promise<bigint | null> {
  const cap = dailyCapAtomic(env)
  return casUpdate<bigint | null>(env, dailySpentKey(now), (raw) => {
    const cur = parseAtomic(raw)
    if (cur + deltaAtomic > cap) {
      return { op: 'noop', result: null }
    }
    return { op: 'set', value: (cur + deltaAtomic).toString(), result: cur }
  })
}

/**
 * Atomically RELEASE a previously-reserved `deltaAtomic` (never below zero).
 * Called when the settlement did not actually happen (disabled / definite
 * failure) so the reserved headroom is returned to the day's budget.
 */
export async function releaseDailySpend(
  env: Env,
  now: Date,
  deltaAtomic: bigint,
): Promise<void> {
  await casUpdate<true>(env, dailySpentKey(now), (raw) => {
    const cur = parseAtomic(raw)
    const next = cur - deltaAtomic
    return { op: 'set', value: (next < 0n ? 0n : next).toString(), result: true }
  })
}

// ── pay-invoice call (Stripe body) ──────────────────────────────────────────

// The Stripe branch of the Supabase pay-invoice edge function REQUIRES the
// locked binding + daily ledger before it will sign (design §9). It is
// fail-closed: unless STRIPE_FULFILLMENT_DISABLED=0 is set on that function it
// returns 403 and signs nothing — which is the expected state for this shadow
// phase.
export const STRIPE_PAY_INVOICE_DEFAULT_URL = 'https://agentapi.rozo.ai/pay-invoice'

export interface StripePayInvoiceResult {
  ok: boolean
  status: number
  disabled: boolean // pay-invoice returned "fulfillment disabled" (403 fail-closed)
  // AMBIGUOUS: we never got a definite business answer — transport threw,
  // status 0, a 5xx, or an unparseable body. pay-invoice MAY have signed, so
  // the caller must NOT auto-retry (design §9). Distinct from a definite
  // rejection (a parseable 4xx business refusal), which is safe to retry.
  ambiguous: boolean
  body: unknown
}

export async function callStripePayInvoice(
  env: Env,
  args: {
    stripeUrl: string
    expectedMerchantAccount: string
    expectedAmountAtomic: string
    spentTodayAtomic: string
  },
): Promise<StripePayInvoiceResult> {
  const url = env.STRIPE_PAY_INVOICE_URL ?? STRIPE_PAY_INVOICE_DEFAULT_URL
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET,
      },
      body: JSON.stringify({
        url: args.stripeUrl,
        expected_merchant_account: args.expectedMerchantAccount,
        expected_amount_atomic: args.expectedAmountAtomic,
        spent_today_atomic: args.spentTodayAtomic,
      }),
    })
  } catch (err: any) {
    // Transport threw (network reset, timeout, DNS): we have NO idea whether
    // pay-invoice signed. AMBIGUOUS — never auto-retry.
    return {
      ok: false,
      status: 0,
      disabled: false,
      ambiguous: true,
      body: { error: 'transport error' },
    }
  }
  let text: string
  try {
    text = await resp.text()
  } catch {
    // Body read failed mid-stream — the request was sent, response lost.
    return { ok: false, status: resp.status, disabled: false, ambiguous: true, body: null }
  }
  let parsed: any = null
  let parseOk = true
  try {
    parsed = JSON.parse(text)
  } catch {
    parseOk = false
    parsed = { raw: text.slice(0, 300) }
  }
  // Detect the fail-closed disabled response (403 + code/message). This is not
  // a failure to alert on during the shadow phase — it's the expected state.
  const disabled =
    resp.status === 403 &&
    (parsed?.code === 'stripe_fulfillment_disabled' ||
      (typeof parsed?.error === 'string' &&
        /disabled|fail-closed/i.test(parsed.error)))
  // Ambiguous outcomes: a 5xx (pay-invoice may have signed then failed to
  // respond) or an unparseable body (can't confirm the result). A parseable
  // 4xx is a DEFINITE business refusal (safe to retry) and is NOT ambiguous.
  const ambiguous = !resp.ok && !disabled && (resp.status >= 500 || !parseOk)
  return { ok: resp.ok, status: resp.status, disabled, ambiguous, body: parsed }
}

// ── Webhook Stripe branch ───────────────────────────────────────────────────

interface StripeWebhookInput {
  eventId: string
  eventType: string
  orderId: string // stripe_crypto_cpis_*
  rozoPaymentId: string | null
  invoiceAmountStr: string | null // from webhook destination/source amount
}

// Handle a Rozo webhook event whose orderId is a Stripe Crypto invoice. Mirrors
// the Coinbase state machine's shape (dedup already done by caller), but keyed
// on the provider-qualified record and gated by a per-invoice reservation so at
// most one settlement is ever in flight for a given Stripe session.
//
// Returns a JSON-serialisable summary for the webhook HTTP response.
export async function handleStripeWebhookEvent(
  env: Env,
  input: StripeWebhookInput,
  now: Date,
): Promise<Record<string, unknown>> {
  const invoiceKey = invoiceKeyFromOrderId(input.orderId)
  const orderId = input.orderId
  const nowIso = now.toISOString()

  // ── Phase 1: atomic CLAIM ──────────────────────────────────────────────────
  // A single linearizable CAS does event-dedup + state advance + guard check +
  // lock validation + claim, so the guard check and the claim can never be
  // separated by another isolate. Only ONE concurrent event can transition the
  // record into `provider_paying`; everyone else observes the claimed state and
  // bails. This is the double-sign serializer (design §9 Layer 2).
  //
  // The pay-invoice network call CANNOT run inside a CAS (no I/O in the DO
  // transform), so we claim first, call outside, then finalize with a second
  // CAS keyed off the claim.
  type Claim =
    | { kind: 'claimed'; invoiceAtomic: string }
    | { kind: 'terminal'; status: StripeRouterStatus }
    | { kind: 'in_flight' }
    | { kind: 'ignored'; eventType: string }
    | { kind: 'manual_review'; reason: string }
    | { kind: 'deferred'; reason: string }

  const claim = await updateStripeRecord<Claim>(env, invoiceKey, orderId, (rec) => {
    if (!rec.rozoPaymentId) rec.rozoPaymentId = input.rozoPaymentId
    if (!rec.webhookEventIds.includes(input.eventId)) {
      rec.webhookEventIds.push(input.eventId)
    }
    rec.events.push({
      kind: input.eventType,
      at: nowIso,
      event_id: input.eventId,
      detail: { invoiceKey: maskInvoiceKey(invoiceKey) },
    })

    // Terminal already? Persist the event, claim nothing.
    if (rec.status === 'paid') {
      return { rec, result: { kind: 'terminal', status: rec.status } }
    }

    // Human-gated terminal states — a decrypt failure, a missing lock binding,
    // or a definite provider failure requires a human to reconcile. A later
    // webhook event must NOT be able to reclaim the record and auto-submit a
    // payment, which would bypass the manual-review-only path (design §12).
    // Persist the event for audit but never transition back into settlement.
    if (rec.status === 'manual_review' || rec.status === 'failed_provider') {
      return { rec, result: { kind: 'terminal', status: rec.status } }
    }

    // Guard: already in flight / submitted (incl. ambiguous) — never fire a
    // second settlement. Persist the event (audit) but do NOT transition.
    if (
      rec.status === 'provider_paying' ||
      rec.status === 'provider_submitted' ||
      rec.status === 'provider_submitted_ambiguous'
    ) {
      return { rec, result: { kind: 'in_flight' } }
    }

    // Only payin/payout completion events drive settlement.
    const shouldAttempt =
      input.eventType === 'payment_payin_completed' ||
      input.eventType === 'payment_payout_completed'
    if (!shouldAttempt) {
      if (rec.status === 'rozo_payment_created') rec.status = 'payin_seen'
      return { rec, result: { kind: 'ignored', eventType: input.eventType } }
    }
    if (input.eventType === 'payment_payin_completed' && rec.status === 'rozo_payment_created') {
      rec.status = 'payin_seen'
    }
    if (input.eventType === 'payment_payout_completed') {
      rec.status = 'payout_seen'
    }

    // Locked binding must be present (seeded at create time). Without it we
    // cannot pass pay-invoice's required lock binding → manual_review.
    if (!rec.merchantAccount || !rec.invoiceAmountAtomic || !rec.stripeUrlEncrypted) {
      rec.status = 'manual_review'
      rec.failureReason = 'missing locked binding (merchant/amount/url) in record'
      return { rec, result: { kind: 'manual_review', reason: 'missing_lock_binding' } }
    }
    let invoiceAtomic: bigint
    try {
      invoiceAtomic = BigInt(rec.invoiceAmountAtomic)
    } catch {
      rec.status = 'manual_review'
      rec.failureReason = 'locked invoiceAmountAtomic unparseable'
      return { rec, result: { kind: 'manual_review', reason: 'invoice_unmeasurable' } }
    }
    if (invoiceAtomic <= 0n) {
      rec.status = 'manual_review'
      rec.failureReason = 'locked invoiceAmountAtomic non-positive'
      return { rec, result: { kind: 'manual_review', reason: 'invoice_unmeasurable' } }
    }

    // CLAIM: transition to provider_paying inside this same CAS. From here the
    // record is the durable in-flight guard; a concurrent event re-running this
    // transform sees provider_paying and returns { in_flight }.
    rec.status = 'provider_paying'
    return { rec, result: { kind: 'claimed', invoiceAtomic: invoiceAtomic.toString() } }
  })

  // Non-claim outcomes return immediately (record already persisted by the CAS).
  if (claim.kind === 'terminal') {
    return { ok: true, alreadyTerminal: claim.status, provider: 'stripe_crypto' }
  }
  if (claim.kind === 'in_flight') {
    return { ok: true, already_in_flight: true, provider: 'stripe_crypto' }
  }
  if (claim.kind === 'ignored') {
    return { ok: true, ignored_type: claim.eventType, provider: 'stripe_crypto' }
  }
  if (claim.kind === 'manual_review') {
    return {
      ok: true,
      deferred: claim.reason,
      provider: 'stripe_crypto',
      invoiceKey: maskInvoiceKey(invoiceKey),
    }
  }
  if (claim.kind === 'deferred') {
    return { ok: true, deferred: claim.reason, provider: 'stripe_crypto' }
  }

  // ── We hold the claim. From here we own the single in-flight slot. ──────────
  const invoiceAtomic = BigInt(claim.invoiceAtomic)

  // Balance check against the SHARED funder pool (design §7: Coinbase, Stripe,
  // and coupons compete for the same available balance). The availability
  // decision and reservation insert happen in one DO CAS.
  const balanceResult = await getBaseUsdcBalance(FUNDER_WALLET, env.BASE_RPC_URL)
  const balance = balanceResult.balance
  if (balance === null) {
    await releaseClaim(env, invoiceKey, orderId, nowIso, 'payout_seen', null, {
      kind: 'balance_unavailable',
      detail: { rpcsTried: balanceResult.rpcsTried },
    })
    // Leave the outer webhook event unprocessed. A retry may succeed once an
    // RPC is healthy; signing without a shared-pool reservation is forbidden.
    throw new Error('Stripe fulfillment funder balance unavailable')
  }

  const funderReservationId = `stripe:${invoiceKey}`
  let funderReservation: Awaited<ReturnType<typeof tryReserveFunder>>
  try {
    funderReservation = await tryReserveFunder(env, {
      reservationId: funderReservationId,
      amountAtomic: invoiceAtomic,
      balanceAtomic: balance,
    })
  } catch (err) {
    await releaseClaim(env, invoiceKey, orderId, nowIso, 'payout_seen', balance, {
      kind: 'funder_reservation_unavailable',
    })
    throw err
  }

  if (funderReservation.kind === 'already_reserved') {
    await releaseClaim(env, invoiceKey, orderId, nowIso, 'payout_seen', balance, {
      kind: 'funder_reservation_in_flight',
    })
    throw new Error('Stripe fulfillment funder reservation is already in flight')
  }

  if (funderReservation.kind === 'insufficient') {
    // Insufficient: for payin this is normal (await payout); for payout it's a
    // real funding gap. Release the claim so a later event can retry.
    const releaseTo: StripeRouterStatus =
      input.eventType === 'payment_payout_completed'
        ? 'failed_insufficient_balance'
        : 'payout_seen'
    await releaseClaim(env, invoiceKey, orderId, nowIso, releaseTo, balance, {
      kind: 'balance_check',
      detail: {
        balance: balance.toString(),
        reserved: funderReservation.reservedAtomic.toString(),
        available: funderReservation.availableAtomic.toString(),
        invoice: invoiceAtomic.toString(),
        sufficient: false,
      },
    })
    return {
      ok: true,
      deferred: 'insufficient_balance',
      provider: 'stripe_crypto',
      eventType: input.eventType,
    }
  }

  // Atomically RESERVE the daily-spend headroom BEFORE signing (design §9). If
  // the reservation would exceed the daily cap, release everything and defer —
  // never sign past the cap. On success `spentBefore` is the pre-reservation
  // spend to hand pay-invoice as spent_today_atomic.
  const spentBefore = await reserveDailySpend(env, now, invoiceAtomic)
  if (spentBefore === null) {
    await releaseFunderReservation(env, funderReservationId)
    await releaseClaim(env, invoiceKey, orderId, nowIso, 'payout_seen', balance, {
      kind: 'daily_cap_reached',
      detail: { invoice: invoiceAtomic.toString() },
    })
    return { ok: true, deferred: 'daily_cap_reached', provider: 'stripe_crypto' }
  }

  // Load the claimed record to read the locked binding + url for the call.
  const claimed = await loadStripeRecord(env, invoiceKey)
  if (
    !claimed ||
    !claimed.stripeUrlEncrypted ||
    !claimed.merchantAccount ||
    !claimed.invoiceAmountAtomic
  ) {
    // Should be impossible (we just claimed with these set) — treat as ambiguous
    // rather than risk anything. Release accounting; do NOT auto-retry.
    await releaseFunderReservation(env, funderReservationId)
    await releaseDailySpend(env, now, invoiceAtomic)
    await finalizeClaim(env, invoiceKey, orderId, nowIso, 'manual_review', {
      failureReason: 'claimed record vanished before call',
      event: { kind: 'stripe_confirm_error' },
    })
    return { ok: true, provider: 'stripe_crypto', status: 'manual_review' }
  }

  // Decrypt the capability in memory, only to hand it to pay-invoice. On any
  // decrypt failure (wrong/rotated-away key, tampered blob) we STOP — design
  // §12: never reconstruct the capability from elsewhere. No money moved yet,
  // so release the daily reservation and route to manual_review.
  let stripeUrl: string
  try {
    stripeUrl = await decryptCapability(claimed.stripeUrlEncrypted, env)
  } catch {
    await releaseFunderReservation(env, funderReservationId)
    await releaseDailySpend(env, now, invoiceAtomic)
    await finalizeClaim(env, invoiceKey, orderId, nowIso, 'manual_review', {
      failureReason: 'capability decrypt failed',
      event: { kind: 'stripe_capability_decrypt_failed' },
    })
    return { ok: true, provider: 'stripe_crypto', status: 'manual_review' }
  }

  let payResult: StripePayInvoiceResult
  try {
    payResult = await callStripePayInvoice(env, {
      stripeUrl,
      expectedMerchantAccount: claimed.merchantAccount,
      expectedAmountAtomic: claimed.invoiceAmountAtomic,
      spentTodayAtomic: spentBefore.toString(),
    })
  } catch {
    // Defensive: callStripePayInvoice does not throw (it maps transport errors
    // to ambiguous), but if it ever does, treat as ambiguous — never retryable.
    payResult = { ok: false, status: 0, disabled: false, ambiguous: true, body: null }
  }

  // Release the shared-pool accounting (the record status is now the durable
  // guard). The daily reservation is settled below per outcome.
  try {
    await releaseFunderReservation(env, funderReservationId)
  } catch (err) {
    // A failed release is conservative: it can defer later work but cannot
    // overpay. Preserve the provider outcome instead of creating a false retry.
    console.warn(
      `[stripe-fulfillment] funder reservation release failed for ${maskInvoiceKey(invoiceKey)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // AMBIGUOUS outcome (transport error / 5xx / unparseable): pay-invoice MAY
  // have signed. Do NOT release the daily reservation (keep it counted,
  // conservatively) and mark a NON-retryable state for reconciliation — never
  // auto-retry, or we risk a double-sign. (P0-2)
  if (payResult.ambiguous) {
    await finalizeClaim(env, invoiceKey, orderId, nowIso, 'provider_submitted_ambiguous', {
      failureReason: `pay-invoice ambiguous (status ${payResult.status}) — needs reconciliation`,
      event: { kind: 'stripe_confirm_ambiguous', detail: { status: payResult.status } },
    })
    return {
      ok: true,
      provider: 'stripe_crypto',
      status: 'provider_submitted_ambiguous',
      ambiguous: true,
    }
  }

  if (payResult.disabled) {
    // EXPECTED in the shadow phase: pay-invoice fail-closed disabled. No money
    // moved → release the daily reservation. Not a failure, do not alert.
    await releaseDailySpend(env, now, invoiceAtomic)
    await finalizeClaim(env, invoiceKey, orderId, nowIso, 'provider_disabled', {
      event: { kind: 'stripe_fulfillment_disabled', detail: { status: payResult.status } },
    })
    return {
      ok: true,
      provider: 'stripe_crypto',
      status: 'provider_disabled',
      note: 'stripe fulfillment disabled (fail-closed) — orchestration wired, no money moved',
    }
  }

  if (payResult.ok) {
    // Accepted. Keep the daily reservation (spend really happened). Terminal
    // `paid` is confirmed later by the status reconciler; store a WHITELISTED
    // projection of the provider result (never the raw body — it could echo a
    // Stripe url/client_secret/pk). (P1-2)
    await finalizeClaim(env, invoiceKey, orderId, nowIso, 'provider_submitted', {
      providerResult: safeProviderResult(payResult),
      event: { kind: 'stripe_confirm_submitted', detail: { status: payResult.status } },
    })
    return { ok: true, provider: 'stripe_crypto', status: 'provider_submitted' }
  }

  // Definite provider REJECTION (a real HTTP status with a non-ok, non-403
  // body — pay-invoice explicitly refused, e.g. 400/409/422). Money did not
  // move → release the daily reservation. This IS retryable (a later corrected
  // event can retry), so return to payout_seen rather than a stuck state.
  await releaseDailySpend(env, now, invoiceAtomic)
  await finalizeClaim(env, invoiceKey, orderId, nowIso, 'failed_provider', {
    failureReason: `pay-invoice ${payResult.status}`,
    event: { kind: 'stripe_fulfillment_failed', detail: { status: payResult.status } },
  })
  return { ok: true, provider: 'stripe_crypto', status: 'failed_provider' }
}

// Whitelist projection of a pay-invoice result for storage in the record. NEVER
// store the raw downstream body — it could echo the Stripe url, client_secret,
// or a pk_. Only router-relevant scalars survive. (P1-2)
function safeProviderResult(result: StripePayInvoiceResult): Record<string, unknown> {
  const body = result.body as Record<string, unknown> | null
  const pick = (k: string) =>
    body && typeof body === 'object' && (typeof body[k] === 'string' || typeof body[k] === 'boolean' || typeof body[k] === 'number')
      ? body[k]
      : undefined
  return {
    ok: result.ok,
    status: result.status,
    success: pick('success'),
    state: pick('state'),
    provider: pick('provider'),
  }
}

// Release a held claim back to `releaseTo` (a non-in-flight state) and release
// the shared-pool reservation. Used when we bail AFTER claiming but BEFORE the
// pay-invoice call (balance/cap gates). Atomic via CAS; monotonic-safe.
async function releaseClaim(
  env: Env,
  invoiceKey: string,
  orderId: string,
  nowIso: string,
  releaseTo: StripeRouterStatus,
  balance: bigint | null,
  event: { kind: string; detail?: unknown },
): Promise<void> {
  await updateStripeRecord<true>(env, invoiceKey, orderId, (rec) => {
    // Only step down from the claim we hold; never clobber a terminal state.
    if (rec.status === 'provider_paying') {
      rec.status = releaseTo
      if (releaseTo === 'failed_insufficient_balance') {
        rec.failureReason = 'funder available < invoice'
      }
    }
    rec.funderBalanceAtomic = balance?.toString() ?? rec.funderBalanceAtomic
    rec.events.push({ kind: event.kind, at: nowIso, detail: event.detail })
    return { rec, result: true }
  })
}

// Finalize a held claim to a definite outcome state. Atomic via CAS. Never
// downgrades a terminal `paid`. Stores only whitelisted providerResult.
async function finalizeClaim(
  env: Env,
  invoiceKey: string,
  orderId: string,
  nowIso: string,
  finalStatus: StripeRouterStatus,
  opts: {
    failureReason?: string
    providerResult?: Record<string, unknown>
    event: { kind: string; detail?: unknown }
  },
): Promise<void> {
  await updateStripeRecord<true>(env, invoiceKey, orderId, (rec) => {
    if (rec.status !== 'paid') rec.status = finalStatus
    if (opts.failureReason !== undefined) rec.failureReason = opts.failureReason
    if (finalStatus === 'provider_disabled') rec.failureReason = null
    if (opts.providerResult !== undefined) rec.providerResult = opts.providerResult
    rec.events.push({ kind: opts.event.kind, at: nowIso, detail: opts.event.detail })
    return { rec, result: true }
  })
}

// Funder wallet — re-declared here (not imported) to avoid a webhook.ts import
// cycle; must match webhook.ts FUNDER_WALLET.
export const FUNDER_WALLET = '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739'

// ── Status (design §11) ─────────────────────────────────────────────────────

export async function loadStripeRecordForStatus(
  env: Env,
  invoiceKey: string,
): Promise<StripeFulfillmentRecord | null> {
  return loadStripeRecord(env, invoiceKey)
}

// Safe projection of a Stripe fulfillment record for the public status endpoint.
// NEVER includes stripeUrl (replayable) or raw provider secrets.
export function pickStripeRouterStateSafe(rec: StripeFulfillmentRecord | null) {
  if (!rec) return null
  return {
    status: rec.status,
    failureReason: rec.failureReason,
    paidAt: rec.paidAt,
    invoiceAmountAtomic: rec.invoiceAmountAtomic,
    funderBalanceAtomic: rec.funderBalanceAtomic,
    merchantAccount: rec.merchantAccount,
  }
}
