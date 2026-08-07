/**
 * Partner ledger — prepaid USD balances for coupon partners.
 *
 * Design: ainative `todos/20260807-coupon-reseller-platform.md` (§3.3 / §3.4 / §3.5).
 *
 * A "partner" is a reseller who prepays us USD and then issues coupons himself
 * from a self-serve backend. We take no margin: OpenRouter's 5% crypto surcharge
 * is passed through untouched, so 1 credit costs $1.05 of face value. Balances
 * are recorded in USD (NOT credits) because the balance is a general-purpose
 * wallet — a second product line would otherwise force an account-ledger rewrite.
 *
 * ## Why this file exists at all: the money-safety problem
 *
 * Issuing a coupon must debit a balance AND create a coupon record. Those live
 * under two different keys, and `AtomicStoreDO`'s /commit accepts exactly ONE
 * key (see mpp/atomic-store-do.ts). There is no multi-key transaction, so the
 * naive "just do both" version can crash in between and leave either:
 *
 *   (a) balance debited, no coupon   — the partner lost money, or
 *   (b) coupon issued, no debit      — WE lost money.
 *
 * (b) is the one that actually costs us, because the coupon is redeemable
 * against the shared funder pool. So the whole design is arranged to make (b)
 * unreachable and (a) automatically repairable.
 *
 * ## The ordering, and why a timeout is not enough
 *
 *   1. CAS partner key  — check balance, debit, record a `pendingOps` entry
 *                         holding the code we are ABOUT to create.
 *   2. CAS coupon key   — create-if-absent.
 *   3. CAS partner key  — mark the op confirmed, materialise the ledger entry.
 *
 * The obvious repair ("if the coupon key is still empty after N seconds, refund")
 * is WRONG, and this was caught in review after being written down as safe. It
 * has a time-of-check/time-of-use race:
 *
 *   reconcile: reads coupon key -> absent
 *   issuer:    (was merely slow, not dead) creates the coupon
 *   reconcile: refunds
 *   => coupon exists, balance was refunded. That is exactly case (b).
 *
 * No timeout closes this. A Worker can resume arbitrarily late; "absent now"
 * never implies "absent forever".
 *
 * ## The fix: a tombstone on the coupon key itself
 *
 * Before refunding, reconcile CAS-writes a tombstone to that exact coupon key.
 * Coupon creation and tombstone creation therefore contend for the SAME key,
 * and CAS lets exactly one win:
 *
 *   - tombstone wins -> refund is safe; step 2 can never create that code again.
 *   - creation wins  -> tombstone write fails; reconcile re-reads and confirms.
 *
 * Mutual exclusion on one key replaces the multi-key transaction we cannot have.
 *
 * Refunds (void) use the mirror-image ordering — intent is recorded in the
 * partner record FIRST — so that a crash always leaves a breadcrumb reachable
 * from the partner record, rather than requiring a scan of every coupon.
 *
 * ## Invariants
 *
 *   I1. Balance changes ONLY through `applyLedger`. Nothing else writes
 *       `balanceAtomic`.
 *   I2. sum(ledger deltas) === balanceAtomic, always.
 *   I3. A coupon that exists with `partnerId` set always has a matching
 *       committed debit. ("Coupon without debit" is unreachable.)
 *   I4. Every money mutation is idempotent under a caller-supplied key, because
 *       a lost HTTP response must not become a double debit or a double credit.
 */

import type { Env } from '../index'
import { casRead, casUpdate, couponKey, generateCouponCode, parseRecord } from './coupon'
import type { CouponRecord } from './coupon'
import { formatUsdc } from './create-invoice'

// ── Tunables ─────────────────────────────────────────────────────────────────

/**
 * How long an in-flight op may sit un-confirmed before reconcile treats it as
 * abandoned. This is a LATENCY knob, not a correctness one: correctness comes
 * from the tombstone CAS, so a too-short value costs an unnecessary tombstone
 * race, never a wrong outcome.
 */
const PENDING_STALE_MS = 60_000

/**
 * Cap on UNSETTLED recovery breadcrumbs. Reaching it REJECTS new operations
 * rather than evicting old ones: a pendingIssue/pendingRefund is the only
 * pointer back to money that is mid-flight, so dropping the oldest to make room
 * strands that money permanently. Refusing to start op 51 is recoverable;
 * forgetting op 1 is not.
 */
const MAX_PENDING_OPS = 50
const MAX_COUPON_INDEX = 200
const MAX_LEDGER_INDEX = 500
/** Idempotency keys we remember per partner. Older keys fall off. */
const MAX_IDEM_KEYS = 200

// ── Types ────────────────────────────────────────────────────────────────────

export type LedgerKind =
  | 'topup'
  | 'issue_hold'
  | 'void_refund'
  | 'expire_refund'
  | 'adjust'

export interface LedgerEntry {
  id: string
  partnerId: string
  at: string
  kind: LedgerKind
  /** Signed, atomic USD (6dp). Positive credits, negative debits. */
  deltaAtomic: string
  /** Null only in the window between the body write and the balance commit. */
  balanceAfterAtomic: string | null
  /** Coupon code / payment proof / operator note. */
  ref: string | null
  /** Funding source address, recorded on topups only. Kept for a future payout
   * path (refund-to-origin); nothing reads it today. */
  sourceAddress: string | null
  operator: string | null
}

/**
 * An issue that has debited the balance but whose coupon may or may not exist
 * yet. Lives INSIDE the partner record so it commits atomically with the debit
 * — a separate key could not.
 */
export interface PendingIssue {
  opId: string
  /** Caller-supplied idempotency key (I4). Stable across HTTP retries. */
  clientKey: string
  code: string
  amountAtomic: string
  at: number
}

/** Mirror of PendingIssue for refunds: intent recorded before the coupon flips. */
export interface PendingRefund {
  refundOpId: string
  code: string
  amountAtomic: string
  kind: 'void_refund' | 'expire_refund'
  at: number
}

export interface CouponIndexEntry {
  code: string
  amountAtomic: string
  credits: string | null
  issuedAt: string
  expiresAt: string
}

export interface PartnerRecord {
  id: string
  email: string
  status: 'active' | 'suspended'
  /** Atomic USD (6dp), stringified bigint. The single source of truth (I1). */
  balanceAtomic: string
  createdAt: string
  pendingIssues: PendingIssue[]
  pendingRefunds: PendingRefund[]
  /** Newest-first, bounded. Cheap listing without a collection scan. */
  couponIndex: CouponIndexEntry[]
  /** Newest-first ledger entry ids, bounded. Full entries live at their own keys. */
  ledgerIndex: string[]
  /**
   * Idempotency keys already applied, newest-first, bounded. Each remembers the
   * ledger entry it produced and, for issues, the coupon code — so a replay
   * returns THAT coupon rather than "the newest one", which would hand back the
   * wrong code for an interleaved issue A / issue B / retry A.
   */
  applied: Array<{ k: string; e: string; c?: string }>
  /**
   * Password credential. OPTIONAL: partners created before auth existed (and
   * partners created by the admin login-link path, which mints an account
   * before a password is ever set) must keep deserialising. Absent `auth`
   * means "no password login for this account yet" — never "any password
   * works".
   *
   * Stores a PBKDF2-HMAC-SHA-256 derivation only. The plaintext is generated
   * by us, handed to the partner out of band, and never written anywhere.
   */
  auth?: PartnerAuth
}

