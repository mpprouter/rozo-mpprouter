/**
 * Playground session endpoints — a prepaid, self-serve demo surface.
 *
 * ---------------------------------------------------------------------------
 * Shape of the feature
 * ---------------------------------------------------------------------------
 * A Stellar developer makes ONE wallet-signed USDC payment to the router's
 * existing receiving account, carrying a memo we issued. The router verifies
 * that payment on Horizon, credits an internal ledger keyed to the payer's
 * G-address, and hands back a 7-day HMAC session token. Subsequent playground
 * calls debit that ledger; the router pays each upstream merchant per call out
 * of its own pool exactly as it does today.
 *
 * The two sides are deliberately decoupled: the user pays us in Stellar
 * session style, we pay upstreams in Tempo charge style. No upstream needs to
 * support sessions for it to appear here — it only needs to be charge-verified.
 *
 * ---------------------------------------------------------------------------
 * Why these are purpose-built endpoints and not a new proxy auth flavour
 * ---------------------------------------------------------------------------
 * The obvious design — teach `classifyAuth()` in `proxy.ts` about a session
 * token — was rejected. It would put a landing-page demo inside a 2,177-line
 * payment-critical file, and it would inherit that file's pre-auth global
 * `x-request-id` cache. Instead every playground call has a backend-owned
 * shape: fixed route, fixed model allow-list, forced `max_tokens`, flat price.
 * The router's funds exposure per playground call is a constant we choose, not
 * a function of anything the caller sends.
 *
 * ---------------------------------------------------------------------------
 * Money handling
 * ---------------------------------------------------------------------------
 * Each call runs reserve → upstream → commit/release against the
 * `PlaygroundLedger` Durable Object, with `call_id` as the idempotency key. A
 * hold is taken before the upstream call and refunded on any failure, so a
 * balance can never go negative and a failed call is never billed. All amounts
 * are 7-decimal atomic bigints; no float touches a balance.
 *
 * Deposits are non-refundable demo credit — stated in the UI, not enforced
 * here beyond the absence of any refund path.
 */

import type { Env } from '../index'
import { formatUsd, parseAtomic, parseUsd } from '../playground/amount'
import {
  BLEND_EVENT_LIMIT,
  BLEND_MAIN_POOL_CONTRACT_ID,
  aggregateBlendEvents,
  buildSummaryPrompt,
  describeAggregate,
  extractEvents,
} from '../playground/blend'
import {
  DEFAULT_HORIZON_URL,
  STELLAR_PUBNET_USDC_ISSUER,
  verifyDeposit,
  type DepositFailure,
} from '../playground/deposit'
import {
  commit,
  createIntent,
  getIntent,
  markDispatched,
  openIntent,
  readAccount,
  readTotals,
  release,
  reserve,
  type LedgerResult,
} from '../playground/ledger-client'
import {
  BLEND_SUMMARY_MODEL_ID,
  CALL_HISTORY_LIMIT,
  DEPOSIT_CAP_PER_ACCOUNT_PER_DAY_USD,
  DEPOSIT_OPTIONS_USD,
  FORCED_MAX_TOKENS,
  INTENT_TTL_SECONDS,
  MAX_MESSAGES_PER_TURN,
  MAX_MESSAGE_CHARS,
  ModelNotAllowedError,
  PLAYGROUND_CHIPS,
  PLAYGROUND_MODELS,
  SESSION_RENEWAL_CAP_SECONDS,
  SESSION_TTL_SECONDS,
  TIER_PRICE_USD,
  TIER_UPSTREAM_BUDGET_USD,
  assertModelCallable,
  CHAT_OUTAGE_REASON,
  chatModelsDisabled,
  findChip,
  findModel,
  isDepositOption,
} from '../playground/models'
import {
  bearerFrom,
  isSessionSecretUsable,
  maskAccount,
  mintSessionToken,
  verifySessionToken,
} from '../playground/session-token'
import {
  UpstreamError,
  callUpstreamJson,
  resolvePlaygroundRoute,
} from '../playground/upstream'
import { StrKey } from '@stellar/stellar-sdk'
import {
  PLAYGROUND_TURNSTILE_ACTION,
  isPlaygroundTurnstileDisabled,
  verifyPlaygroundTurnstile,
} from '../playground/turnstile'
import { getStellarUsdcSac } from '../mpp/stellar-server'
import { getSupersededAbortCount, getWriteoffTotals } from '../playground/channel-voucher-store'
import {
  CHANNEL_DEPOSIT_OPTIONS,
  CHANNEL_MAX_DEPOSIT_USD,
  CHANNEL_MIN_DEPOSIT_USD,
  CHANNEL_REFUND_WAITING_PERIOD,
  channelCollector,
  channelFactoryAddress,
  channelHorizonUrl,
  channelNetworkPassphrase,
  channelPlaygroundEnabled,
  channelPricingConfig,
} from '../playground/channel-config'

// ---------------------------------------------------------------------------
// small response helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fail(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: code, message, ...extra }, status)
}

/**
 * Kill switch. Returns a 404 rather than a 403 so a disabled playground is
 * indistinguishable from one that was never deployed — nothing to probe.
 */
export function playgroundEnabled(env: Env): boolean {
  return env.PLAYGROUND_ENABLED === 'true'
}

function disabled(): Response {
  return fail(404, 'not_found', 'playground is not enabled')
}

