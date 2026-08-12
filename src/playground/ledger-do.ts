/**
 * `PlaygroundLedger` — Durable Object holding all playground money state.
 *
 * ---------------------------------------------------------------------------
 * Why a Durable Object, and why one instance
 * ---------------------------------------------------------------------------
 * Every operation here is a read-modify-write on money: crediting a verified
 * deposit, reserving a call's maximum price, committing the actual price. A
 * Durable Object serialises requests to a single instance, so these are
 * genuinely atomic without a CAS retry loop — unlike the KV-backed
 * `AtomicStoreDO` callers, which must retry on version conflicts.
 *
 * All playground state lives in ONE instance (`idFromName('playground')`)
 * because two of the invariants are inherently global:
 *
 *   - the global outstanding-credit cap (sum of all balances ≤ cap), and
 *   - `(tx_hash, op_index)` single-consumption, which must hold across
 *     accounts or one deposit could be claimed twice by two intents.
 *
 * Sharding by account would break both. Playground traffic is a demo surface
 * on a landing page; a single DO's throughput is not the binding constraint.
 *
 * ---------------------------------------------------------------------------
 * Money representation
 * ---------------------------------------------------------------------------
 * Every amount crossing this boundary — in the JSON API, in storage — is a
 * **7-decimal USDC atomic integer as a decimal string** ("10000000" = $1.00).
 * There is no `number` amount anywhere in this file. See `./amount.ts`.
 *
 * ---------------------------------------------------------------------------
 * Internal HTTP API (POST only, JSON in / JSON out)
 * ---------------------------------------------------------------------------
 *   /intent/create  → mint a deposit intent, after rate + cap checks
 *   /intent/get     → read an intent by id
 *   /open           → consume (tx_hash, op_index), credit balance, bind session
 *   /account        → balance + recent call history
 *   /reserve        → hold `max_price` against a balance for one call
 *   /settle         → commit (charge `actual`) or release (refund the hold)
 *   /totals         → aggregate figures for the solvency recon script
 *
 * ---------------------------------------------------------------------------
 * Storage key layout
 * ---------------------------------------------------------------------------
 *   intent:<intent_id>          → StoredIntent
 *   memo:<memo>                 → intent_id            (memo uniqueness)
 *   consumed:<tx_hash>:<op_idx> → intent_id            (replay guard)
 *   bal:<account>               → atomic string        (spendable balance)
 *   dep:<account>:<yyyy-mm-dd>  → atomic string        (per-day deposit total)
 *   rl:<account>:<yyyy-mm-ddThh>→ integer string       (intent rate window)
 *   call:<call_id>              → StoredCall
 *   hist:<account>              → string[] of call ids, newest first, capped
 *   total:credited              → atomic string        (lifetime deposits in)
 *   total:committed             → atomic string        (lifetime charges out)
 *   total:outstanding           → atomic string        (Σ balances + Σ holds)
 *
 * `total:outstanding` is maintained incrementally rather than recomputed: it
 * is the quantity the global cap is enforced against on every intent, and
 * scanning every account for each intent would make the cap check O(accounts).
 * The recon script recomputes it from a full scan and fails loudly on drift.
 */

import { parseAtomic } from './amount'

/** UTC `yyyy-mm-dd`, the per-account deposit-cap window. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** UTC `yyyy-mm-ddThh`, the intent-creation rate-limit window. */
export function utcHourKey(now: number): string {
  return new Date(now).toISOString().slice(0, 13)
}

export type IntentStatus = 'open' | 'consumed' | 'expired' | 'over_cap'

export interface StoredIntent {
  intent_id: string
  account: string
  /** Atomic 7-decimal USDC string. */
  amount: string
  memo: string
  /**
   * The receiving address quoted to the user AT INTENT CREATION.
   *
   * `session/open` verifies the on-chain payment against this, not against the
   * live `STELLAR_ROUTER_PUBLIC`. Otherwise rotating the router's receiving
   * account would brick every deposit already in flight: the user paid the
   * address we told them, and that promise has to outlive a config change.
   */
  destination: string
  created_at: number
  expires_at: number
  status: IntentStatus
  /** Set once consumed. */
  tx_hash?: string
  op_index?: number
  /** Session jti minted at open time, so a re-open returns the same session. */
  session_jti?: string
  session_exp?: number
}