export interface PartnerAuth {
  algo: 'PBKDF2-SHA256'
  /** Hex, 16 random bytes, per account. Defeats cross-account rainbow reuse. */
  salt: string
  /** Hex, 32-byte derived key. */
  hash: string
  iterations: number
  setAt: string
}

/** A tombstone occupies a coupon key so the code can never be created later.
 * Shaped as a voided CouponRecord so every existing reader (redeem, admin get)
 * treats it as a dead coupon rather than choking on an unknown shape. */
export interface CouponTombstone extends CouponRecord {
  tombstone: true
  tombstoneOpId: string
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export const partnerKey = (id: string) => `partner:${id}`
/**
 * One durable record per idempotency key. The bounded `applied` list inside the
 * partner record cannot carry this on its own: it evicts, and an evicted key
 * means a replayed top-up proof or client key credits/charges a second time.
 * Bounded state is fine for a recent-window check, not for authorising money.
 */
export const idemKey = (partnerId: string, key: string) => `pidem:${partnerId}:${key}`
export const partnerEmailKey = (email: string) => `partneremail:${normalizeEmail(email)}`
export const ledgerKey = (partnerId: string, entryId: string) =>
  `pledger:${partnerId}:${entryId}`

/** Emails are matched case-insensitively and trimmed, so `A@x.com ` and
 * `a@x.com` cannot become two accounts sharing one person's money. */
/**
 * A partner identifier is a USERNAME, which may or may not look like an email.
 * The founder's first partner logs in as `earnest`, so requiring an `@` would
 * make the account uncreatable.
 *
 * Still validated, because the admin endpoints create an account on first use
 * and a typo would otherwise silently mint a second, empty one that quietly
 * receives the top-up. Allows letters, digits, and `. _ - + @`; rejects
 * whitespace and everything else.
 */
export function isValidPartnerIdentifier(id: string): boolean {
  const v = normalizeEmail(id)
  return v.length >= 3 && v.length <= 254 && /^[a-z0-9._+-]+(@[a-z0-9.-]+)?$/.test(v)
}

export function normalizeEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase()
}

// ── Id generation ────────────────────────────────────────────────────────────
//
// IMPORTANT: ids must be generated OUTSIDE a casUpdate callback. casUpdate
// re-runs its callback on every CAS conflict, so `crypto.randomUUID()` inside
// one yields a different id per attempt and silently destroys idempotency.