/** Stellar public account ids: 'G' + 55 base32 chars. */
const G_ADDRESS = /^G[A-Z2-7]{55}$/

/**
 * Full StrKey validation, including the CRC16 checksum.
 *
 * The shape regex alone accepts ~2^275 well-formed-looking strings that are
 * not real accounts. Since the account is a DO storage key, accepting them
 * lets an attacker mint intents against unbounded distinct "addresses" and
 * grow storage for free. The checksum cuts that to real, typo-free accounts —
 * and it is also the only thing that stops a user's funds being quoted against
 * an address that cannot receive them.
 *
 * Note this does NOT prove the caller controls the address; intent creation is
 * unauthenticated by design. Address ownership is proven later, on-chain, by
 * the deposit's operation source. What bounds abuse here is the hourly rate
 * limit plus MAX_OPEN_INTENTS_PER_ACCOUNT.
 */
function isValidStellarAccount(account: string): boolean {
  if (!G_ADDRESS.test(account)) return false
  try {
    return StrKey.isValidEd25519PublicKey(account)
  } catch {
    return false
  }
}

/** Accept only ids we could have issued, since they index DO storage. */
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function horizonUrl(env: Env): string {
  return env.PLAYGROUND_HORIZON_URL?.trim() || DEFAULT_HORIZON_URL
}

/**
 * Generate the on-chain memo nonce.
 *
 * Stellar MEMO_TEXT holds 28 bytes. `pg-` + 20 hex chars = 23 bytes, leaving
 * headroom, and 80 bits of entropy — far beyond what a collision or a guess
 * needs, given that a memo alone is useless without the matching `intent_id`.
 */