export type CallStatus = 'reserved' | 'committed' | 'released'

export interface StoredCall {
  call_id: string
  account: string
  chip: string
  model?: string
  status: CallStatus
  /** Atomic string: the amount held at reserve time. */
  max_price: string
  /** Atomic string: the amount actually charged (0 until committed). */
  charged: string
  at: number
  /**
   * Set atomically right BEFORE the upstream fetch. The reaper needs this to
   * tell "the worker died before any payment attempt" (release — nothing was
   * ever dispatched or paid) from "the worker died mid/post upstream call"
   * (commit — the reserve→dispatch window brackets the paid call).
   */
  dispatched?: boolean
  /** Set when released, for operator forensics. */
  release_reason?: string
  /**
   * Set when a call was committed OR released by the stale-call reaper rather
   * than by its own request. Support uses this to find calls whose user may deserve a
   * goodwill credit — the router paid upstream, but the response never reached
   * the user.
   */
  reaped?: boolean
}

export interface ReserveOutcome {
  ok: boolean
  /** Present when ok=false. */
  code?: 'insufficient_balance'
  call: StoredCall | null
  /** Balance after the operation, atomic string. */
  balance: string
  /**
   * True when this call_id was already known — the caller is retrying and
   * must NOT re-run the upstream side effect if the call already settled.
   */
  duplicate: boolean
}

interface Ok<T> {
  ok: true
  value: T
}
interface Err {
  ok: false
  code: string
  message: string
  /** Extra context the route layer surfaces to the caller. */
  detail?: Record<string, string | number>
}
type Result<T> = Ok<T> | Err

function err(code: string, message: string, detail?: Record<string, string | number>): Err {
  return { ok: false, code, message, detail }
}

/**
 * How long a call may sit in `reserved` before the reaper settles it.
 *
 * Comfortably longer than the 30s upstream timeout plus retries, so a healthy
 * in-flight call is never reaped out from under itself.
 */
export const RESERVED_LEASE_MS = 5 * 60 * 1000

/** How often the reaper wakes while any reserved call exists. */
export const REAPER_INTERVAL_MS = 60 * 1000

export class PlaygroundLedger implements DurableObject {
  private readonly storage: DurableObjectStorage

  constructor(state: DurableObjectState) {
    this.storage = state.storage
  }