export const newPartnerId = () => `ptn_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
export const newOpId = () => `op_${crypto.randomUUID().replace(/-/g, '')}`
export const newLedgerId = () => `led_${crypto.randomUUID().replace(/-/g, '')}`

// ── Helpers ──────────────────────────────────────────────────────────────────

function parsePartner(raw: string | null): PartnerRecord | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as PartnerRecord
    // Defensive defaults: a record written by an older build must not crash a
    // newer one on a money path.
    p.pendingIssues ??= []
    p.pendingRefunds ??= []
    p.couponIndex ??= []
    p.ledgerIndex ??= []
    p.applied ??= []
    return p
  } catch {
    return null
  }
}

function isTombstone(rec: CouponRecord | null): rec is CouponTombstone {
  return !!rec && (rec as CouponTombstone).tombstone === true
}

function pushBounded<T>(arr: T[], item: T, max: number): T[] {
  arr.unshift(item)
  return arr.length > max ? arr.slice(0, max) : arr
}

export class PartnerError extends Error {
  constructor(
    public code:
      | 'PARTNER_NOT_FOUND'
      | 'PARTNER_SUSPENDED'
      | 'INSUFFICIENT_BALANCE'
      | 'COUPON_NOT_FOUND'
      | 'COUPON_NOT_REFUNDABLE'
      | 'NOT_YOUR_COUPON'
      | 'CODE_ALLOCATION_FAILED'
      | 'TOO_MANY_PENDING'
      | 'ISSUE_IN_FLIGHT'
      | 'INVALID_AMOUNT',
    message: string,
    public detail?: unknown,
  ) {
    super(message)
  }
}

// ── The single balance mutator (I1) ──────────────────────────────────────────

interface LedgerMutation {
  kind: LedgerKind
  deltaAtomic: bigint
  ref: string | null
  sourceAddress?: string | null
  operator?: string | null
  /** Pre-allocated OUTSIDE the CAS callback. */
  entryId: string
  /** Idempotency key (I4). Replaying the same key is a no-op. */
  idempotencyKey: string
  /** Recorded alongside the key so a replay can return the same coupon. */
  couponCode?: string
}

/**
 * The ONLY way a balance changes. Applies the delta and the ledger entry in one
 * CAS on the partner key, then materialises the full ledger entry under its own
 * key (index-first, body-after: a crash leaves a dangling index entry, which is
 * inert, rather than an entry nobody can find).
 */
async function applyLedger(
  env: Env,
  partnerId: string,
  m: LedgerMutation,
  mutate?: (p: PartnerRecord) => void,
): Promise<{ partner: PartnerRecord; applied: boolean; entry: LedgerEntry | null }> {
  let entry: LedgerEntry | null = null

  // ── Idempotency gate (durable, O(1)).
  //
  // Claimed BEFORE the money moves and settled after, so the three states are:
  //   done            -> already applied; replay the recorded result
  //   pending, fresh   -> a sibling request is mid-flight; do not race it
  //   pending, stale   -> the previous attempt died before committing. Safe to
  //                       take over: the balance change and the `applied` insert
  //                       are one CAS, so if it had committed within the stale
  //                       window `applied` would still show it.
  const claim = await casUpdate<{ state: string; at: number; mine: boolean }>(
    env,
    idemKey(partnerId, m.idempotencyKey),
    (cur) => {
      const now = Date.now()
      const prev = cur ? (JSON.parse(cur) as { state: string; at: number }) : null
      // `done` -> already applied. `pending` and fresh -> a sibling owns it.
      // Anything else (absent / released / stale pending) is ours to take.
      if (prev?.state === 'done' || (prev?.state === 'pending' && now - prev.at < PENDING_STALE_MS)) {
        return { op: 'noop', result: { ...prev, mine: false } }
      }
      const fresh = { state: 'pending', at: now }
      return { op: 'set', value: JSON.stringify(fresh), result: { ...fresh, mine: true } }
    },
  )

  // Whether WE won the claim is the thing that matters, not what state it is
  // in: a losing caller reading its own `pending` back would otherwise march on
  // and debit a second time.
  if (!claim.mine) {
    return { partner: (await getPartner(env, partnerId))!, applied: false, entry: null }
  }

  // Write the ledger BODY first, then commit the balance + index.
  //
  // Ordering matters and the reverse is what looks natural: index first, body
  // after. That version can crash in between and leave an indexed entry whose
  // body never exists, and the retry takes the idempotent no-op path, so the
  // body is never written — `readLedger` then permanently omits a real balance
  // mutation and sum(ledger) stops matching the balance.
  //
  // Body-first cannot do that. Its failure mode is an orphan body that no index
  // references, which nothing reads and nothing sums. `balanceAfterAtomic` is
  // backfilled after the CAS (it is not knowable before) and is a reporting
  // convenience only — `deltaAtomic` is the number the invariant is built on.
  const draft: LedgerEntry = {
    id: m.entryId,
    partnerId,
    at: new Date().toISOString(),
    kind: m.kind,
    deltaAtomic: m.deltaAtomic.toString(),
    balanceAfterAtomic: null,
    ref: m.ref,
    sourceAddress: m.sourceAddress ?? null,
    operator: m.operator ?? null,
  }
  await casUpdate<boolean>(env, ledgerKey(partnerId, m.entryId), (cur) =>
    cur !== null
      ? { op: 'noop', result: false }
      : { op: 'set', value: JSON.stringify(draft), result: true },
  )

  const partner = await casUpdate<PartnerRecord>(env, partnerKey(partnerId), (raw) => {
    const p = parsePartner(raw)
    if (!p) throw new PartnerError('PARTNER_NOT_FOUND', `no partner ${partnerId}`)

    if (p.applied.some((a) => a.k === m.idempotencyKey)) {
      // Already applied — return the record untouched. This is what makes a
      // retried POST safe (I4). Callers MUST check the returned `applied` flag
      // before doing any follow-on work: acting anyway is how a retry mints a
      // coupon that nobody paid for.
      entry = null
      return { op: 'noop', result: p }
    }

    const before = BigInt(p.balanceAtomic)
    const after = before + m.deltaAtomic
    if (after < 0n) {
      throw new PartnerError(
        'INSUFFICIENT_BALANCE',
        `balance ${formatUsdc(before)} cannot absorb ${formatUsdc(m.deltaAtomic)}`,
        { balanceAtomic: p.balanceAtomic },
      )
    }

    p.balanceAtomic = after.toString()
    entry = { ...draft, balanceAfterAtomic: after.toString() }
    p.ledgerIndex = pushBounded(p.ledgerIndex, m.entryId, MAX_LEDGER_INDEX)
    p.applied = pushBounded(
      p.applied,
      { k: m.idempotencyKey, e: m.entryId, ...(m.couponCode ? { c: m.couponCode } : {}) },
      MAX_IDEM_KEYS,
    )
    mutate?.(p)
    return { op: 'set', value: JSON.stringify(p), result: p }
  })

  if (entry) {
    const settled = entry
    await casUpdate<void>(env, ledgerKey(partnerId, m.entryId), () => ({
      op: 'set',
      value: JSON.stringify(settled),
      result: undefined,
    }))
  }

  // Settle the claim — but only the request that actually applied the mutation
  // may write the result. A concurrent loser reaches here with entry === null
  // and its OWN freshly generated code; letting it overwrite the record would
  // point every later replay at a code that was never created, and the lookup
  // would then report ISSUE_IN_FLIGHT forever for an issue that succeeded.
  await casUpdate<void>(env, idemKey(partnerId, m.idempotencyKey), (cur) => {
    const prev = cur ? (JSON.parse(cur) as { state: string }) : null
    if (prev?.state === 'done') return { op: 'noop', result: undefined }
    if (!entry) return { op: 'noop', result: undefined }
    return {
      op: 'set',
      value: JSON.stringify({
        state: 'done',
        at: Date.now(),
        e: m.entryId,
        ...(m.couponCode ? { c: m.couponCode } : {}),
      }),
      result: undefined,
    }
  })

  return { partner, applied: entry !== null, entry }
}

// ── Account creation / lookup ────────────────────────────────────────────────

/**
 * Look up by email, creating the account if absent. The email index is claimed
 * FIRST: whoever wins that CAS owns the partner id, so two concurrent callers
 * converge on one account instead of minting two that share an address.
 */
export async function getOrCreatePartnerByEmail(
  env: Env,
  email: string,
): Promise<PartnerRecord> {
  const normalized = normalizeEmail(email)
  const candidateId = newPartnerId() // outside the CAS callback

  const ownerId = await casUpdate<string>(env, partnerEmailKey(normalized), (cur) =>
    cur !== null
      ? { op: 'noop', result: cur }
      : { op: 'set', value: candidateId, result: candidateId },
  )

  const now = new Date().toISOString()
  return casUpdate<PartnerRecord>(env, partnerKey(ownerId), (raw) => {
    const existing = parsePartner(raw)
    if (existing) return { op: 'noop', result: existing }
    const fresh: PartnerRecord = {
      id: ownerId,
      email: normalized,
      status: 'active',
      balanceAtomic: '0',
      createdAt: now,
      pendingIssues: [],
      pendingRefunds: [],
      couponIndex: [],
      ledgerIndex: [],
      applied: [],
    }
    return { op: 'set', value: JSON.stringify(fresh), result: fresh }
  })
}

export async function getPartner(env: Env, partnerId: string): Promise<PartnerRecord | null> {
  return parsePartner(await casRead(env, partnerKey(partnerId)))
}

export async function getPartnerIdByEmail(env: Env, email: string): Promise<string | null> {
  return casRead(env, partnerEmailKey(normalizeEmail(email)))
}

export async function readLedger(
  env: Env,
  partnerId: string,
  limit = 50,
): Promise<LedgerEntry[]> {
  const p = await getPartner(env, partnerId)
  if (!p) return []
  const out: LedgerEntry[] = []
  for (const id of p.ledgerIndex.slice(0, limit)) {
    const raw = await casRead(env, ledgerKey(partnerId, id))
    if (raw) {
      try {
        out.push(JSON.parse(raw) as LedgerEntry)
      } catch {
        /* an unreadable entry must not break the whole listing */
      }
    }
  }
  return out
}

// ── Top-up ───────────────────────────────────────────────────────────────────

/**
 * Credit a partner. Manual-only today (the operator confirms an off-platform
 * transfer), which is exactly why `proof` doubles as the idempotency key: a
 * manual top-up has the same ambiguous-commit failure as an automated one —
 * the write lands, the response is lost, the operator retries, and without a
 * key the balance is credited twice. `proof` is already mandatory, so this
 * costs nothing.
 *
 * TODO(P2, self-serve top-ups): when chain deposits credit balances directly,
 * the key must become `chain + txHash + transferIndex`. A bare txHash is NOT
 * enough — one transaction can carry several transfers.
 */
export async function topupPartner(
  env: Env,
  args: {
    email: string
    amountAtomic: bigint
    proof: string
    sourceAddress?: string | null
    operator?: string | null
  },
): Promise<{ partner: PartnerRecord; applied: boolean }> {
  if (args.amountAtomic <= 0n) throw new PartnerError('INSUFFICIENT_BALANCE', 'amount must be > 0')
  const partner = await getOrCreatePartnerByEmail(env, args.email)

  // Idempotency lives in applyLedger's durable claim (see idemKey). An earlier
  // draft scanned the ledger for the same proof instead; that was no better,
  // because ledgerIndex is bounded by the same kind of cap it was meant to
  // outlive.

  const res = await applyLedger(env, partner.id, {
    kind: 'topup',
    deltaAtomic: args.amountAtomic,
    ref: args.proof,
    sourceAddress: args.sourceAddress ?? null,
    operator: args.operator ?? 'admin',
    entryId: newLedgerId(),
    idempotencyKey: `topup:${args.proof}`,
  })
  return { partner: res.partner, applied: res.applied }
}

// ── Issue ────────────────────────────────────────────────────────────────────

export interface IssueArgs {
  partnerId: string
  amountAtomic: bigint
  credits?: string | null
  expiresInMinutes: number
  note?: string | null
  /** Stable across retries of the same user action (I4). */
  clientKey: string
}

export interface IssueResult {
  code: string
  amountUsd: string
  expiresAt: string
  balanceAfterAtomic: string
  reused: boolean
}

/**
 * Debit, then create. See the file header for why the ordering (and only this
 * ordering) makes "coupon without debit" unreachable.
 */
export async function issuePartnerCoupon(env: Env, args: IssueArgs): Promise<IssueResult> {
  // A negative amount would flip `-amountAtomic` into a CREDIT, minting balance
  // out of an issue call. The route layer will validate too, but a primitive on
  // the money path must not depend on its caller for that.
  if (args.amountAtomic <= 0n) {
    throw new PartnerError('INVALID_AMOUNT', 'amount must be > 0')
  }

  // Repair anything left over before touching money, so a stale pending op
  // cannot make a fresh issue look like a duplicate.
  await reconcilePending(env, args.partnerId)

  const existing = await findIssuedByClientKey(env, args.partnerId, args.clientKey)
  if (existing) return existing

  // Collision with an existing coupon key is possible (10^10 space, but not
  // impossible), and admin issuance already handles it by regenerating. Do the
  // same, refunding the debit before each retry so a collision never eats money.
  for (let attempt = 0; attempt < 10; attempt++) {
    const opId = newOpId() // OUTSIDE the CAS callback
    const code = generateCouponCode()
    const ledgerEntryId = newLedgerId()

    // ── Step 1: debit + record intent, atomically on the partner key.
    const debit = await applyLedger(
      env,
      args.partnerId,
      {
        kind: 'issue_hold',
        deltaAtomic: -args.amountAtomic,
        ref: code,
        entryId: ledgerEntryId,
        idempotencyKey: `issue:${args.clientKey}`,
        couponCode: code,
      },
      (p) => {
        if (p.status === 'suspended') {
          throw new PartnerError('PARTNER_SUSPENDED', 'partner is suspended')
        }
        if (p.pendingIssues.length >= MAX_PENDING_OPS) {
          throw new PartnerError(
            'TOO_MANY_PENDING',
            'too many unsettled operations; retry shortly',
          )
        }
        p.pendingIssues.unshift({
          opId,
          clientKey: args.clientKey,
          code,
          amountAtomic: args.amountAtomic.toString(),
          at: Date.now(),
        })
      },
    )

    // The debit did NOT happen — this clientKey was already consumed, almost
    // certainly by a concurrent request that beat us past the pre-flight check.
    // Continuing here would create a coupon backed by no debit, i.e. hand out
    // free credit. Return the winner's coupon instead.
    if (!debit.applied) {
      const settled = await findIssuedByClientKey(env, args.partnerId, args.clientKey)
      if (settled) return settled
      throw new PartnerError(
        'ISSUE_IN_FLIGHT',
        'an identical request is still in flight; retry shortly',
      )
    }
    const partner = debit.partner

    const now = Date.now()
    const issuedAt = new Date(now).toISOString()
    const expiresAt = new Date(now + args.expiresInMinutes * 60_000).toISOString()

    const record: CouponRecord = {
      code,
      amountUsd: formatUsdc(args.amountAtomic),
      amountAtomic: args.amountAtomic.toString(),
      status: 'issued',
      issuedAt,
      expiresAt,
      paymentProof: args.note ?? null,
      redeemingAt: null,
      attemptId: null,
      plId: null,
      redeemedAt: null,
      coinbaseResult: null,
      failureReason: null,
      events: [{ kind: 'issued', at: issuedAt, detail: { partnerId: args.partnerId } }],
      partnerId: args.partnerId,
      issueLedgerId: opId,
      refundLedgerId: null,
    }

    // ── Step 2: create-if-absent on the coupon key.
    const created = await casUpdate<boolean>(env, couponKey(code), (cur) =>
      cur !== null
        ? { op: 'noop', result: false }
        : { op: 'set', value: JSON.stringify(record), result: true },
    )

    if (created) {
      // ── Step 3: confirm. Losing this step is harmless — reconcile will see
      // the coupon exists with a matching opId and finish the bookkeeping.
      const after = await confirmPendingIssue(env, args.partnerId, opId, {
        code,
        amountAtomic: args.amountAtomic.toString(),
        credits: args.credits ?? null,
        issuedAt,
        expiresAt,
      })
      return {
        code,
        amountUsd: record.amountUsd,
        expiresAt,
        balanceAfterAtomic: (after ?? partner).balanceAtomic,
        reused: false,
      }
    }

    // Collision. We definitely did not create that coupon, so refunding is safe.
    // The idempotency key must be RELEASED too: leaving it consumed makes the
    // next loop iteration no-op on the debit and short-circuit to a lookup of
    // the foreign code, so the ten advertised retries would never happen.
    await refundPendingIssue(env, args.partnerId, opId, 'code_collision')
    await releaseIdempotency(env, args.partnerId, `issue:${args.clientKey}`)
  }

  throw new PartnerError('CODE_ALLOCATION_FAILED', 'could not allocate a unique coupon code')
}

/** Replay of an already-satisfied clientKey: return the same coupon, no money moves. */
async function findIssuedByClientKey(
  env: Env,
  partnerId: string,
  clientKey: string,
): Promise<IssueResult | null> {
  const p = await getPartner(env, partnerId)
  if (!p) return null
  // Durable record first — the in-record list evicts, and a delayed retry after
  // enough later mutations would otherwise fall through to a second debit.
  // Falling back to "the newest coupon" would answer issue A / issue B / retry A
  // with B's code, so the code is looked up by the key that produced it.
  let code: string | undefined
  const durable = await casRead(env, idemKey(partnerId, `issue:${clientKey}`))
  if (durable) {
    try {
      const d = JSON.parse(durable) as { state: string; c?: string }
      if (d.state === 'done') code = d.c
    } catch {
      /* fall through to the in-record list */
    }
  }
  code ??= p.applied.find((a) => a.k === `issue:${clientKey}`)?.c
  const inFlight = p.pendingIssues.find((o) => o.clientKey === clientKey)
  code ??= inFlight?.code
  if (!code) return null

  const rec = parseRecord(await casRead(env, couponKey(code)))
  const usable = rec && !isTombstone(rec) && rec.partnerId === partnerId
  if (!usable) {
    // The claim says this key was consumed, but the coupon it points at is
    // gone (tombstoned by reconcile, or a foreign code from a collision). If
    // no pendingIssue is still open for this key, reconcile has already
    // refunded and the operation is finished-and-failed — so the key must be
    // released, or an ordinary single crash wedges this clientKey on
    // ISSUE_IN_FLIGHT forever (`done` never goes stale).
    //
    // The "no open pendingIssue" condition is what separates this from
    // "debited, creation still in flight", which must NOT be released.
    if (!inFlight) await releaseIdempotency(env, partnerId, `issue:${clientKey}`)
    return null
  }
  return {
    code: rec.code,
    amountUsd: rec.amountUsd,
    expiresAt: rec.expiresAt,
    balanceAfterAtomic: p.balanceAtomic,
    reused: true,
  }
}

async function confirmPendingIssue(
  env: Env,
  partnerId: string,
  opId: string,
  indexEntry: CouponIndexEntry,
): Promise<PartnerRecord | null> {
  return casUpdate<PartnerRecord | null>(env, partnerKey(partnerId), (raw) => {
    const p = parsePartner(raw)
    if (!p) return { op: 'noop', result: null }
    const idx = p.pendingIssues.findIndex((o) => o.opId === opId)
    if (idx === -1) return { op: 'noop', result: p }
    p.pendingIssues.splice(idx, 1)
    if (!p.couponIndex.some((c) => c.code === indexEntry.code)) {
      p.couponIndex = pushBounded(p.couponIndex, indexEntry, MAX_COUPON_INDEX)
    }
    return { op: 'set', value: JSON.stringify(p), result: p }
  })
}

/** Give the money back for an op whose coupon provably does not (and now can
 * never) exist. Idempotent on opId. */
async function refundPendingIssue(
  env: Env,
  partnerId: string,
  opId: string,
  reason: string,
): Promise<void> {
  const p = await getPartner(env, partnerId)
  const op = p?.pendingIssues.find((o) => o.opId === opId)
  if (!op) return
  await applyLedger(
    env,
    partnerId,
    {
      kind: 'void_refund',
      deltaAtomic: BigInt(op.amountAtomic),
      ref: `${op.code} (${reason})`,
      entryId: newLedgerId(),
      idempotencyKey: `issue_refund:${opId}`,
    },
    (rec) => {
      const i = rec.pendingIssues.findIndex((o) => o.opId === opId)
      if (i !== -1) rec.pendingIssues.splice(i, 1)
    },
  )
}

/**
 * Undo an idempotency claim for an attempt that provably moved no money, so a
 * fresh attempt under the same caller key may proceed. `released` is neither
 * `done` nor `pending`, so the claim logic treats it as absent.
 */
async function releaseIdempotency(env: Env, partnerId: string, key: string): Promise<void> {
  // Unconditional, including from `done`. A collision is only discovered AFTER
  // the debit has committed and settled the claim, so refusing to clear `done`
  // would leave the key consumed and the retry loop dead — which is exactly the
  // bug this function exists to fix. Callers must have refunded first.
  await casUpdate<void>(env, idemKey(partnerId, key), () => ({
    op: 'set',
    value: JSON.stringify({ state: 'released', at: Date.now() }),
    result: undefined,
  }))
  await casUpdate<void>(env, partnerKey(partnerId), (raw) => {
    const p = parsePartner(raw)
    if (!p) return { op: 'noop', result: undefined }
    const i = p.applied.findIndex((a) => a.k === key)
    if (i === -1) return { op: 'noop', result: undefined }
    p.applied.splice(i, 1)
    return { op: 'set', value: JSON.stringify(p), result: undefined }
  })
}

// ── Reconcile ────────────────────────────────────────────────────────────────

/**
 * Repair pass for both directions. Cheap enough to run on every listing and
 * before every issue.
 *
 * The tombstone step is the load-bearing part: reconcile must never refund on
 * the strength of "the coupon key looked empty", because a slow issuer can fill
 * it a moment later. It refunds only after WINNING that key.
 */
export async function reconcilePending(env: Env, partnerId: string): Promise<void> {
  const p = await getPartner(env, partnerId)
  if (!p) return
  const now = Date.now()

  for (const op of [...p.pendingIssues]) {
    if (now - op.at < PENDING_STALE_MS) continue

    const rec = parseRecord(await casRead(env, couponKey(op.code)))
    if (rec && !isTombstone(rec)) {
      // Both must match: a bare "key exists" would confirm a collision with
      // somebody else's coupon and quietly keep the partner's money.
      if (rec.partnerId === partnerId && rec.issueLedgerId === op.opId) {
        await confirmPendingIssue(env, partnerId, op.opId, {
          code: rec.code,
          amountAtomic: rec.amountAtomic,
          credits: null,
          issuedAt: rec.issuedAt,
          expiresAt: rec.expiresAt,
        })
      } else {
        await refundPendingIssue(env, partnerId, op.opId, 'code_collision')
      }
      continue
    }

    if (isTombstone(rec)) {
      await refundPendingIssue(env, partnerId, op.opId, 'tombstoned')
      continue
    }

    // Key looks empty. Claim it before refunding.
    const at = new Date(now).toISOString()
    const tombstone: CouponTombstone = {
      code: op.code,
      amountUsd: formatUsdc(BigInt(op.amountAtomic)),
      amountAtomic: op.amountAtomic,
      status: 'void',
      issuedAt: at,
      expiresAt: at,
      paymentProof: null,
      redeemingAt: null,
      attemptId: null,
      plId: null,
      redeemedAt: null,
      coinbaseResult: null,
      failureReason: 'abandoned issue — tombstoned by reconcile',
      events: [{ kind: 'tombstoned', at, detail: { opId: op.opId, partnerId } }],
      partnerId,
      issueLedgerId: op.opId,
      refundLedgerId: null,
      tombstone: true,
      tombstoneOpId: op.opId,
    }
    const claimed = await casUpdate<boolean>(env, couponKey(op.code), (cur) =>
      cur !== null
        ? { op: 'noop', result: false }
        : { op: 'set', value: JSON.stringify(tombstone), result: true },
    )
    if (claimed) {
      await refundPendingIssue(env, partnerId, op.opId, 'abandoned')
    } else {
      // Someone beat us to this key. It was either the issuer (coupon is real,
      // confirm it) or a CONCURRENT RECONCILE that tombstoned it first.
      //
      // The tombstone deliberately carries partnerId and issueLedgerId so it
      // reads as a dead coupon, which means a naive "does it match my op?"
      // check here accepts it as a successful issue: the breadcrumb gets
      // dropped, and the sibling reconcile then finds no op to refund and
      // returns quietly. Balance debited, coupon key holding an unredeemable
      // tombstone, nothing left to repair it. Exclude tombstones explicitly.
      const fresh = parseRecord(await casRead(env, couponKey(op.code)))
      if (isTombstone(fresh)) {
        await refundPendingIssue(env, partnerId, op.opId, 'tombstoned_by_peer')
      } else if (fresh && fresh.partnerId === partnerId && fresh.issueLedgerId === op.opId) {
        await confirmPendingIssue(env, partnerId, op.opId, {
          code: fresh.code,
          amountAtomic: fresh.amountAtomic,
          credits: null,
          issuedAt: fresh.issuedAt,
          expiresAt: fresh.expiresAt,
        })
      }
    }
  }

  for (const pr of [...p.pendingRefunds]) {
    await settlePendingRefund(env, partnerId, pr)
  }
}

// ── Void / reclaim ───────────────────────────────────────────────────────────

/**
 * Cancel an unused coupon and return its face value.
 *
 * Two separate hazards, both real:
 *
 *  1. Refunding a coupon whose money already left. The admin `/admin/coupon/resolve`
 *     void path has NO status check — it will happily stamp `void` onto a `paying`
 *     record — so a pre-existing `status === 'void'` proves nothing about whether
 *     we paid. The only trustworthy signal is winning the `issued -> void`
 *     transition ourselves, right here.
 *  2. Crashing after that transition but before the credit lands. Trusting only
 *     the transition would then strand the partner's money forever, because the
 *     retry sees `void` and (correctly) refuses to act on it.
 *
 * Hence `refundOpId`: the transition stamps a unique authorisation onto the
 * coupon, the credit is idempotent on that id, and a retry may trust THAT
 * marker — never bare `status === 'void'`.
 */
export async function voidPartnerCoupon(
  env: Env,
  args: {
    partnerId: string
    code: string
    kind?: 'void_refund' | 'expire_refund'
    audit?: Record<string, unknown>
  },
): Promise<{ balanceAfterAtomic: string; refundedAtomic: string }> {
  const kind = args.kind ?? 'void_refund'
  const refundOpId = newOpId() // outside the CAS callback

  const current = parseRecord(await casRead(env, couponKey(args.code)))
  if (!current || isTombstone(current)) {
    throw new PartnerError('COUPON_NOT_FOUND', 'no such coupon')
  }
  if (current.partnerId !== args.partnerId) {
    throw new PartnerError('NOT_YOUR_COUPON', 'coupon belongs to another partner')
  }

  // Step 1 — record the intent on the partner record first, so a crash before
  // the coupon flips still leaves a breadcrumb reachable from the partner.
  await casUpdate<void>(env, partnerKey(args.partnerId), (raw) => {
    const p = parsePartner(raw)
    if (!p) throw new PartnerError('PARTNER_NOT_FOUND', 'no such partner')
    if (p.pendingRefunds.some((r) => r.code === args.code)) return { op: 'noop', result: undefined }
    if (p.pendingRefunds.length >= MAX_PENDING_OPS) {
      throw new PartnerError('TOO_MANY_PENDING', 'too many unsettled refunds; retry shortly')
    }
    p.pendingRefunds.unshift({
      refundOpId,
      code: args.code,
      amountAtomic: current.amountAtomic,
      kind,
      at: Date.now(),
    })
    return { op: 'set', value: JSON.stringify(p), result: undefined }
  })

  // Step 2 — win the transition. `issued` only: `redeeming` means a redemption
  // is in flight, and `paying`/`redeemed` mean the money is already gone.
  const outcome = await casUpdate<{ ok: boolean; reason?: string; opId?: string }>(
    env,
    couponKey(args.code),
    (raw) => {
      const rec = parseRecord(raw)
      if (!rec) return { op: 'noop', result: { ok: false, reason: 'not found' } }
      if ((rec as CouponTombstone).tombstone) {
        return { op: 'noop', result: { ok: false, reason: 'tombstoned' } }
      }
      if (rec.partnerId !== args.partnerId) {
        return { op: 'noop', result: { ok: false, reason: 'not yours' } }
      }
      if (rec.status !== 'issued') {
        // Includes an already-`void` record: if it carries OUR refundOpId the
        // credit may still be owed, and settlePendingRefund handles that below.
        const owed = (rec as any).refundOpId as string | undefined
        return {
          op: 'noop',
          result: { ok: false, reason: `status=${rec.status}`, opId: owed },
        }
      }
      rec.status = 'void'
      ;(rec as any).refundOpId = refundOpId
      ;(rec as any).refundPending = true
      rec.attemptId = null
      rec.events.push({
        kind: 'partner_void',
        at: new Date().toISOString(),
        detail: { refundOpId, ...(args.audit ?? {}) },
      })
      return { op: 'set', value: JSON.stringify(rec), result: { ok: true, opId: refundOpId } }
    },
  )

  if (!outcome.ok) {
    // Not refundable. Drop the intent unless a prior attempt already authorised
    // a credit that never landed — settle that instead of dropping it.
    if (outcome.opId) {
      const settled = await settlePendingRefundById(env, args.partnerId, args.code, outcome.opId)
      if (settled) return settled
    }
    await dropPendingRefund(env, args.partnerId, args.code)
    throw new PartnerError('COUPON_NOT_REFUNDABLE', `cannot refund: ${outcome.reason}`, {
      reason: outcome.reason,
    })
  }

  const settled = await settlePendingRefundById(env, args.partnerId, args.code, refundOpId)
  if (!settled) throw new PartnerError('COUPON_NOT_REFUNDABLE', 'refund settle failed')
  return settled
}

async function settlePendingRefund(
  env: Env,
  partnerId: string,
  pr: PendingRefund,
): Promise<void> {
  const rec = parseRecord(await casRead(env, couponKey(pr.code)))
  const opId = rec ? ((rec as any).refundOpId as string | undefined) : undefined
  if (rec && rec.status === 'void' && opId) {
    await settlePendingRefundById(env, partnerId, pr.code, opId)
    return
  }
  // No credit is owed. Two cases, both drop the breadcrumb:
  //   - the coupon moved on (redeemed/paying/...) — never ours to refund
  //   - the coupon is still `issued`, i.e. we crashed between recording the
  //     intent and winning the transition, so no money moved at all
  // The second case used to fall through both branches and leak the
  // breadcrumb forever; 50 of those trip TOO_MANY_PENDING and block every
  // future void for that partner.
  await dropPendingRefund(env, partnerId, pr.code)
}

/** Credit the refund, keyed on the coupon's own `refundOpId` (never on `status`). */
async function settlePendingRefundById(
  env: Env,
  partnerId: string,
  code: string,
  refundOpId: string,
): Promise<{ balanceAfterAtomic: string; refundedAtomic: string } | null> {
  const rec = parseRecord(await casRead(env, couponKey(code)))
  if (!rec || (rec as any).refundOpId !== refundOpId) return null

  const entryId = newLedgerId()
  const kind: LedgerKind =
    (await getPartner(env, partnerId))?.pendingRefunds.find((r) => r.code === code)?.kind ??
    'void_refund'

  const res = await applyLedger(
    env,
    partnerId,
    {
      kind,
      deltaAtomic: BigInt(rec.amountAtomic),
      ref: code,
      entryId,
      idempotencyKey: `refund:${refundOpId}`,
    },
    (p) => {
      const i = p.pendingRefunds.findIndex((r) => r.code === code)
      if (i !== -1) p.pendingRefunds.splice(i, 1)
      // The coupon deliberately STAYS in couponIndex after a refund. Dropping
      // it made a voided coupon vanish from the partner's list, so the history
      // silently rewrote itself and "还没有发过卡密" showed up right after a
      // successful issue-then-void. The list is a ledger, not a to-do list:
      // voided, expired and redeemed entries all stay visible (founder
      // 2026-08-07). listPartnerCoupons renders each with its real status.
    },
  )

  await casUpdate<void>(env, couponKey(code), (raw) => {
    const r = parseRecord(raw)
    if (!r || (r as any).refundOpId !== refundOpId) return { op: 'noop', result: undefined }
    ;(r as any).refundPending = false
    r.refundLedgerId = res.entry?.id ?? r.refundLedgerId ?? entryId
    return { op: 'set', value: JSON.stringify(r), result: undefined }
  })

  return { balanceAfterAtomic: res.partner.balanceAtomic, refundedAtomic: rec.amountAtomic }
}

async function dropPendingRefund(env: Env, partnerId: string, code: string): Promise<void> {
  await casUpdate<void>(env, partnerKey(partnerId), (raw) => {
    const p = parsePartner(raw)
    if (!p) return { op: 'noop', result: undefined }
    const i = p.pendingRefunds.findIndex((r) => r.code === code)
    if (i === -1) return { op: 'noop', result: undefined }
    p.pendingRefunds.splice(i, 1)
    return { op: 'set', value: JSON.stringify(p), result: undefined }
  })
}

// ── Listing ──────────────────────────────────────────────────────────────────

export interface PartnerCouponView {
  code: string
  amountUsd: string
  status: CouponRecord['status'] | 'expired'
  issuedAt: string
  expiresAt: string
  refundable: boolean
}

/** Newest-first, from the bounded index. Runs reconcile first so the numbers a
 * partner sees are already repaired. */
export async function listPartnerCoupons(
  env: Env,
  partnerId: string,
  limit = MAX_COUPON_INDEX,
): Promise<PartnerCouponView[]> {
  await reconcilePending(env, partnerId)
  const p = await getPartner(env, partnerId)
  if (!p) return []
  const now = Date.now()
  const out: PartnerCouponView[] = []
  for (const idx of p.couponIndex.slice(0, limit)) {
    const rec = parseRecord(await casRead(env, couponKey(idx.code)))
    if (!rec || isTombstone(rec)) continue
    const expired = rec.status === 'issued' && Date.parse(rec.expiresAt) < now
    out.push({
      code: rec.code,
      amountUsd: rec.amountUsd,
      status: expired ? 'expired' : rec.status,
      issuedAt: rec.issuedAt,
      expiresAt: rec.expiresAt,
      // Only `issued` is refundable — see voidPartnerCoupon.
      refundable: rec.status === 'issued',
    })
  }
  return out
}

// ── Auth: password credentials, lockout, one-shot login tokens ───────────────
//
// These live here rather than in the route module for the same reason the money
// primitives do: they are the only things allowed to touch durable partner
// state. Routes call them; routes never CAS.
//
// Scope note (founder 2026-08-07): there is no signup, no self-serve password
// change, and no reset flow. We generate the credential, hand it over out of
// band, and the fallback for a lost password is an admin-minted login link.
// That deliberate absence is why this section stays small.

/** PBKDF2 work factor. 100k SHA-256 iterations is the specified floor; raising
 * it later is safe because `iterations` is stored per record and verification
 * replays whatever that record says. */
const PBKDF2_ITERATIONS = 100_000
const PBKDF2_KEY_BYTES = 32
const PBKDF2_SALT_BYTES = 16

/** Failed logins allowed per account per window before the account locks. */
export const AUTH_FAIL_LIMIT = 10
export const AUTH_FAIL_WINDOW_MS = 60 * 60_000
export const AUTH_LOCK_MS = 60 * 60_000

/** 15 minutes, single use (§3.10). Long enough to paste into a chat app, short
 * enough that a leaked link in a message history is worthless. */
export const LOGIN_TOKEN_TTL_MS = 15 * 60_000

export const authFailKey = (partnerId: string) => `pauthfail:${partnerId}`
export const loginTokenKey = (tokenHash: string) => `plogin:${tokenHash}`

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Compare two hex digests without leaking a matching prefix through timing.
 * `crypto.subtle.timingSafeEqual` exists on the Workers runtime but not
 * everywhere these tests run, so fall back to a full-width loop that always
 * touches every byte (no early return).
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = fromHex(a)
  const bb = fromHex(b)
  if (ab.length !== bb.length) return false
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean
  }
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(ab, bb)
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

async function pbkdf2(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' },
    key,
    PBKDF2_KEY_BYTES * 8,
  )
  return toHex(bits)
}

/**
 * Mint a password for a partner. Unambiguous alphabet (no 0/O/1/l/I) because a
 * human copies this out of a chat message. 20 chars over a 32-symbol alphabet
 * is 100 bits — far past anything the lockout would ever have to defend.
 */
/**
 * Word list for partner passphrases. Hand-picked to survive being read aloud
 * over a call or typed on a phone: no homophones, no l/1 or O/0 lookalikes,
 * nothing that autocorrect rewrites.
 */
const PASSPHRASE_WORDS = [
  'anchor', 'amber', 'basil', 'beacon', 'birch', 'bison', 'bramble', 'bronze',
  'cactus', 'canyon', 'cedar', 'cobalt', 'copper', 'coral', 'cotton', 'crimson',
  'dahlia', 'delta', 'denim', 'dolphin', 'ember', 'falcon', 'fennel', 'ferry',
  'flint', 'fossil', 'garnet', 'ginger', 'granite', 'harbor', 'hazel', 'heron',
  'indigo', 'ivory', 'jasper', 'juniper', 'kelp', 'lantern', 'lagoon', 'lilac',
  'linen', 'lumber', 'magnet', 'mahogany', 'maple', 'marble', 'meadow', 'mint',
  'mustard', 'nectar', 'nutmeg', 'oakwood', 'olive', 'onyx', 'orchid', 'otter',
  'pebble', 'pepper', 'pewter', 'pigeon', 'pine', 'plum', 'pumpkin', 'quartz',
  'quiver', 'radish', 'raven', 'ribbon', 'rustic', 'saffron', 'sage', 'salmon',
  'sandbar', 'sapphire', 'sequoia', 'shadow', 'silver', 'sparrow', 'spruce',
  'sterling', 'sugar', 'summit', 'sunset', 'tangerine', 'teal', 'thistle',
  'timber', 'topaz', 'tulip', 'turquoise', 'velvet', 'walnut', 'wheat',
  'willow', 'winter', 'yarrow', 'zinc',
]

/** Unbiased pick via rejection sampling — a plain modulus over 97 words would
 * skew toward the front of the list. */
function pickWord(): string {
  const n = PASSPHRASE_WORDS.length
  const limit = Math.floor(256 / n) * n
  const buf = new Uint8Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return PASSPHRASE_WORDS[buf[0] % n]
  }
}

/**
 * `word-word-NN` — memorable enough to read down a phone line, which is how
 * this actually gets delivered (founder 2026-08-07: "两个单词，让他能说").
 *
 * Entropy is ~97^2 x 90 ≈ 850k combinations, which would be far too weak on
 * its own. It is only acceptable because `POST /partner/auth/login` locks the
 * account after 10 failures per hour: an attacker gets ~87,600 guesses a year,
 * so exhausting the space takes ~10 years and the expected hit is ~5. If that
 * lockout is ever loosened, this generator has to get longer in the same
 * change — the two numbers are load-bearing together.
 */
export function generatePartnerPassword(): string {
  const buf = new Uint8Array(1)
  crypto.getRandomValues(buf)
  // 0-89 from a byte: reject the tail so the two digits stay uniform.
  let n = buf[0]
  while (n >= 180) {
    crypto.getRandomValues(buf)
    n = buf[0]
  }
  return `${pickWord()}-${pickWord()}-${10 + (n % 90)}`
}

/** Derive and store a credential. The plaintext is never persisted or logged. */
export async function setPartnerPassword(
  env: Env,
  partnerId: string,
  password: string,
): Promise<void> {
  const saltBytes = new Uint8Array(PBKDF2_SALT_BYTES)
  crypto.getRandomValues(saltBytes)
  const salt = toHex(saltBytes.buffer)
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS)
  const auth: PartnerAuth = {
    algo: 'PBKDF2-SHA256',
    salt,
    hash,
    iterations: PBKDF2_ITERATIONS,
    setAt: new Date().toISOString(),
  }
  await casUpdate<void>(env, partnerKey(partnerId), (raw) => {
    const p = parsePartner(raw)
    if (!p) throw new PartnerError('PARTNER_NOT_FOUND', `no partner ${partnerId}`)
    p.auth = auth
    return { op: 'set', value: JSON.stringify(p), result: undefined }
  })
}

/**
 * Verify a password against a stored credential.
 *
 * Takes the credential rather than a partner id so the caller can run the SAME
 * derivation for an unknown account (by passing `decoyAuth()`), which is what
 * keeps "no such user" and "wrong password" indistinguishable.
 */
export async function verifyPassword(
  auth: PartnerAuth | undefined,
  password: string,
): Promise<boolean> {
  if (!auth) return false
  const derived = await pbkdf2(password, auth.salt, auth.iterations)
  return constantTimeEqualHex(derived, auth.hash)
}

/** A throwaway credential so an unknown username burns the same work. Its empty
 * hash can never match a 32-byte derivation. */
export function decoyAuth(): PartnerAuth {
  return {
    algo: 'PBKDF2-SHA256',
    salt: '00000000000000000000000000000000',
    hash: '',
    iterations: PBKDF2_ITERATIONS,
    setAt: new Date(0).toISOString(),
  }
}

interface AuthFailState {
  /** Failure timestamps inside the current window. */
  ts: number[]
  lockedUntil?: number
}

/** Read-only lock check. */
export async function isAuthLocked(env: Env, partnerId: string): Promise<boolean> {
  const raw = await casRead(env, authFailKey(partnerId))
  if (!raw) return false
  try {
    const s = JSON.parse(raw) as AuthFailState
    return !!s.lockedUntil && s.lockedUntil > Date.now()
  } catch {
    return false
  }
}

/**
 * Record one failed login. Rolling window in a single CAS — two isolates cannot
 * each read "9" and both believe they are the tenth-and-only. Returns whether
 * the account is now locked.
 */
export async function recordAuthFailure(env: Env, partnerId: string): Promise<boolean> {
  const now = Date.now()
  return casUpdate<boolean>(env, authFailKey(partnerId), (raw) => {
    let s: AuthFailState = { ts: [] }
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as AuthFailState
        if (parsed && Array.isArray(parsed.ts)) s = parsed
      } catch {
        /* a corrupt counter must not become a free pass; treat as empty */
      }
    }
    if (s.lockedUntil && s.lockedUntil > now) return { op: 'noop', result: true }
    const ts = s.ts.filter((t) => t > now - AUTH_FAIL_WINDOW_MS)
    ts.push(now)
    const locked = ts.length >= AUTH_FAIL_LIMIT
    const next: AuthFailState = locked
      ? { ts: [], lockedUntil: now + AUTH_LOCK_MS }
      : { ts: ts.slice(-AUTH_FAIL_LIMIT) }
    return { op: 'set', value: JSON.stringify(next), result: locked }
  })
}

/** Clear the counter after a successful login. */
export async function clearAuthFailures(env: Env, partnerId: string): Promise<void> {
  await casUpdate<void>(env, authFailKey(partnerId), () => ({
    op: 'set',
    value: JSON.stringify({ ts: [] } satisfies AuthFailState),
    result: undefined,
  }))
}

async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)))
}

/**
 * Mint a one-shot login token. Only its SHA-256 is stored, so a dump of the DO
 * cannot be replayed as a login. The token is 32 random bytes, so the digest
 * needs neither salt nor work factor.
 */
export async function createLoginToken(env: Env, partnerId: string): Promise<string> {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  const token = toHex(raw.buffer)
  const digest = await sha256Hex(token)
  await casUpdate<void>(env, loginTokenKey(digest), () => ({
    op: 'set',
    value: JSON.stringify({ partnerId, exp: Date.now() + LOGIN_TOKEN_TTL_MS, used: false }),
    result: undefined,
  }))
  return token
}

/**
 * Consume a login token. Single use is enforced by the CAS itself, so two
 * concurrent clicks on the same link cannot both authenticate.
 */
export async function consumeLoginToken(env: Env, token: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null
  const digest = await sha256Hex(token)
  return casUpdate<string | null>(env, loginTokenKey(digest), (raw) => {
    if (!raw) return { op: 'noop', result: null }
    let rec: { partnerId: string; exp: number; used: boolean }
    try {
      rec = JSON.parse(raw)
    } catch {
      return { op: 'noop', result: null }
    }
    if (rec.used || rec.exp < Date.now()) return { op: 'noop', result: null }
    return { op: 'set', value: JSON.stringify({ ...rec, used: true }), result: rec.partnerId }
  })
}

// ── Coupon lookup + audit (tenant-scoped, no money) ──────────────────────────

/**
 * Read one of a partner's OWN coupons. Returns null both for "does not exist"
 * and "belongs to someone else", so it cannot be used to probe whether a code
 * exists under another account.
 */
export async function readPartnerCoupon(
  env: Env,
  partnerId: string,
  code: string,
): Promise<CouponRecord | null> {
  const rec = parseRecord(await casRead(env, couponKey(code)))
  if (!rec || isTombstone(rec)) return null
  if (rec.partnerId !== partnerId) return null
  return rec
}

/**
 * Append an audit entry to a coupon's event chain without touching its status.
 *
 * Needed because a REFUSED void must still be recorded, and the refusal happens
 * before `voidPartnerCoupon` writes anything. Tenant-scoped and status-neutral:
 * it can only ever add to `events`.
 */
export async function appendCouponAuditEvent(
  env: Env,
  partnerId: string,
  code: string,
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await casUpdate<void>(env, couponKey(code), (raw) => {
    const rec = parseRecord(raw)
    if (!rec || isTombstone(rec) || rec.partnerId !== partnerId) {
      return { op: 'noop', result: undefined }
    }
    rec.events = Array.isArray(rec.events) ? rec.events : []
    rec.events.push({ kind, at: new Date().toISOString(), detail })
    return { op: 'set', value: JSON.stringify(rec), result: undefined }
  })
}