function generateMemo(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return `pg-${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Map a ledger-layer refusal to an HTTP response.
 *
 * Cap and rate-limit refusals are 429/403 rather than 500: they are expected
 * operating states of a capped demo, and the frontend renders them as copy.
 */
function ledgerErrorResponse(e: Extract<LedgerResult<unknown>, { ok: false }>): Response {
  switch (e.code) {
    case 'rate_limited':
      return fail(429, e.code, e.message, e.detail ?? {})
    case 'deposit_cap_exceeded':
    case 'global_cap_exceeded':
      return fail(403, e.code, e.message)
    case 'intent_not_found':
      return fail(404, e.code, e.message)
    case 'intent_expired':
    case 'intent_already_used':
    case 'payment_already_claimed':
      return fail(409, e.code, e.message)
    case 'too_many_open_intents':
      return fail(429, e.code, e.message, e.detail ?? {})
    case 'deposit_exceeds_cap':
      // The money is already on-chain. This is terminal and needs a human.
      return fail(409, e.code, e.message, {
        ...(e.detail ?? {}),
        support_note:
          'Your deposit was received on-chain but exceeds the playground credit cap, so it was not credited. Contact support for a refund.',
      })
    default:
      return fail(400, e.code, e.message)
  }
}

// ---------------------------------------------------------------------------
// GET /v1/playground/config
// ---------------------------------------------------------------------------

/**
 * Public, unauthenticated description of what the playground currently offers.
 *
 * This exists so the frontend has no checked-in copy of the model list to
 * drift from. Unavailable models are included WITH their reason so the UI can
 * grey them honestly instead of hiding them.
 */
export function handlePlaygroundConfig(env: Env): Response {
  const turnstileDisabled = isPlaygroundTurnstileDisabled(env)
  return json({
    enabled: playgroundEnabled(env),
    // Non-custodial channel mode, advertised alongside the custodial fields so
    // the frontend can offer both during the cutover. See channel-config.ts.
    channel: {
      enabled: channelPlaygroundEnabled(env),
      factory_contract: channelFactoryAddress(env),
      token_sac: getStellarUsdcSac(env),
      // The collector the frontend must pass as factory.open `to`. Distinct
      // from router_recipient (the treasury), which is kept for reference.
      channel_to: channelCollector(env),
      router_recipient: env.STELLAR_ROUTER_PUBLIC,
      network: env.STELLAR_NETWORK,
      network_passphrase: channelNetworkPassphrase(env),
      soroban_rpc_url: env.STELLAR_RPC_URL,
      horizon_url: channelHorizonUrl(env),
      refund_waiting_period: CHANNEL_REFUND_WAITING_PERIOD,
      deposit_options: CHANNEL_DEPOSIT_OPTIONS,
      min_deposit_usd: CHANNEL_MIN_DEPOSIT_USD,
      max_deposit_usd: CHANNEL_MAX_DEPOSIT_USD,
      ...channelPricingConfig(env),
    },
    turnstile: {
      // The frontend renders a widget only when required is true; the site key
      // is public and safe to expose. When disabled (staged rollout) the
      // frontend can skip the widget and omit turnstile_token.
      required: !turnstileDisabled,
      site_key: env.PLAYGROUND_TURNSTILE_SITE_KEY ?? null,
      action: PLAYGROUND_TURNSTILE_ACTION,
    },
    models: PLAYGROUND_MODELS.map(m => {
      const outage = chatModelsDisabled(env, m.provider)
      const reason = !m.available ? m.unavailableReason : outage ? CHAT_OUTAGE_REASON : undefined
      return {
        id: m.id,
        tier: m.tier,
        provider: m.provider,
        price_usd: TIER_PRICE_USD[m.tier],
        available: m.available && !outage,
        ...(reason ? { unavailable_reason: reason } : {}),
      }
    }),
    chips: PLAYGROUND_CHIPS.map(c => ({
      id: c.id,
      label: c.label,
      price_usd: c.priceUsd,
      description: c.description,
    })),
    deposit_options: DEPOSIT_OPTIONS_USD.map(amount => ({
      amount_usd: amount,
      asset: 'USDC',
      network: 'stellar-mainnet',
    })),
    deposit_cap_per_account_per_day_usd: DEPOSIT_CAP_PER_ACCOUNT_PER_DAY_USD,
    session_ttl_seconds: SESSION_TTL_SECONDS,
    blend_pool_contract_id: BLEND_MAIN_POOL_CONTRACT_ID,
    /** Deposits are consumable demo credit; there is no refund path. */
    refundable: false,
  })
}

// ---------------------------------------------------------------------------
// POST /v1/playground/session/intent
// ---------------------------------------------------------------------------

export async function handlePlaygroundIntent(request: Request, env: Env): Promise<Response> {
  if (!playgroundEnabled(env)) return disabled()

  // Refuse to quote a deposit at all if we could not mint the session that
  // pays for it. Checking this only at /open would mean taking a real
  // on-chain payment for credit we cannot issue.
  if (!isSessionSecretUsable(env.PLAYGROUND_SESSION_SECRET)) {
    console.error('[playground] PLAYGROUND_SESSION_SECRET missing or too short; refusing intents')
    return fail(503, 'not_configured', 'playground session signing is not configured')
  }

  const body = await readJsonBody(request)
  const account = typeof body.account === 'string' ? body.account.trim() : ''
  if (!isValidStellarAccount(account)) {
    return fail(400, 'invalid_account', 'account must be a valid Stellar public address (G...)')
  }

  // Turnstile gate. This is the front door to an on-chain deposit, so it is
  // fail-closed: an unconfigured secret blocks the request unless Turnstile is
  // explicitly disabled for a staged rollout. Verified against Cloudflare
  // server-side with the action and hostname pinned — a browser-only check is
  // worthless because an attacker scripts this POST directly.
  const turnstileToken = typeof body.turnstile_token === 'string' ? body.turnstile_token : null
  const turnstile = await verifyPlaygroundTurnstile(
    env,
    turnstileToken,
    request.headers.get('cf-connecting-ip'),
  )
  if (!turnstile.ok) {
    const status = turnstile.reason === 'not_configured' || turnstile.reason === 'unreachable' ? 503 : 403
    return fail(status, `turnstile_${turnstile.reason}`, 'human verification failed')
  }

  const amountUsd =
    typeof body.amount_usd === 'string'
      ? body.amount_usd
      : typeof body.amount_usd === 'number'
        ? String(body.amount_usd)
        : DEPOSIT_OPTIONS_USD[DEPOSIT_OPTIONS_USD.length - 1]
  if (!isDepositOption(amountUsd)) {
    return fail(400, 'invalid_amount', 'amount_usd must be one of the offered deposit options', {
      deposit_options: DEPOSIT_OPTIONS_USD,
    })
  }

  const destination = env.STELLAR_ROUTER_PUBLIC
  // Full StrKey checksum validation, not just the shape regex: this is the
  // address we tell a real user to send funds to. A misconfigured value that
  // passed a loose regex but failed its checksum would quote an unrecoverable
  // destination. Fail closed rather than quote a bad address.
  if (!destination || !isValidStellarAccount(destination)) {
    return fail(503, 'not_configured', 'playground deposit destination is not configured')
  }

  const now = Date.now()
  const expiresAt = now + INTENT_TTL_SECONDS * 1000
  const created = await createIntent(env, {
    intentId: crypto.randomUUID(),
    account,
    amountAtomic: parseUsd(amountUsd),
    memo: generateMemo(),
    // Recorded so /open verifies against the address the user was actually
    // quoted, surviving a rotation of STELLAR_ROUTER_PUBLIC.
    destination,
    now,
    expiresAt,
  })
  if (!created.ok) return ledgerErrorResponse(created)

  return json({
    intent_id: created.value.intent_id,
    memo: created.value.memo,
    memo_type: 'text',
    destination: created.value.destination,
    amount_usdc: formatUsd(parseAtomic(created.value.amount)),
    asset: 'USDC',
    asset_issuer: STELLAR_PUBNET_USDC_ISSUER,
    network: 'stellar-mainnet',
    expires_at: new Date(created.value.expires_at).toISOString(),
  })
}

// ---------------------------------------------------------------------------
// POST /v1/playground/session/open
// ---------------------------------------------------------------------------

const DEPOSIT_FAILURE_STATUS: Record<DepositFailure, number> = {
  tx_not_found: 404,
  tx_failed: 400,
  memo_mismatch: 400,
  no_matching_payment: 400,
  horizon_unavailable: 503,
}

/**
 * Claim a deposit and open a session.
 *
 * Claim-jacking requires two things at once: the `intent_id`, which is only
 * ever returned to the caller that created the intent, AND an on-chain payment
 * whose memo, amount, destination and *source account* all match that same
 * intent. Spotting a payment on-chain is not enough; neither is holding an
 * intent id.
 */
export async function handlePlaygroundOpen(request: Request, env: Env): Promise<Response> {
  if (!playgroundEnabled(env)) return disabled()

  const body = await readJsonBody(request)
  const intentId = typeof body.intent_id === 'string' ? body.intent_id.trim() : ''
  const txHash = typeof body.tx_hash === 'string' ? body.tx_hash.trim().toLowerCase() : ''
  if (!intentId) return fail(400, 'invalid_request', 'intent_id is required')
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    return fail(400, 'invalid_request', 'tx_hash must be a 64-character hex transaction hash')
  }

  // Never consume a deposit we cannot mint a session for.
  if (!isSessionSecretUsable(env.PLAYGROUND_SESSION_SECRET)) {
    console.error('[playground] PLAYGROUND_SESSION_SECRET missing or too short; refusing open')
    return fail(503, 'not_configured', 'playground session signing is not configured')
  }

  const found = await getIntent(env, intentId)
  if (!found.ok) return ledgerErrorResponse(found)
  const intent = found.value

  // The destination recorded when the user was quoted — NOT the live env var.
  // Rotating STELLAR_ROUTER_PUBLIC must not brick deposits already in flight.
  const destination = intent.destination
  if (!destination) {
    return fail(503, 'not_configured', 'playground deposit destination is not configured')
  }

  // Fast path for an exact re-submit: the payment was already verified and
  // credited, so re-verifying against Horizon would be a wasted round trip.
  // Any other combination still goes through full verification below.
  const isExactReplay =
    intent.status === 'consumed' && intent.tx_hash === txHash && intent.session_jti !== undefined

  const now = Date.now()
  const nowSec = Math.floor(now / 1000)

  let opIndex: number
  let confirmedAt: number
  if (isExactReplay) {
    opIndex = intent.op_index ?? 0
    // Already verified once; the recorded creation time is inside the window
    // by construction, so re-verifying against Horizon would be a wasted trip.
    confirmedAt = intent.created_at
  } else {
    const verified = await verifyDeposit({
      horizonUrl: horizonUrl(env),
      txHash,
      memo: intent.memo,
      destination,
      account: intent.account,
      amountAtomic: parseAtomic(intent.amount),
    })
    if (!verified.ok) {
      return fail(
        DEPOSIT_FAILURE_STATUS[verified.reason],
        verified.reason,
        verified.detail ?? 'deposit could not be verified on-chain',
      )
    }
    opIndex = verified.opIndex
    confirmedAt = verified.confirmedAt
  }

  // ---- Session identity and lifetime -------------------------------------
  // Three cases, and the middle one used to be a bug: `Math.max(1, expired)`
  // minted a token that expired one second later.
  //
  //   1. First open           → fresh jti, full TTL.
  //   2. Re-open, still valid → SAME jti, the REMAINING TTL. A retry must not
  //                             extend the session, and must return the same
  //                             token the first call did.
  //   3. Re-open, expired     → fresh jti and a full TTL, but only inside a
  //                             hard cap measured from intent creation, so one
  //                             deposit cannot renew a session forever.
  let jti: string
  let sessionExp: number
  if (intent.session_jti && intent.session_exp && intent.session_exp > nowSec) {
    jti = intent.session_jti
    sessionExp = intent.session_exp
  } else {
    const renewalDeadline = Math.floor(intent.created_at / 1000) + SESSION_RENEWAL_CAP_SECONDS
    if (intent.session_jti && nowSec > renewalDeadline) {
      return fail(
        410,
        'session_renewal_expired',
        'this deposit is too old to open a new session; the balance remains credited to the account',
      )
    }
    jti = crypto.randomUUID()
    sessionExp = Math.min(nowSec + SESSION_TTL_SECONDS, renewalDeadline)
  }

  const opened = await openIntent(env, {
    intentId,
    txHash,
    opIndex,
    now,
    confirmedAt,
    sessionJti: jti,
    sessionExp,
  })
  if (!opened.ok) return ledgerErrorResponse(opened)

  // The DO is authoritative: on a replay it returns the ORIGINALLY recorded
  // jti/exp, so a retry cannot mint a second, longer-lived session.
  const grantedJti = opened.value.intent.session_jti ?? jti
  const grantedExp = opened.value.intent.session_exp ?? sessionExp
  const ttl = grantedExp - nowSec
  if (ttl <= 0) {
    return fail(
      410,
      'session_renewal_expired',
      'this deposit is too old to open a new session; the balance remains credited to the account',
    )
  }

  let token: string
  try {
    token = (
      await mintSessionToken(env.PLAYGROUND_SESSION_SECRET, {
        account: opened.value.intent.account,
        jti: grantedJti,
        now,
        ttlSeconds: ttl,
      })
    ).token
  } catch (e: any) {
    console.error('[playground] session mint failed:', e?.message)
    return fail(503, 'not_configured', 'playground session signing is not configured')
  }

  return json({
    session_token: token,
    account_masked: maskAccount(opened.value.intent.account),
    balance_usd: formatUsd(parseAtomic(opened.value.balance)),
    expires_at: new Date(grantedExp * 1000).toISOString(),
    replayed: opened.value.replayed,
  })
}

// ---------------------------------------------------------------------------
// session auth for the call endpoints
// ---------------------------------------------------------------------------

interface Session {
  account: string
}

async function authenticate(request: Request, env: Env): Promise<Session | Response> {
  const token = bearerFrom(request)
  if (!token) {
    return fail(401, 'missing_session', 'Authorization: Bearer <session_token> is required')
  }
  let result
  try {
    result = await verifySessionToken(env.PLAYGROUND_SESSION_SECRET, token, Date.now())
  } catch (e: any) {
    console.error('[playground] session verify failed:', e?.message)
    return fail(503, 'not_configured', 'playground session signing is not configured')
  }
  if (!result.ok) {
    return fail(401, `session_${result.reason}`, 'session token is not valid')
  }
  return { account: result.payload.sub }
}

// ---------------------------------------------------------------------------
// GET /v1/playground/session
// ---------------------------------------------------------------------------

export async function handlePlaygroundSession(request: Request, env: Env): Promise<Response> {
  if (!playgroundEnabled(env)) return disabled()
  const session = await authenticate(request, env)
  if (session instanceof Response) return session

  const account = await readAccount(env, session.account)
  if (!account.ok) return ledgerErrorResponse(account)

  return json({
    account_masked: maskAccount(session.account),
    balance_usd: formatUsd(parseAtomic(account.value.balance)),
    calls: account.value.calls.slice(0, CALL_HISTORY_LIMIT).map(c => ({
      call_id: c.call_id,
      chip: c.chip,
      model: c.model,
      status: c.status,
      charged_usd: formatUsd(parseAtomic(c.charged)),
      at: new Date(c.at).toISOString(),
    })),
  })
}

// ---------------------------------------------------------------------------
// GET /v1/playground/admin/totals  (operator only)
// ---------------------------------------------------------------------------

/**
 * Aggregate ledger figures for `scripts/admin/playground-recon.ts`.
 *
 * The Durable Object is not reachable from outside the Worker, so solvency
 * recon needs a door. This is that door, and it is deliberately the narrowest
 * one that works: aggregates only — no addresses, no balances per account, no
 * call contents — behind a dedicated bearer token.
 *
 * Unset `PLAYGROUND_RECON_TOKEN` ⇒ 404, same as the kill switch: an operator
 * endpoint with no credential configured must be absent, not open.
 */
export async function handlePlaygroundAdminTotals(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!playgroundEnabled(env)) return disabled()

  const expected = env.PLAYGROUND_RECON_TOKEN
  if (!expected || expected.length < 16) return disabled()

  const presented = bearerFrom(request)
  if (!presented || !timingSafeEqualString(presented, expected)) {
    return fail(401, 'unauthorized', 'operator token required')
  }

  const totals = await readTotals(env)
  if (!totals.ok) return ledgerErrorResponse(totals)
  // Channel recon: surface the count of paid-then-superseded aborts (the
  // documented bounded router loss) so it is operator-visible, never silent.
  let supersededAborts = 0
  let writeoffs = { count: 0, totalRaw: '0' }
  try {
    supersededAborts = await getSupersededAbortCount(env)
    writeoffs = await getWriteoffTotals(env)
  } catch (e: any) {
    console.error('[playground] reading channel recon counter failed:', e?.message)
  }
  return json({
    ok: true,
    value: totals.value,
    channel: {
      superseded_aborts: supersededAborts,
      // Forgiven debt (funder refunded before collection) — distinct from
      // collected funds so recon never mistakes a write-off for revenue.
      writeoff_count: writeoffs.count,
      writeoff_total_raw: writeoffs.totalRaw,
    },
  })
}

/**
 * Constant-time string comparison for the operator token. A plain `===` on a
 * shared secret leaks a prefix-match oracle through response timing.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

// ---------------------------------------------------------------------------
// shared reserve → run → settle wrapper
// ---------------------------------------------------------------------------

interface CallContext {
  callId: string
  balanceAtomic: bigint
  priceAtomic: bigint
}

/**
 * Take the hold for a call, or return the response explaining why we can't.
 *
 * A duplicate `call_id` short-circuits here and returns the recorded outcome:
 * the upstream side effect must not run twice and, critically, must not be
 * charged twice. The replayed response omits the original payload — the DO
 * stores accounting facts, not response bodies — and says so via `replayed`.
 */
async function beginCall(
  env: Env,
  account: string,
  args: { callId: string; chip: string; model?: string; priceAtomic: bigint },
): Promise<CallContext | Response> {
  const held = await reserve(env, {
    callId: args.callId,
    account,
    chip: args.chip,
    model: args.model,
    maxPriceAtomic: args.priceAtomic,
    now: Date.now(),
  })
  if (!held.ok) return ledgerErrorResponse(held)

  if (held.value.duplicate) {
    const call = held.value.call!
    return json({
      call_id: call.call_id,
      replayed: true,
      status: call.status,
      chip: call.chip,
      model: call.model,
      charged_usd: formatUsd(parseAtomic(call.charged)),
      balance_usd: formatUsd(parseAtomic(held.value.balance)),
    })
  }

  if (!held.value.ok) {
    // Payment-required semantics on a prepaid balance: tell the caller exactly
    // how much is left so the UI can render "top up $x".
    return fail(402, 'insufficient_balance', 'playground session balance is too low', {
      balance_remaining: formatUsd(parseAtomic(held.value.balance)),
      price_usd: formatUsd(args.priceAtomic),
    })
  }

  // Persist the dispatched marker BEFORE any upstream/payment attempt. It is
  // the flag the reaper uses to tell "died before paying" (release) from "died
  // after paying" (commit). If this write fails we must NOT proceed to a paid
  // upstream call with an unpersisted marker — a later crash would then leave
  // a genuinely-paid call looking never-dispatched and get it wrongly
  // released. So on a marker failure we release the reservation and abort.
  //
  // KNOWN CRASH WINDOW (accepted, recon-monitored): a worker crash in the gap
  // between this write landing and the upstream call firing is inherent to
  // Worker+DO across awaits. Its exposure is bounded by one call's price and
  // detected by scripts/admin/playground-recon.ts (a reaper-committed call
  // with no matching on-chain payment shows up as a per-op binding mismatch).
  let marked
  try {
    marked = await markDispatched(env, args.callId)
  } catch (e: any) {
    marked = { ok: false as const, code: 'dispatch_threw', message: e?.message ?? 'threw' }
  }
  if (!marked.ok) {
    console.error(`[playground] markDispatched failed for ${args.callId}: ${marked.code}`)
    // Nothing was dispatched or paid yet — safe to release the hold in full.
    await release(env, args.callId, 'dispatch_mark_failed').catch(err =>
      console.error(`[playground] release after dispatch failure threw: ${err?.message}`),
    )
    return fail(503, 'dispatch_failed', 'could not start the call; no charge was made', {
      call_id: args.callId,
    })
  }

  return {
    callId: args.callId,
    balanceAtomic: parseAtomic(held.value.balance),
    priceAtomic: args.priceAtomic,
  }
}

/**
 * Settle a FAILED call. The commit decision is `paymentEvidence === 'yes'` and
 * nothing else — no exception type, no response shape, no default-to-commit.
 *
 * `paymentEvidence` is set upstream strictly from the call-local `paid` flag
 * (`paid ? 'yes' : 'no'`), which is true only when the router actually incurred
 * billable cost for THIS call: a credential was signed (Tempo) or the metered
 * call succeeded (Mercury). So:
 *
 *   - `'yes'` → commit. The money moved (a credential was signed and the
 *               response then failed — bad status, empty/garbage body, timeout
 *               after signing). The user is charged, told so via `support_note`,
 *               and the event logged for support.
 *   - anything else (`'no'`, `'maybe'`, a non-UpstreamError) → release. The
 *               user is not charged.
 *
 * The success-path counterpart is `releaseUnpaid`, used when a call returns a
 * usable body but `paid === false` (e.g. an initial non-402 2xx). Between the
 * two, `paid === true` is the ONLY thing anywhere that can lead to a charge.
 */
async function failCall(
  env: Env,
  callId: string,
  e: unknown,
  priceAtomic: bigint,
): Promise<Response> {
  const upstream = e instanceof UpstreamError ? e : null
  const code = upstream?.code ?? 'upstream_error'
  const status = upstream?.status ?? 502
  const message = upstream?.message ?? 'upstream call failed'
  // THE ONLY COMMIT PREDICATE: a credential was provably signed for this call
  // (paymentEvidence === 'yes', set from the call-local `paid` flag). Every
  // other outcome — 'no', 'maybe', a non-UpstreamError, an unknown default —
  // RELEASES. There is no default-to-commit and no exception-type or
  // response-shape heuristic anywhere in this decision.
  const shouldCommit = upstream?.paymentEvidence === 'yes'

  let charged = 0n
  let balanceAtomic: bigint | null = null
  try {
    const settled = shouldCommit
      ? await commit(env, callId, priceAtomic)
      : await release(env, callId, code)
    if (settled.ok) {
      charged = parseAtomic(settled.value.call.charged)
      balanceAtomic = parseAtomic(settled.value.balance)
    } else {
      console.error(`[playground] settle failed for ${callId}: ${settled.code} ${settled.message}`)
    }
  } catch (settleError: any) {
    // Never let a settle failure mask the upstream error. The call is left
    // `reserved` and the DO alarm reaper will settle it — see ledger-do.ts.
    console.error(`[playground] settle threw for ${callId}: ${settleError?.message}`)
  }

  if (shouldCommit) {
    console.error(
      `[playground] PAID-BUT-FAILED call ${callId}: ${code} (${message}); ` +
        `paymentEvidence=yes; charged ${charged} atomic. Support may owe goodwill credit.`,
    )
  }

  return fail(status, code, message, {
    call_id: callId,
    charged_usd: formatUsd(charged),
    ...(balanceAtomic !== null ? { balance_usd: formatUsd(balanceAtomic) } : {}),
    ...(shouldCommit
      ? {
          support_note:
            'The upstream provider was paid but did not return a usable result, so this call was charged. Contact support if you would like it reviewed.',
        }
      : {}),
  })
}

/**
 * A usable response came back but NO credential was signed for this call
 * (`paid === false`) — e.g. an initial non-402 2xx where the merchant served
 * us without a payment challenge. The router paid nothing, so the user is
 * never charged: release the hold and report a neutral error. This is the
 * success-path counterpart to `failCall`'s release branch, and it exists so
 * that `paid === true` is the ONLY thing that can lead to a charge.
 */
async function releaseUnpaid(env: Env, callId: string): Promise<Response> {
  let balanceAtomic: bigint | null = null
  try {
    const settled = await release(env, callId, 'no_credential_signed')
    if (settled.ok) balanceAtomic = parseAtomic(settled.value.balance)
    else console.error(`[playground] release(unpaid) failed for ${callId}: ${settled.code}`)
  } catch (err: any) {
    console.error(`[playground] release(unpaid) threw for ${callId}: ${err?.message}`)
  }
  return fail(502, 'upstream_unpaid', 'the call did not complete a payment; you were not charged', {
    call_id: callId,
    charged_usd: '0.00',
    ...(balanceAtomic !== null ? { balance_usd: formatUsd(balanceAtomic) } : {}),
  })
}

function callId(body: Record<string, unknown>): string | null {
  const supplied = body.call_id
  if (supplied === undefined || supplied === null) return crypto.randomUUID()
  if (typeof supplied === 'string' && ID_PATTERN.test(supplied)) return supplied
  return null
}

// ---------------------------------------------------------------------------
// POST /v1/playground/chat
// ---------------------------------------------------------------------------

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Whitelist the message array down to `{role, content}` string pairs.
 *
 * Nothing else from the caller's body reaches the upstream: no `tools`, no
 * `max_tokens`, no `stream`, no vendor extensions. Those are the fields that
 * turn a flat-priced demo call into an unbounded bill.
 */
function sanitizeMessages(raw: unknown): ChatMessage[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'messages must be a non-empty array' }
  }
  if (raw.length > MAX_MESSAGES_PER_TURN) {
    return { error: `messages may not exceed ${MAX_MESSAGES_PER_TURN} entries` }
  }
  const out: ChatMessage[] = []
  let totalChars = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: 'each message must be an object' }
    const { role, content } = item as Record<string, unknown>
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { error: 'message role must be system, user, or assistant' }
    }
    if (typeof content !== 'string' || content.length === 0) {
      return { error: 'message content must be a non-empty string' }
    }
    totalChars += content.length
    if (totalChars > MAX_MESSAGE_CHARS) {
      return { error: `messages may not exceed ${MAX_MESSAGE_CHARS} characters in total` }
    }
    out.push({ role, content })
  }
  return out
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[]
}

export async function handlePlaygroundChat(request: Request, env: Env): Promise<Response> {
  if (!playgroundEnabled(env)) return disabled()
  const session = await authenticate(request, env)
  if (session instanceof Response) return session

  const body = await readJsonBody(request)
  const id = callId(body)
  if (!id) return fail(400, 'invalid_request', 'call_id must be an opaque id of 8-64 characters')

  let model
  try {
    model = assertModelCallable(body.model)
    // Provider-scoped outage stop — reject BEFORE any charge work.
    if (chatModelsDisabled(env, model.provider)) {
      return fail(503, 'model_unavailable', CHAT_OUTAGE_REASON)
    }
  } catch (e) {
    if (e instanceof ModelNotAllowedError) {
      return fail(400, e.code, e.message, {
        allowed_models: PLAYGROUND_MODELS.filter(m => m.available).map(m => m.id),
      })
    }
    throw e
  }

  const messages = sanitizeMessages(body.messages)
  if ('error' in messages) return fail(400, 'invalid_request', messages.error)

  let route
  try {
    route = resolvePlaygroundRoute(model.routePublicPath, model.routeMethod)
  } catch (e: any) {
    return fail(e?.status ?? 503, e?.code ?? 'route_unavailable', e?.message ?? 'route unavailable')
  }

  const priceAtomic = parseUsd(TIER_PRICE_USD[model.tier])
  const started = await beginCall(env, session.account, {
    callId: id,
    chip: 'chat',
    model: model.id,
    priceAtomic,
  })
  if (started instanceof Response) return started

  let completion: ChatCompletion
  let paid: boolean
  try {
    ;({ value: completion, paid } = await callUpstreamJson<ChatCompletion>(env, {
      route,
      body: {
        model: model.id,
        messages,
        // Forced server-side. See models.ts — token count is the only real
        // lever on upstream cost and the flat price depends on owning it.
        max_tokens: FORCED_MAX_TOKENS,
        stream: false,
      },
      // Hard ceiling on what the ROUTER pays, independent of the flat price
      // the user pays and of whatever the merchant's live 402 asks for.
      budgetAtomic: parseUsd(TIER_UPSTREAM_BUDGET_USD[model.tier]),
    }))
  } catch (e) {
    return failCall(env, id, e, priceAtomic)
  }

  // A 2xx body with no signed credential means the router paid nothing — do
  // not charge, regardless of what the body contains.
  if (!paid) return releaseUnpaid(env, id)

  const text = completion.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text.length === 0) {
    // paid === true here: we DID sign a credential, the content just wasn't
    // usable. Charge (with a support_note), because the money moved.
    return failCall(
      env,
      id,
      new UpstreamError('upstream_empty', 502, 'upstream returned no completion', 'yes'),
      priceAtomic,
    )
  }

  const settled = await commit(env, id, priceAtomic)
  if (!settled.ok) return ledgerErrorResponse(settled)

  return json({
    call_id: id,
    message: text,
    model: model.id,
    charged_usd: formatUsd(parseAtomic(settled.value.call.charged)),
    balance_usd: formatUsd(parseAtomic(settled.value.balance)),
  })
}

// ---------------------------------------------------------------------------
// POST /v1/playground/blend-activity
// ---------------------------------------------------------------------------

/**
 * The hero chip: one paid indexer query plus an optional cheap narration call,
 * chained across two providers, for a single flat price.
 *
 * The narration leg is best-effort by design. The user has already paid for
 * (and received) real chain data; if the LLM leg fails there is a deterministic
 * fallback sentence and the call still commits. Failing the whole chip because
 * the phrasing step broke would waste the indexer call we already paid for.
 */
export async function handlePlaygroundBlendActivity(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!playgroundEnabled(env)) return disabled()
  const session = await authenticate(request, env)
  if (session instanceof Response) return session

  const body = await readJsonBody(request)
  const id = callId(body)
  if (!id) return fail(400, 'invalid_request', 'call_id must be an opaque id of 8-64 characters')

  const chip = findChip('blend-activity')!
  const priceAtomic = parseUsd(chip.priceUsd)

  let eventsRoute
  try {
    eventsRoute = resolvePlaygroundRoute('/v1/services/mercury/events/by-contract', 'GET')
  } catch (e: any) {
    return fail(e?.status ?? 503, e?.code ?? 'route_unavailable', e?.message ?? 'route unavailable')
  }

  const started = await beginCall(env, session.account, {
    callId: id,
    chip: chip.id,
    priceAtomic,
  })
  if (started instanceof Response) return started

  let raw: unknown
  let paid: boolean
  try {
    ;({ value: raw, paid } = await callUpstreamJson(env, {
      route: eventsRoute,
      query: {
        contract_id: BLEND_MAIN_POOL_CONTRACT_ID,
        limit: String(BLEND_EVENT_LIMIT),
      },
      budgetAtomic: parseUsd(chip.budgetUsd),
    }))
  } catch (e) {
    return failCall(env, id, e, priceAtomic)
  }

  // The indexer call is the billable leg. If the router incurred no cost for
  // it (paid === false), do not charge — regardless of the body.
  if (!paid) return releaseUnpaid(env, id)

  const aggregate = aggregateBlendEvents(extractEvents(raw), BLEND_MAIN_POOL_CONTRACT_ID)

  // Narration: bounded, optional, and fed only the structured aggregate.
  let summary = describeAggregate(aggregate)
  const summaryModel = findModel(BLEND_SUMMARY_MODEL_ID)
  if (summaryModel?.available && aggregate.events_examined > 0) {
    try {
      const route = resolvePlaygroundRoute(summaryModel.routePublicPath, summaryModel.routeMethod)
      const { value: completion } = await callUpstreamJson<ChatCompletion>(env, {
        route,
        body: {
          model: summaryModel.id,
          messages: [{ role: 'user', content: buildSummaryPrompt(aggregate) }],
          max_tokens: 200,
          stream: false,
        },
        timeoutMs: 15_000,
        budgetAtomic: parseUsd(TIER_UPSTREAM_BUDGET_USD[summaryModel.tier]),
      })
      const text = completion.choices?.[0]?.message?.content
      if (typeof text === 'string' && text.trim().length > 0) summary = text.trim()
    } catch (e: any) {
      // Deliberately swallowed — the deterministic summary already stands.
      console.warn('[playground] blend narration skipped:', e?.message)
    }
  }

  const settled = await commit(env, id, priceAtomic)
  if (!settled.ok) return ledgerErrorResponse(settled)

  return json({
    call_id: id,
    summary,
    events_table: {
      contract_id: aggregate.contract_id,
      events_examined: aggregate.events_examined,
      ledger_range: aggregate.ledger_range,
      rows: aggregate.rows,
    },
    charged_usd: formatUsd(parseAtomic(settled.value.call.charged)),
    balance_usd: formatUsd(parseAtomic(settled.value.balance)),
  })
}

// ---------------------------------------------------------------------------
// POST /v1/playground/tx-decode
// ---------------------------------------------------------------------------

export async function handlePlaygroundTxDecode(request: Request, env: Env): Promise<Response> {
  if (!playgroundEnabled(env)) return disabled()
  const session = await authenticate(request, env)
  if (session instanceof Response) return session

  const body = await readJsonBody(request)
  const id = callId(body)
  if (!id) return fail(400, 'invalid_request', 'call_id must be an opaque id of 8-64 characters')

  const txHash = typeof body.tx_hash === 'string' ? body.tx_hash.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    return fail(400, 'invalid_request', 'tx_hash must be a 64-character hex transaction hash')
  }

  const chip = findChip('tx-decode')!
  const priceAtomic = parseUsd(chip.priceUsd)

  let route
  try {
    route = resolvePlaygroundRoute('/v1/services/mercury/txs/by-hash', 'GET')
  } catch (e: any) {
    return fail(e?.status ?? 503, e?.code ?? 'route_unavailable', e?.message ?? 'route unavailable')
  }

  const started = await beginCall(env, session.account, { callId: id, chip: chip.id, priceAtomic })
  if (started instanceof Response) return started

  let result: unknown
  let paid: boolean
  try {
    ;({ value: result, paid } = await callUpstreamJson(env, {
      route,
      query: { tx_hash: txHash },
      budgetAtomic: parseUsd(chip.budgetUsd),
    }))
  } catch (e) {
    return failCall(env, id, e, priceAtomic)
  }

  if (!paid) return releaseUnpaid(env, id)

  const settled = await commit(env, id, priceAtomic)
  if (!settled.ok) return ledgerErrorResponse(settled)

  return json({
    call_id: id,
    tx_hash: txHash,
    transaction: result,
    charged_usd: formatUsd(parseAtomic(settled.value.call.charged)),
    balance_usd: formatUsd(parseAtomic(settled.value.balance)),
  })
}