  /**
   * Reaper for calls stranded in `reserved`.
   *
   * A call is stranded when the request died between taking the hold and
   * settling it — most often a commit that failed AFTER the upstream had
   * already delivered. Left alone the hold is frozen forever and, worse, the
   * `call_id` retry short-circuit returns `duplicate` for a call that never
   * produced a result.
   *
   * Stale reserved calls are COMMITTED, not released. The reserve→settle
   * window brackets the paid upstream call, so a call that entered it and
   * never came back most likely did dispatch and cost the router real money.
   * Releasing would hand out free API calls to anyone who can make the
   * response leg fail; committing is the same "when in doubt, the money moved"
   * rule the failure path uses. Each reaped call is flagged `reaped: true` so
   * support can find them and issue goodwill credit where the user genuinely
   * got nothing.
   */
  // KNOWN CRASH WINDOW (accepted, recon-monitored): this reaper settles a call
  // across several separate storage writes (call record, balance, the two
  // totals) that are NOT one atomic transaction, and it acts on a `dispatched`
  // marker that could have been set just before a mid-call worker crash. So a
  // reaper decision can, in rare mid-call-termination cases, commit a call that
  // never actually paid upstream (or vice versa). This is inherent to
  // Worker+DO across awaits and is deliberately NOT made crash-atomic here.
  // Exposure is bounded by a single call's price, and every such anomaly is
  // detectable by scripts/admin/playground-recon.ts: a reaper-committed call
  // with no matching on-chain deposit surfaces as a per-op binding mismatch,
  // and the committed-total vs on-chain reconciliation flags the aggregate.
  async alarm(): Promise<void> {
    const now = Date.now()
    const calls = await this.storage.list<StoredCall>({ prefix: 'call:' })
    let remaining = 0

    for (const [key, call] of calls) {
      if (call.status !== 'reserved') continue
      if (now - call.at < RESERVED_LEASE_MS) {
        remaining++
        continue
      }
      const held = parseAtomic(call.max_price)
      const balKey = `bal:${call.account}`
      const balance = parseAtomic((await this.storage.get<string>(balKey)) ?? '0')
      const ageSec = Math.round((now - call.at) / 1000)

      if (!call.dispatched) {
        // The worker died AFTER reserving but BEFORE marking dispatch, so no
        // upstream request — and no payment — was ever attempted. Refund the
        // full hold.
        await this.storage.put(key, {
          ...call,
          status: 'released',
          charged: '0',
          release_reason: 'reaped_never_dispatched',
          reaped: true,
        } satisfies StoredCall)
        await this.storage.put(balKey, (balance + held).toString())
        await this.storage.put(
          'total:outstanding',
          (parseAtomic((await this.storage.get<string>('total:outstanding')) ?? '0') - held).toString(),
        )
        console.warn(
          `[playground-ledger] reaped UNDISPATCHED call ${call.call_id} (chip=${call.chip}) ` +
            `after ${ageSec}s; released ${held} atomic`,
        )
        continue
      }

      // Dispatched but never settled: the reserve→dispatch window brackets the
      // paid upstream call, so this most likely cost the router money.
      // Committed at the full hold — no evidence of the actual price, and the
      // hold is the ceiling the user already agreed to. Releasing would hand
      // out free calls to anyone who can strand a call after dispatch.
      await this.storage.put(key, {
        ...call,
        status: 'committed',
        charged: held.toString(),
        reaped: true,
      } satisfies StoredCall)
      await this.storage.put(balKey, balance.toString())
      await this.storage.put(
        'total:committed',
        (parseAtomic((await this.storage.get<string>('total:committed')) ?? '0') + held).toString(),
      )
      await this.storage.put(
        'total:outstanding',
        (parseAtomic((await this.storage.get<string>('total:outstanding')) ?? '0') - held).toString(),
      )
      console.warn(
        `[playground-ledger] reaped DISPATCHED call ${call.call_id} (chip=${call.chip}) ` +
          `after ${ageSec}s; committed ${held} atomic`,
      )
    }

    // Keep waking while anything is still in flight; otherwise let the alarm
    // lapse so an idle DO costs nothing.
    if (remaining > 0) await this.storage.setAlarm(now + REAPER_INTERVAL_MS)
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const url = new URL(request.url)
    let body: any
    try {
      body = await request.json()
    } catch {
      return new Response('Bad Request: invalid JSON', { status: 400 })
    }
    switch (url.pathname) {
      case '/intent/create':
        return Response.json(await this.createIntent(body))
      case '/intent/get':
        return Response.json(await this.getIntent(body))
      case '/open':
        return Response.json(await this.open(body))
      case '/account':
        return Response.json(await this.account(body))
      case '/reserve':
        return Response.json(await this.reserve(body))
      case '/dispatch':
        return Response.json(await this.markDispatched(body))
      case '/settle':
        return Response.json(await this.settle(body))
      case '/totals':
        return Response.json(await this.totals())
      default:
        return new Response('Not Found', { status: 404 })
    }
  }

  // -------------------------------------------------------------------------
  // small storage helpers
  // -------------------------------------------------------------------------

  private async readAtomic(key: string): Promise<bigint> {
    return parseAtomic(await this.storage.get<string>(key))
  }

  private async addAtomic(key: string, delta: bigint): Promise<bigint> {
    const next = (await this.readAtomic(key)) + delta
    await this.storage.put(key, next.toString())
    return next
  }

  // -------------------------------------------------------------------------
  // /intent/create
  // -------------------------------------------------------------------------

  /**
   * Mint a deposit intent after checking, in order: intent-creation rate
   * limit, per-account daily deposit cap, global outstanding-credit cap.
   *
   * The caps are checked against what the deposit WOULD add if it lands. An
   * intent is a reservation of headroom under both caps, not a promise of
   * funds — an unclaimed intent expires and its headroom is only actually
   * consumed at `/open`. That is deliberate: reserving the headroom at intent
   * time would let anyone exhaust the global cap for free by minting intents
   * they never pay.
   */
  private async createIntent(body: {
    intent_id: string
    account: string
    amount: string
    memo: string
    destination: string
    now: number
    expires_at: number
    per_account_day_cap: string
    global_cap: string
    intents_per_hour: number
    max_open_intents: number
  }): Promise<Result<StoredIntent>> {
    const amount = parseAtomic(body.amount)
    if (amount <= 0n) return err('invalid_amount', 'deposit amount must be positive')

    return this.storage.transaction(async txn => {
      // Rate limit first — it is the cheapest check and the one an abusive
      // caller hits most, so it should short-circuit the rest.
      const rlKey = `rl:${body.account}:${utcHourKey(body.now)}`
      const used = parseAtomic((await txn.get<string>(rlKey)) ?? '0')
      if (used >= BigInt(body.intents_per_hour)) {
        return err('rate_limited', 'too many deposit intents for this account', {
          retry_after_seconds: secondsUntilNextHour(body.now),
        })
      }

      // Per-account daily deposit cap.
      const depKey = `dep:${body.account}:${utcDayKey(body.now)}`
      const depositedToday = parseAtomic((await txn.get<string>(depKey)) ?? '0')
      const dayCap = parseAtomic(body.per_account_day_cap)
      if (depositedToday + amount > dayCap) {
        return err('deposit_cap_exceeded', 'daily deposit cap reached for this account', {
          deposited_today: depositedToday.toString(),
          cap: dayCap.toString(),
        })
      }

      // Global outstanding-credit cap.
      const outstanding = parseAtomic((await txn.get<string>('total:outstanding')) ?? '0')
      const globalCap = parseAtomic(body.global_cap)
      if (outstanding + amount > globalCap) {
        return err('global_cap_exceeded', 'playground is at its global credit ceiling', {
          outstanding: outstanding.toString(),
          cap: globalCap.toString(),
        })
      }

      // Hard ceiling on stored intents per account. The hourly rate limit
      // bounds the RATE of storage growth; this bounds the TOTAL, so an
      // attacker cycling addresses cannot grow DO storage without bound by
      // minting intents forever and never claiming them.
      const openKey = `open:${body.account}`
      const openCount = parseAtomic((await txn.get<string>(openKey)) ?? '0')
      if (openCount >= BigInt(body.max_open_intents)) {
        return err('too_many_open_intents', 'too many unclaimed deposit intents for this account', {
          open_intents: openCount.toString(),
          max: body.max_open_intents,
        })
      }

      // Memo collision would make two intents indistinguishable on-chain.
      // Astronomically unlikely with a 128-bit nonce, fatal if it happened.
      if (await txn.get<string>(`memo:${body.memo}`)) {
        return err('memo_collision', 'memo nonce collision, retry')
      }

      const intent: StoredIntent = {
        intent_id: body.intent_id,
        account: body.account,
        amount: amount.toString(),
        memo: body.memo,
        destination: body.destination,
        created_at: body.now,
        expires_at: body.expires_at,
        status: 'open',
      }
      await txn.put(`intent:${body.intent_id}`, intent)
      await txn.put(`memo:${body.memo}`, body.intent_id)
      await txn.put(rlKey, (used + 1n).toString())
      await txn.put(openKey, (openCount + 1n).toString())
      return { ok: true as const, value: intent }
    })
  }

  private async getIntent(body: { intent_id: string }): Promise<Result<StoredIntent>> {
    const intent = await this.storage.get<StoredIntent>(`intent:${body.intent_id}`)
    if (!intent) return err('intent_not_found', 'unknown intent')
    return { ok: true, value: intent }
  }

  // -------------------------------------------------------------------------
  // /open
  // -------------------------------------------------------------------------

  /**
   * Consume a verified on-chain deposit and credit the account.
   *
   * The caller (route layer) has already verified against Horizon that the
   * transaction is successful, carries the intent's memo, and contains a
   * payment operation with the exact destination / asset / amount / source.
   * This method owns the parts that must be atomic:
   *
   *   1. `(tx_hash, op_index)` is consumed at most once, globally;
   *   2. that pair is bound to THIS intent, so a payment cannot be replayed
   *      against a second intent;
   *   3. the credit and the daily-deposit tally move together.
   *
   * Idempotency: re-opening with the same intent AND the same (tx, op) is a
   * success that returns the originally minted session, so a client retrying
   * a dropped response gets its session rather than a confusing error. Any
   * other combination is a conflict.
   */
  private async open(body: {
    intent_id: string
    tx_hash: string
    op_index: number
    now: number
    /** On-chain ledger close time of the deposit, ms. Compared to expiry. */
    confirmed_at: number
    session_jti: string
    session_exp: number
    per_account_day_cap: string
    global_cap: string
  }): Promise<Result<{ intent: StoredIntent; balance: string; replayed: boolean }>> {
    return this.storage.transaction(async txn => {
      const intent = await txn.get<StoredIntent>(`intent:${body.intent_id}`)
      if (!intent) return err('intent_not_found', 'unknown intent')

      const consumedKey = `consumed:${body.tx_hash}:${body.op_index}`
      const consumedBy = await txn.get<string>(consumedKey)

      if (intent.status === 'over_cap') {
        // Terminal: the deposit landed on-chain but crediting it would breach
        // a ceiling. Re-submitting must keep reporting the same thing rather
        // than retrying the cap check, so support has one stable state.
        return err('deposit_exceeds_cap', 'deposit exceeds the playground credit cap', {
          intent_id: intent.intent_id,
        })
      }

      if (intent.status === 'consumed') {
        // Idempotent replay only if it is the same payment against the same
        // intent. Otherwise someone is trying to reuse a spent intent.
        if (intent.tx_hash === body.tx_hash && intent.op_index === body.op_index) {
          const balance = parseAtomic((await txn.get<string>(`bal:${intent.account}`)) ?? '0')
          // Session RENEWAL. While the recorded session is still valid we hand
          // back the SAME identity, so a retry cannot mint a second token or
          // extend the TTL. But once it has expired, re-opening within the
          // hard renewal window (enforced by the route via body.session_exp)
          // must issue a FRESH session — returning the stale, already-expired
          // jti/exp here is what stranded the balance behind a permanent 410.
          const renew =
            intent.session_exp === undefined || intent.session_exp <= body.now / 1000
          const returned: StoredIntent = renew
            ? { ...intent, session_jti: body.session_jti, session_exp: body.session_exp }
            : intent
          if (renew) await txn.put(`intent:${body.intent_id}`, returned)
          return {
            ok: true as const,
            value: { intent: returned, balance: balance.toString(), replayed: true },
          }
        }
        return err('intent_already_used', 'this intent has already been claimed')
      }

      // The intent is open — so this payment must not already belong to some
      // OTHER intent.
      if (consumedBy) {
        return err('payment_already_claimed', 'this payment operation was already credited')
      }

      // Expiry is judged by when the payment CONFIRMED on-chain, not by when
      // the user got around to claiming it. A deposit that settled inside the
      // window is the user's money regardless of how long the claim took;
      // using claim time would silently swallow late-claimed valid deposits.
      if (body.confirmed_at > intent.expires_at) {
        // Mark it so a later read reports the real reason rather than "open".
        await txn.put(`intent:${body.intent_id}`, { ...intent, status: 'expired' as const })
        await this.releaseOpenSlot(txn, intent.account)
        return err('intent_expired', 'deposit was confirmed on-chain after the intent expired')
      }

      const amount = parseAtomic(intent.amount)

      // ---- Ceilings, enforced HERE at credit mint ------------------------
      // The checks at intent creation are advisory headroom only: they hold
      // nothing, so N intents can each pass them and then all be opened. This
      // is the enforcement point that actually bounds outstanding credit.
      // Keyed by the ON-CHAIN confirmation day, not the claim day. Keying by
      // claim time would let an attacker spread claims of same-day deposits
      // across later calendar days to slip past the per-day cap.
      const depKey = `dep:${intent.account}:${utcDayKey(body.confirmed_at)}`
      const depositedToday = parseAtomic((await txn.get<string>(depKey)) ?? '0')
      const dayCap = parseAtomic(body.per_account_day_cap)
      const outstanding = parseAtomic((await txn.get<string>('total:outstanding')) ?? '0')
      const globalCap = parseAtomic(body.global_cap)

      const overDay = depositedToday + amount > dayCap
      const overGlobal = outstanding + amount > globalCap
      if (overDay || overGlobal) {
        // The money is already on-chain, so this cannot be a soft refusal that
        // leaves the intent claimable. Record a terminal state plus everything
        // support needs to refund out of band, and do NOT consume the
        // (tx, op) pair — leaving it unconsumed keeps the door open for an
        // operator to credit it manually once the ceiling is raised.
        const overCap: StoredIntent = {
          ...intent,
          status: 'over_cap',
          tx_hash: body.tx_hash,
          op_index: body.op_index,
        }
        await txn.put(`intent:${body.intent_id}`, overCap)
        await this.releaseOpenSlot(txn, intent.account)
        await txn.put(`overcap:${body.intent_id}`, {
          intent_id: body.intent_id,
          account: intent.account,
          amount: intent.amount,
          tx_hash: body.tx_hash,
          op_index: body.op_index,
          reason: overDay ? 'deposit_cap_exceeded' : 'global_cap_exceeded',
          at: body.now,
        })
        return err('deposit_exceeds_cap', 'deposit exceeds the playground credit cap', {
          reason: overDay ? 'deposit_cap_exceeded' : 'global_cap_exceeded',
          deposited_today: depositedToday.toString(),
          day_cap: dayCap.toString(),
          outstanding: outstanding.toString(),
          global_cap: globalCap.toString(),
        })
      }

      const balKey = `bal:${intent.account}`
      const balance = parseAtomic((await txn.get<string>(balKey)) ?? '0')

      const updated: StoredIntent = {
        ...intent,
        status: 'consumed',
        tx_hash: body.tx_hash,
        op_index: body.op_index,
        session_jti: body.session_jti,
        session_exp: body.session_exp,
      }

      await txn.put(consumedKey, body.intent_id)
      await txn.put(`intent:${body.intent_id}`, updated)
      await this.releaseOpenSlot(txn, intent.account)
      await txn.put(balKey, (balance + amount).toString())
      await txn.put(depKey, (depositedToday + amount).toString())
      await txn.put(
        'total:credited',
        (parseAtomic((await txn.get<string>('total:credited')) ?? '0') + amount).toString(),
      )
      await txn.put('total:outstanding', (outstanding + amount).toString())

      return {
        ok: true as const,
        value: { intent: updated, balance: (balance + amount).toString(), replayed: false },
      }
    })
  }

  /** Give back one open-intent slot when an intent reaches a terminal state. */
  private async releaseOpenSlot(txn: DurableObjectTransaction, account: string): Promise<void> {
    const key = `open:${account}`
    const current = parseAtomic((await txn.get<string>(key)) ?? '0')
    await txn.put(key, (current > 0n ? current - 1n : 0n).toString())
  }

  // -------------------------------------------------------------------------
  // /account
  // -------------------------------------------------------------------------

  private async account(body: {
    account: string
    limit: number
  }): Promise<Result<{ balance: string; calls: StoredCall[] }>> {
    const balance = await this.readAtomic(`bal:${body.account}`)
    const ids = (await this.storage.get<string[]>(`hist:${body.account}`)) ?? []
    const calls: StoredCall[] = []
    for (const id of ids.slice(0, body.limit)) {
      const call = await this.storage.get<StoredCall>(`call:${id}`)
      if (call) calls.push(call)
    }
    return { ok: true, value: { balance: balance.toString(), calls } }
  }

  // -------------------------------------------------------------------------
  // /reserve
  // -------------------------------------------------------------------------

  /**
   * Hold `max_price` against the account before the upstream call runs.
   *
   * Reserving the MAXIMUM (not the expected) price is what makes the flat
   * playground price safe: the balance can never go negative no matter what
   * the upstream ends up costing, and the difference is returned at commit.
   *
   * `call_id` is the idempotency key for the whole call. A retry with the same
   * id returns `duplicate: true` plus the recorded call, and the route layer
   * must then return the recorded outcome rather than re-running the upstream
   * request — that is the property that makes a double-submitted playground
   * request charge once.
   */
  private async reserve(body: {
    call_id: string
    account: string
    chip: string
    model?: string
    max_price: string
    now: number
    history_limit: number
  }): Promise<Result<ReserveOutcome>> {
    const maxPrice = parseAtomic(body.max_price)
    if (maxPrice < 0n) return err('invalid_amount', 'max_price must not be negative')

    const result = await this.storage.transaction(async txn => {
      const existing = await txn.get<StoredCall>(`call:${body.call_id}`)
      if (existing) {
        const balance = parseAtomic((await txn.get<string>(`bal:${existing.account}`)) ?? '0')
        return {
          ok: true as const,
          value: {
            ok: true,
            call: existing,
            balance: balance.toString(),
            duplicate: true,
          },
        }
      }

      const balKey = `bal:${body.account}`
      const balance = parseAtomic((await txn.get<string>(balKey)) ?? '0')
      if (balance < maxPrice) {
        return {
          ok: true as const,
          value: {
            ok: false,
            code: 'insufficient_balance' as const,
            call: null,
            balance: balance.toString(),
            duplicate: false,
          },
        }
      }

      const call: StoredCall = {
        call_id: body.call_id,
        account: body.account,
        chip: body.chip,
        model: body.model,
        status: 'reserved',
        max_price: maxPrice.toString(),
        charged: '0',
        at: body.now,
      }
      const remaining = balance - maxPrice
      await txn.put(balKey, remaining.toString())
      await txn.put(`call:${body.call_id}`, call)

      const histKey = `hist:${body.account}`
      const hist = (await txn.get<string[]>(histKey)) ?? []
      hist.unshift(body.call_id)
      await txn.put(histKey, hist.slice(0, body.history_limit))

      return {
        ok: true as const,
        value: { ok: true, call, balance: remaining.toString(), duplicate: false },
      }
    })

    if (result.ok && result.value.ok && !result.value.duplicate) {
      // Arm the reaper outside the transaction. setAlarm is idempotent-ish —
      // an existing earlier alarm is kept so we never push the deadline out.
      const existing = await this.storage.getAlarm()
      if (existing === null) await this.storage.setAlarm(body.now + REAPER_INTERVAL_MS)
    }
    return result
  }

  // -------------------------------------------------------------------------
  // /settle  (commit or release)
  // -------------------------------------------------------------------------

  /**
   * Mark a reserved call as dispatched, right before the upstream fetch.
   *
   * This is what lets the reaper tell a call that died before any payment
   * attempt (release) from one that died mid/post upstream call (commit). It
   * is a no-op on a call that has already settled or already been marked, so a
   * retry is harmless.
   */
  private async markDispatched(body: {
    call_id: string
  }): Promise<Result<{ marked: boolean }>> {
    return this.storage.transaction(async txn => {
      const call = await txn.get<StoredCall>(`call:${body.call_id}`)
      if (!call) return err('call_not_found', 'unknown call_id')
      if (call.status !== 'reserved' || call.dispatched) {
        return { ok: true as const, value: { marked: false } }
      }
      await txn.put(`call:${body.call_id}`, { ...call, dispatched: true } satisfies StoredCall)
      return { ok: true as const, value: { marked: true } }
    })
  }

  /**
   * Finish a reserved call.
   *
   * `commit` charges `charged` (clamped to the reserved maximum — a bug in the
   * pricing layer must never be able to overdraw a session) and refunds the
   * unused remainder of the hold. `release` refunds the entire hold; that is
   * the path taken on any upstream 4xx/5xx/timeout, so a user is never billed
   * for a call that produced nothing.
   *
   * Settling an already-settled call is a no-op that reports the recorded
   * outcome, keeping the whole reserve→settle pair idempotent under retry.
   */
  private async settle(body: {
    call_id: string
    action: 'commit' | 'release'
    charged?: string
    reason?: string
  }): Promise<Result<{ call: StoredCall; balance: string; already_settled: boolean }>> {
    return this.storage.transaction(async txn => {
      const call = await txn.get<StoredCall>(`call:${body.call_id}`)
      if (!call) return err('call_not_found', 'unknown call_id')

      const balKey = `bal:${call.account}`
      const balance = parseAtomic((await txn.get<string>(balKey)) ?? '0')

      if (call.status !== 'reserved') {
        return {
          ok: true as const,
          value: { call, balance: balance.toString(), already_settled: true },
        }
      }

      const held = parseAtomic(call.max_price)

      if (body.action === 'release') {
        const settled: StoredCall = {
          ...call,
          status: 'released',
          charged: '0',
          release_reason: body.reason,
        }
        await txn.put(`call:${body.call_id}`, settled)
        await txn.put(balKey, (balance + held).toString())
        return {
          ok: true as const,
          value: { call: settled, balance: (balance + held).toString(), already_settled: false },
        }
      }

      let charged = parseAtomic(body.charged ?? '0')
      if (charged < 0n) charged = 0n
      if (charged > held) charged = held
      const refund = held - charged

      const settled: StoredCall = { ...call, status: 'committed', charged: charged.toString() }
      await txn.put(`call:${body.call_id}`, settled)
      await txn.put(balKey, (balance + refund).toString())
      await txn.put(
        'total:committed',
        (parseAtomic((await txn.get<string>('total:committed')) ?? '0') + charged).toString(),
      )
      // Committed spend leaves the outstanding-credit pool for good.
      await txn.put(
        'total:outstanding',
        (parseAtomic((await txn.get<string>('total:outstanding')) ?? '0') - charged).toString(),
      )

      return {
        ok: true as const,
        value: { call: settled, balance: (balance + refund).toString(), already_settled: false },
      }
    })
  }

  // -------------------------------------------------------------------------
  // /totals — recon support
  // -------------------------------------------------------------------------

  /**
   * Aggregate figures for `scripts/admin/playground-recon.ts`.
   *
   * `balances_sum` and `holds_sum` are recomputed by scanning every account /
   * call, deliberately NOT read from the incremental counters — the whole
   * point of recon is to catch the incremental counters having drifted from
   * the underlying rows.
   */
  private async totals(): Promise<
    Result<{
      credited: string
      committed: string
      outstanding: string
      balances_sum: string
      holds_sum: string
      /**
       * Calls the reaper settled (committed or released) rather than their own
       * request. Surfaced separately because a reaper COMMIT charges the user
       * for a call whose real upstream spend recon cannot see from on-chain
       * deposit data — these are the review set for the accepted crash window.
       */
      reaped_committed_count: number
      reaped_committed_atomic: string
      reaped_released_count: number
      consumed_deposits: {
        tx_hash: string
        op_index: number
        intent_id: string
        /** Binding fields from the stored intent, for per-op recon. */
        account: string | null
        amount: string | null
        memo: string | null
      }[]
    }>
  > {
    const balances = await this.storage.list<string>({ prefix: 'bal:' })
    let balancesSum = 0n
    for (const v of balances.values()) balancesSum += parseAtomic(v)

    const calls = await this.storage.list<StoredCall>({ prefix: 'call:' })
    let holdsSum = 0n
    let reapedCommittedCount = 0
    let reapedCommittedAtomic = 0n
    let reapedReleasedCount = 0
    for (const c of calls.values()) {
      if (c.status === 'reserved') holdsSum += parseAtomic(c.max_price)
      if (c.reaped && c.status === 'committed') {
        reapedCommittedCount++
        reapedCommittedAtomic += parseAtomic(c.charged)
      }
      if (c.reaped && c.status === 'released') reapedReleasedCount++
    }

    const consumed = await this.storage.list<string>({ prefix: 'consumed:' })
    const consumedDeposits: {
      tx_hash: string
      op_index: number
      intent_id: string
      account: string | null
      amount: string | null
      memo: string | null
    }[] = []
    for (const [key, intentId] of consumed) {
      const rest = key.slice('consumed:'.length)
      const sep = rest.lastIndexOf(':')
      // Attach the stored intent's binding fields so recon can verify that the
      // on-chain payment behind each credit really binds to the intent it was
      // credited against — not just that the aggregate sums happen to match.
      const intent = await this.storage.get<StoredIntent>(`intent:${intentId}`)
      consumedDeposits.push({
        tx_hash: rest.slice(0, sep),
        op_index: Number(rest.slice(sep + 1)),
        intent_id: intentId,
        account: intent?.account ?? null,
        amount: intent?.amount ?? null,
        memo: intent?.memo ?? null,
      })
    }

    return {
      ok: true,
      value: {
        credited: (await this.readAtomic('total:credited')).toString(),
        committed: (await this.readAtomic('total:committed')).toString(),
        outstanding: (await this.readAtomic('total:outstanding')).toString(),
        balances_sum: balancesSum.toString(),
        holds_sum: holdsSum.toString(),
        reaped_committed_count: reapedCommittedCount,
        reaped_committed_atomic: reapedCommittedAtomic.toString(),
        reaped_released_count: reapedReleasedCount,
        consumed_deposits: consumedDeposits,
      },
    }
  }
}

function secondsUntilNextHour(now: number): number {
  const d = new Date(now)
  const next = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours() + 1,
    0,
    0,
  )
  return Math.max(1, Math.ceil((next - now) / 1000))
}
