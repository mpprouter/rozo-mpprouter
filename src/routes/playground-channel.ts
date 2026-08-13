/**
 * Non-custodial "channel playground" endpoints (Stellar one-way payment
 * channel). Lives ALONGSIDE the custodial prepaid-ledger playground in
 * src/routes/playground.ts — nothing there is deleted; the cutover and removal
 * happen in a later step once this path is verified live. Every route here
 * 404s unless PLAYGROUND_CHANNEL_ENABLED === 'true'.
 *
 * Model: the router is the channel PAYEE (a dedicated collector). A user opens a
 * Soroban channel with Freighter (to = collector), then spends by signing
 * cumulative ed25519 vouchers with a browser-ephemeral commitment key.
 *
 * ISOLATION (P0-A): playground channels live in their OWN registry namespace
 * (pgChannel:* / pgAgent:*, see channel-pg-store.ts) and are resolved by their
 * OWN dispatch (channel-pg-dispatch.ts), NEVER the production
 * stellarChannel/stellarAgent registry the paid proxy trusts. The mppx VERIFY
 * primitive (createStellarChannelPayment) and the delivery-lock / rollback
 * helpers are reused because they are generic over (channel, commitmentKey) and
 * keyed by the unique contract address — but the registry is fully separate.
 *
 * Also reused: callUpstreamJson / resolvePlaygroundRoute (playground/upstream.ts),
 * the model/chip allow-list (playground/models.ts), real-cost pricing
 * (playground/channel-config.ts). On any upstream failure the voucher is rolled
 * back so nothing is billed; a kept charge persists its signature atomically or
 * fails closed (channel-voucher-store.ts).
 */

import { Credential } from 'mppx'
import { Store } from 'mppx/server'
import type { Env } from '../index'
import { doAtomicParams } from '../mpp/kv-atomic-store'
import { getStellarUsdcSac } from '../mpp/stellar-server'
import {
  acquireChannelDeliveryLock,
  releaseChannelDeliveryLock,
  revalidateChannelDeliveryLock,
  rollbackFailedChannelVoucher,
  StellarChannelNotRegisteredError,
} from '../mpp/stellar-channel-dispatch'
import { resolvePgChannelMppx } from '../playground/channel-pg-dispatch'
import {
  getPgChannel,
  putPgChannel,
  pgChannelProvenanceOk,
  PG_PROVENANCE_VERSION,
  type PgChannelState,
} from '../playground/channel-pg-store'
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
  CHANNEL_MIN_DEPOSIT_RAW,
  CHANNEL_REFUND_WAITING_PERIOD,
  channelCollector,
  channelPlaygroundEnabled,
  channelPriceForChip,
  channelPriceForModel,
  channelWasmHash,
  priceToChannelAmount,
} from '../playground/channel-config'
import {
  checkChannelMatches,
  readChannelOnChain,
  type OnChainChannel,
} from '../playground/channel-onchain'
import {
  fenceChannelPersistent,
  getLatestVoucher,
  incrSupersededAbort,
  isChannelBlocked,
  markChannelClosed,
  putLatestVoucher,
} from '../playground/channel-voucher-store'
import {
  BLEND_SUMMARY_MODEL_ID,
  FORCED_MAX_TOKENS,
  MAX_MESSAGES_PER_TURN,
  MAX_MESSAGE_CHARS,
  ModelNotAllowedError,
  PLAYGROUND_MODELS,
  TIER_UPSTREAM_BUDGET_USD,
  assertModelCallable,
  findChip,
  findModel,
} from '../playground/models'
import { checkAndBumpDailyLimit, utcDateKey } from '../mpp/rate-limit-do'
import { UpstreamError, callUpstreamJson, resolvePlaygroundRoute } from '../playground/upstream'

// ---------------------------------------------------------------------------
// small helpers (kept local; the custodial playground has its own copies and
// we do not want to couple the two files during the alongside phase)
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

function disabled(): Response {
  return fail(404, 'not_found', 'channel playground is not enabled')
}

const G_ADDRESS = /^G[A-Z2-7]{55}$/
const C_ADDRESS = /^C[A-Z2-7]{55}$/
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function callId(body: Record<string, unknown>): string | null {
  const supplied = body.call_id
  if (supplied === undefined || supplied === null) return crypto.randomUUID()
  if (typeof supplied === 'string' && ID_PATTERN.test(supplied)) return supplied
  return null
}

// ---------------------------------------------------------------------------
// POST /v1/playground/channel/register
// ---------------------------------------------------------------------------

/** Injectable on-chain reader so tests need no live RPC. */
export interface ChannelRegisterDeps {
  readChannelOnChain: (env: Env, channelContract: string, usdcSac: string) => Promise<OnChainChannel>
}

const DEFAULT_DEPS: ChannelRegisterDeps = {
  readChannelOnChain: (env, c, usdcSac) => readChannelOnChain(env, c, usdcSac),
}

/**
 * Register a channel the client opened on-chain. Unlike the trusting admin
 * script (scripts/admin/register-stellar-channel.ts) this VERIFIES the channel
 * on-chain before writing KV: the contract's WASM hash must equal our known
 * channel WASM (provenance), the on-chain `to` must be the collector, the token
 * must be the pubnet USDC SAC, the funder + commitment key must match what the
 * client claims, the refund period must be the required value, and the channel
 * must hold a REAL USDC balance (queried from the SAC, not self-reported) above
 * the minimum. Only then do we write the ISOLATED `pgChannel:<C>` /
 * `pgAgent:<G>` records (never the production stellarChannel/stellarAgent path)
 * that make the router honor this channel's vouchers, stamping the provenance
 * so dispatch + settlement can re-assert it on use.
 *
 * Idempotent: re-registering an identical channel returns 200 { replayed:true }.
 * Rate-limited per IP, fail-closed.
 */
export async function handleChannelRegister(
  request: Request,
  env: Env,
  deps: ChannelRegisterDeps = DEFAULT_DEPS,
): Promise<Response> {
  if (!channelPlaygroundEnabled(env)) return disabled()

  // Per-IP daily rate limit, fail-closed. A public endpoint that triggers two
  // Soroban RPC reads must not be free to hammer.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  try {
    const rl = await checkAndBumpDailyLimit(
      env,
      `channel-register:${ip}:${utcDateKey()}`,
      30,
    )
    if (!rl.ok) {
      return fail(429, 'rate_limited', 'too many channel registrations from this IP today')
    }
  } catch (e: any) {
    console.error('[channel] register rate-limit check failed:', e?.message)
    return fail(503, 'rate_limit_unavailable', 'could not check rate limit; try again shortly')
  }

  // Frontend (PR #20) contract: snake_case body.
  //   { channel_contract, funder, commitment_key, token, network, deposit_raw, open_tx_hash? }
  const body = await readJsonBody(request)
  const channelContract = typeof body.channel_contract === 'string' ? body.channel_contract.trim() : ''
  const agentAccount = typeof body.funder === 'string' ? body.funder.trim() : ''
  const commitmentKey = typeof body.commitment_key === 'string' ? body.commitment_key.trim() : ''
  const currency = typeof body.token === 'string' ? body.token.trim() : ''
  const network = typeof body.network === 'string' ? body.network.trim() : env.STELLAR_NETWORK
  // open_tx_hash is accepted for client correlation/logging only — the trust
  // comes from the on-chain read below, never from a client-supplied tx hash.
  const openTxHash = typeof body.open_tx_hash === 'string' ? body.open_tx_hash.trim() : ''
  if (openTxHash) console.log(`[channel] register ${channelContract} open_tx=${openTxHash}`)

  if (!C_ADDRESS.test(channelContract)) {
    return fail(400, 'invalid_channel', 'channelContract must be a Soroban contract address (C...)')
  }
  if (!G_ADDRESS.test(agentAccount)) {
    return fail(400, 'invalid_funder', 'agentAccount must be a Stellar public key (G...)')
  }
  if (!G_ADDRESS.test(commitmentKey)) {
    return fail(400, 'invalid_commitment_key', 'commitmentKey must be an ed25519 public key (G...)')
  }

  const usdcSac = getStellarUsdcSac(env)

  // Fail closed unless the collector account AND our channel WASM hash are
  // configured — without them there is no trust anchor to verify against.
  const collector = channelCollector(env)
  if (!collector) {
    return fail(503, 'collector_not_configured', 'playground collector account is not configured')
  }
  const wasmHash = channelWasmHash(env)
  if (!wasmHash) {
    return fail(503, 'wasm_not_configured', 'playground channel WASM hash is not configured')
  }

  // Only USDC channels in the playground (design Q5). Reject a mismatched
  // currency early so we never register an XLM channel the metered path
  // (which skips FX) cannot price.
  if (currency && currency !== usdcSac) {
    return fail(400, 'unsupported_currency', 'only the pubnet USDC SAC is supported')
  }
  if (network !== env.STELLAR_NETWORK) {
    return fail(400, 'network_mismatch', `network must be ${env.STELLAR_NETWORK}`)
  }

  // Idempotency / conflict. A replay short-circuit MUST only hold to a record
  // that still passes provenance (P0-A): a stored record with different params
  // is a conflict; one whose provenance is stale (predates verification, or
  // config drifted) is NOT trusted — we fall through to full on-chain
  // re-verification and overwrite it.
  const existing = await getPgChannel(env, channelContract)
  if (existing) {
    const sameParams =
      existing.agentAccount === agentAccount && existing.commitmentKey === commitmentKey
    if (!sameParams) {
      return fail(409, 'channel_conflict', 'this channel is already registered with different parameters')
    }
    if (pgChannelProvenanceOk(existing, env)) {
      return json({
        ok: true,
        replayed: true,
        channel: channelContract,
        funder: agentAccount,
        commitment_key: commitmentKey,
        deposit_usd: formatUsd(parseAtomic(existing.depositRaw)),
      })
    }
    // else: same params but un-provenanced record → re-verify on-chain below.
  }

  // On-chain verification — the trust boundary. Any RPC/decode failure is a
  // 502; we never trust the client's word for what the channel contains.
  let onchain: OnChainChannel
  try {
    onchain = await deps.readChannelOnChain(env, channelContract, usdcSac)
  } catch (e: any) {
    console.error(`[channel] on-chain read failed for ${channelContract}: ${e?.message}`)
    return fail(502, 'onchain_read_failed', 'could not read the channel on-chain')
  }

  const check = checkChannelMatches(onchain, {
    collector,
    usdcSac,
    funder: agentAccount,
    commitmentKeyG: commitmentKey,
    refundWaitingPeriod: CHANNEL_REFUND_WAITING_PERIOD,
    minDepositRaw: CHANNEL_MIN_DEPOSIT_RAW,
    wasmHash,
  })
  if (!check.ok) {
    return fail(400, check.reason, check.detail)
  }

  // Persist into the ISOLATED playground registry (never the production
  // stellarChannel/stellarAgent path). depositRaw is the ON-CHAIN balance, not
  // the client's claim. Stamp the provenance we just verified so dispatch +
  // settlement can re-assert it on use.
  const state: PgChannelState = {
    channelContract,
    commitmentKey,
    agentAccount,
    currency: usdcSac,
    network: env.STELLAR_NETWORK,
    depositRaw: onchain.balanceRaw,
    to: collector,
    wasmHash,
    provenanceVersion: PG_PROVENANCE_VERSION,
    openedAt: new Date().toISOString(),
  }
  await putPgChannel(env, state)

  return json({
    ok: true,
    replayed: false,
    channel: channelContract,
    funder: agentAccount,
    commitment_key: commitmentKey,
    deposit_usd: formatUsd(parseAtomic(onchain.balanceRaw)),
  })
}

// ---------------------------------------------------------------------------
// shared voucher-authenticated metered call
// ---------------------------------------------------------------------------

interface ChannelVoucher {
  challengeId: string
  acceptedAmount: string
  previousAmount: string
  action: 'voucher' | 'close'
  /** The cumulative amount the client signed, as the decimal channel string. */
  amountDecimal: string
  /** Raw ed25519 signature over the commitment (as the credential carried it). */
  signature: string
}

/**
 * Result of the verify phase: either a Response to return immediately (402
 * challenge, error) or a verified voucher + a `settle` helper the caller uses
 * after the upstream call decides commit-vs-rollback.
 */
type VerifyOutcome =
  | { kind: 'respond'; response: Response }
  | {
      kind: 'verified'
      channelContract: string
      voucher: ChannelVoucher
      lockId: string
      withReceipt: (r: Response) => Response
    }

/**
 * Verify the client's cumulative voucher for a charge of `priceRaw` using the
 * EXISTING dispatch engine. Mirrors the channel branch of proxy.ts (issue 402,
 * acquire delivery lock, read previous cumulative, capture the signed voucher)
 * but for a router-priced playground call rather than a merchant-driven one.
 */
async function verifyChannelVoucher(
  request: Request,
  env: Env,
  priceRaw: bigint,
  reference: string,
): Promise<VerifyOutcome> {
  const url = new URL(request.url)
  const authHeader = request.headers.get('Authorization')
  const agentHint = url.searchParams.get('agent')

  let resolved
  try {
    resolved = await resolvePgChannelMppx(env, authHeader, agentHint)
  } catch (err: any) {
    if (err instanceof StellarChannelNotRegisteredError) {
      return {
        kind: 'respond',
        response: fail(402, 'channel_not_registered', err.message, {
          hint: 'Open a channel and POST /v1/playground/channel/register first.',
        }),
      }
    }
    return {
      kind: 'respond',
      response: fail(400, 'channel_unresolved', err?.message ?? 'could not resolve channel'),
    }
  }

  const mppx = resolved.mppx as any
  const channelContract = resolved.channelContract

  // Non-USDC channels are rejected at register time, so no FX here.
  const channelAmount = priceToChannelAmount(priceRaw)

  const mppxInput = new Request(request.url, {
    method: request.method,
    headers: request.headers,
  })

  let voucher: ChannelVoucher | undefined
  let lockId: string | undefined
  let previousAmount = '0'

  if (authHeader) {
    lockId = crypto.randomUUID()
    const acquired = await acquireChannelDeliveryLock(env, channelContract, lockId)
    if (!acquired) {
      return {
        kind: 'respond',
        response: fail(409, 'delivery_in_progress', 'another channel delivery is in progress', {
          retry_after: 2,
        }),
      }
    }
    // Fence gate (P0-C / P0-2): reject if the channel is blocked by EITHER the
    // fast atomic closed marker OR the durable KV fence — independent of lock
    // state, so a released/taken-over lock can never let a call advance a fenced
    // channel.
    if (await isChannelBlocked(env, channelContract)) {
      await releaseChannelDeliveryLock(env, channelContract, lockId)
      return {
        kind: 'respond',
        response: fail(410, 'channel_closed', 'this channel has been settled/closed; open a new one'),
      }
    }
    const store = Store.cloudflare(doAtomicParams(env.ATOMIC_STORE))
    const prev = (await store.get(`stellar:channel:cumulative:${channelContract}`)) as any
    previousAmount =
      prev && typeof prev === 'object' && 'amount' in prev ? String(prev.amount) : '0'

    // P0-1 (FUNDAMENTAL) — capacity gate. The one-way-channel contract assigns
    // the recipient (us) the duty of never accepting a commitment beyond the
    // channel's balance. Enforce `new_cumulative <= depositRaw` BEFORE advancing
    // or paying, under the delivery lock (so concurrent calls are serialized and
    // cannot jointly exceed the deposit). This bounds the router's TOTAL
    // exposure per channel to exactly the on-chain deposit captured at register.
    const prevRaw = parseAtomic(previousAmount)
    const depositRaw = parseAtomic(resolved.depositRaw)
    if (prevRaw + priceRaw > depositRaw) {
      await releaseChannelDeliveryLock(env, channelContract, lockId)
      const remaining = depositRaw > prevRaw ? depositRaw - prevRaw : 0n
      return {
        kind: 'respond',
        response: fail(
          402,
          'insufficient_channel_balance',
          'this call would exceed the channel deposit; top up or open a new channel',
          { remaining_usd: formatUsd(remaining), price_usd: formatUsd(priceRaw) },
        ),
      }
    }

    mppx.onPaymentSuccess((payment: any) => {
      const action = payment.credential.payload.action === 'close' ? 'close' : 'voucher'
      voucher = {
        challengeId: payment.challenge.id,
        acceptedAmount: String(payment.credential.payload.amount),
        previousAmount,
        action,
        amountDecimal: String(payment.credential.payload.amount),
        signature: String(payment.credential.payload.signature ?? ''),
      }
    })
  }

  let verifyResult
  try {
    verifyResult = await mppx['stellar/channel']({
      amount: channelAmount,
      channel: channelContract,
      methodDetails: { reference },
    })(mppxInput)
  } catch (err: any) {
    if (lockId) await releaseChannelDeliveryLock(env, channelContract, lockId)
    return {
      kind: 'respond',
      response: fail(402, 'voucher_verification_failed', err?.message ?? 'voucher verify failed'),
    }
  }

  if (verifyResult.status === 402) {
    if (lockId) await releaseChannelDeliveryLock(env, channelContract, lockId)
    // No credential yet (first probe) or a rejected/replayed voucher. Return
    // the challenge so the client's channel method signs the next cumulative.
    return { kind: 'respond', response: verifyResult.challenge }
  }

  // Defensive recovery — mppx isolates observer callbacks, so reconstruct the
  // voucher from the just-verified credential if the hook did not fire.
  if (!voucher && authHeader) {
    try {
      const credential = Credential.deserialize(authHeader) as any
      const action = credential.payload.action === 'close' ? 'close' : 'voucher'
      voucher = {
        challengeId: credential.challenge.id,
        acceptedAmount: String(credential.payload.amount),
        previousAmount,
        action,
        amountDecimal: String(credential.payload.amount),
        signature: String(credential.payload.signature ?? ''),
      }
    } catch (e: any) {
      console.error(`[channel] voucher recovery failed: ${e?.message}`)
    }
  }

  if (!voucher) {
    if (lockId) await releaseChannelDeliveryLock(env, channelContract, lockId)
    return {
      kind: 'respond',
      response: verifyResult.withReceipt(
        fail(503, 'delivery_stopped', 'voucher verified but capture failed; no upstream call made'),
      ),
    }
  }

  if (voucher.action !== 'voucher') {
    // A `close` voucher is the settle-and-refund path, not a metered call.
    if (lockId) {
      await rollbackFailedChannelVoucher(
        env,
        channelContract,
        voucher.acceptedAmount,
        voucher.previousAmount,
        voucher.challengeId,
      ).catch(() => {})
      await releaseChannelDeliveryLock(env, channelContract, lockId)
    }
    return {
      kind: 'respond',
      response: verifyResult.withReceipt(
        fail(400, 'close_not_metered', 'close vouchers are not accepted on metered call endpoints'),
      ),
    }
  }

  return {
    kind: 'verified',
    channelContract,
    voucher,
    lockId: lockId!,
    withReceipt: (r: Response) => verifyResult.withReceipt(r),
  }
}

/**
 * Reverse the charge for a call that must NOT stand (unpaid, or a paid call
 * whose voucher could not be persisted). Rolls the mppx cumulative back to the
 * previous watermark so the NEXT call's quote starts from the right place.
 *
 * P0-2: if the rollback itself fails, the watermark is left advanced while the
 * stored (redeemable) voucher is still the PREVIOUS one — a subsequent call
 * would then absorb this failed increment into its own cumulative. To stop
 * that, we FENCE the channel (mark it closed) so no further call proceeds. The
 * money statement stays accurate either way: the collector redeems only the
 * stored voucher, which never includes this un-persisted increment, so the
 * caller reports charged_usd = 0 for this call. Never releases the lock — the
 * caller's finally owns that.
 */
async function reverseChargeOrFence(
  env: Env,
  channelContract: string,
  voucher: ChannelVoucher,
): Promise<void> {
  let rolledBack = false
  try {
    rolledBack = await rollbackFailedChannelVoucher(
      env,
      channelContract,
      voucher.acceptedAmount,
      voucher.previousAmount,
      voucher.challengeId,
    )
  } catch (e: any) {
    console.error(`[channel] voucher rollback threw for ${channelContract}: ${e?.message}`)
  }
  if (!rolledBack) {
    // Could not cleanly restore the watermark → FENCE so no later call can
    // advance from this stale watermark and absorb the un-charged increment.
    // The durable KV fence is independent of the lock and retried, so it holds
    // even if the fast atomic marker write fails and even after the lock later
    // releases or is taken over. Fail-closed: a fence that cannot be written at
    // all is logged CRITICAL (astronomically rare — both stores down).
    console.error(`[channel] rollback did not restore watermark for ${channelContract}; fencing`)
    await markChannelClosed(env, channelContract).catch(() => {})
    const fenced = await fenceChannelPersistent(env, channelContract)
    if (!fenced) {
      console.error(
        `[channel] CRITICAL: could not persist fence for ${channelContract}; ` +
          `a later call could advance a stale watermark until an operator fences it`,
      )
    }
  }
}

/**
 * Is a redeemable voucher for `cumulativeRaw` already stored? Reads the atomic
 * (strongly-consistent) latest-voucher record.
 *   'covered'  — stored cumulative ≥ ours: the collector CAN redeem this call.
 *   'not'      — stored cumulative < ours: confirmed nothing covers this call.
 *   'unknown'  — the readback itself failed: we cannot confirm either way.
 * Round-6 rule: a charge stands ONLY on a CONFIRMED 'covered'. Both 'not' and
 * 'unknown' are treated as "no confirmed redeemable voucher" → absorb + fence +
 * report $0. We never report a charge unless coverage is positively confirmed.
 */
async function checkCovered(
  env: Env,
  channelContract: string,
  cumulativeRaw: bigint,
): Promise<'covered' | 'not' | 'unknown'> {
  try {
    const v = await getLatestVoucher(env, channelContract)
    if (v && BigInt(v.cumulativeRaw) >= cumulativeRaw) return 'covered'
    return 'not'
  } catch {
    return 'unknown'
  }
}

type PersistOutcome = 'committed' | 'reversed'

/**
 * Post-pay absorb: the router PAID upstream but no redeemable voucher for this
 * call is confirmed stored. Roll the watermark back for accounting AND — the
 * round-6 rule — ALWAYS fence the channel so the freed capacity can never be
 * re-spent. Without the fence, an attacker could pay → fail-to-persist →
 * rollback-frees-capacity → repeat, driving cumulative router loss PAST the
 * deposit (unbounded). With the fence, no further call touches this channel, so
 * the loss stays bounded to `deposit + this one in-flight call`. Recon-counted.
 * Never releases the lock — the caller's finally owns that.
 */
async function absorbPaidCallAndFence(
  env: Env,
  channelContract: string,
  voucher: ChannelVoucher,
): Promise<void> {
  // Best-effort watermark rollback (accounting hygiene). Safe even when
  // superseded: rollbackFailedChannelVoucher CAS-checks the current amount and
  // no-ops if a newer holder already advanced past us.
  try {
    await rollbackFailedChannelVoucher(
      env,
      channelContract,
      voucher.acceptedAmount,
      voucher.previousAmount,
      voucher.challengeId,
    )
  } catch (e: any) {
    console.error(`[channel] absorb rollback threw for ${channelContract}: ${e?.message}`)
  }
  // ALWAYS fence — the freed capacity must not be re-spendable.
  const fenced = await fenceChannelPersistent(env, channelContract)
  if (!fenced) {
    console.error(
      `[channel] CRITICAL: could not fence ${channelContract} after a post-pay persist failure; ` +
        `freed capacity could be re-spent until an operator fences it`,
    )
  }
  await incrSupersededAbort(env).catch(() => {})
}

/**
 * Persist the redeemable latest voucher for a PAID call. Round-6 invariant: a
 * charge stands ('committed') ONLY when a redeemable voucher for this call is
 * CONFIRMED stored — the write returned success, or an ambiguous write is proven
 * landed by a positive read-back ('covered'). EVERY other outcome (no signature,
 * confirmed-not-stored, or an unconfirmable 'unknown' read-back) absorbs this
 * paid call and FENCES the channel, then reports 'reversed' ($0). Never releases
 * the lock.
 */
async function persistVoucherOrReverse(
  env: Env,
  channelContract: string,
  voucher: ChannelVoucher,
): Promise<PersistOutcome> {
  if (!voucher.signature) {
    console.error(`[channel] no signature on kept voucher for ${channelContract}; absorbing + fencing`)
    await absorbPaidCallAndFence(env, channelContract, voucher)
    return 'reversed'
  }
  const ourCumulative = parseUsd(voucher.amountDecimal)
  try {
    await putLatestVoucher(env, channelContract, {
      amountDecimal: voucher.amountDecimal,
      cumulativeRaw: ourCumulative.toString(),
      signature: voucher.signature,
    })
    return 'committed'
  } catch (e: any) {
    // The atomic write threw. Read back: only a CONFIRMED positive read-back may
    // report the charge. 'not' AND 'unknown' both absorb + fence (P0-1/P0-2) —
    // we never report a charge without a confirmed redeemable voucher.
    const cov = await checkCovered(env, channelContract, ourCumulative)
    if (cov === 'covered') {
      console.warn(
        `[channel] voucher persist ambiguous for ${channelContract} but read-back confirms ` +
          `stored; charge stands`,
      )
      return 'committed'
    }
    console.error(
      `[channel] voucher persist failed for ${channelContract} (${cov}): ${e?.message}; ` +
        `absorbing this paid call + fencing (recon-counted)`,
    )
    await absorbPaidCallAndFence(env, channelContract, voucher)
    return 'reversed'
  }
}

/**
 * Persist a PAID call's voucher, but only if we still hold the fencing token.
 * Returns a Response to return immediately (failure/supersede) or null on
 * success (the charge stands; caller builds the body).
 *
 * No CAS rejection silently escapes. If we still hold the token we persist
 * (round-6 semantics above). If a TTL takeover superseded us AFTER we paid, we
 * read back: ONLY a CONFIRMED positive read-back ('covered') lets the charge
 * stand; 'not' AND 'unknown' both absorb this call + FENCE the channel + report
 * $0 — never a charge without a confirmed redeemable voucher, never freed
 * capacity that can be re-spent.
 */
async function commitPaidVoucher(
  env: Env,
  channelContract: string,
  voucher: ChannelVoucher,
  lockId: string,
  id: string,
): Promise<Response | null> {
  if (await revalidateChannelDeliveryLock(env, channelContract, lockId)) {
    return (await persistVoucherOrReverse(env, channelContract, voucher)) === 'committed'
      ? null
      : settlementFailed(id)
  }

  // Superseded AFTER payment (only reachable after a multi-minute hang past the
  // 300s TTL). Do NOT persist stale state.
  const ourCumulative = parseUsd(voucher.amountDecimal)
  const cov = await checkCovered(env, channelContract, ourCumulative)
  if (cov === 'covered') {
    // A redeemable voucher for this cumulative is CONFIRMED stored (a newer
    // holder). The charge stands — it is genuinely redeemable.
    console.warn(
      `[channel] superseded-after-pay on ${channelContract} but read-back confirms a stored ` +
        `voucher covers this call; charge stands`,
    )
    return null
  }
  // 'not' OR 'unknown' → cannot confirm a redeemable voucher → DOCUMENTED bounded
  // router loss. Absorb + fence so no later call re-spends this channel.
  await absorbPaidCallAndFence(env, channelContract, voucher)
  console.error(
    `[channel] paid-then-superseded on ${channelContract} (${cov}): not confirmed redeemable; ` +
      `absorbing + fencing (recon-counted)`,
  )
  return fail(409, 'lock_superseded_after_pay', 'this call was superseded after payment; you were not charged', {
    call_id: id,
    charged_usd: '0.00',
  })
}

/** Response when the settlement voucher could not be persisted (charge reversed). */
function settlementFailed(id: string): Response {
  return fail(
    502,
    'settlement_persist_failed',
    'could not persist the settlement voucher; the charge was reversed',
    { call_id: id, charged_usd: '0.00' },
  )
}

/** Effective charge/cost figures for a response body. */
function pricingFields(priceRaw: bigint, maxUpstreamRaw: bigint, upstreamCostRaw?: string) {
  // The captured real cost (USDC-6 from the charge seam) is for display only —
  // convert to 7-decimal atomic. The CHARGE is always the quote (priceRaw),
  // which the client signed and which by construction (quote = maxUpstream +
  // markup, and the upstream budget == maxUpstream) always covers the real
  // cost. A captured cost above the quote would mean the budget guard was
  // bypassed — that is a bug, logged loudly, never silently absorbed as policy.
  let realCostRaw = maxUpstreamRaw
  if (upstreamCostRaw && /^\d+$/.test(upstreamCostRaw)) {
    realCostRaw = BigInt(upstreamCostRaw) * 10n // USDC-6 → 7-decimal atomic
    if (realCostRaw > priceRaw) {
      console.error(
        `[channel] BUG: real upstream cost ${realCostRaw} exceeded quote ${priceRaw}. ` +
          `The budget ceiling should make this impossible; the user is still only charged the quote.`,
      )
    }
  }
  return {
    charged_usd: formatUsd(priceRaw),
    upstream_cost_usd: formatUsd(realCostRaw),
    markup_usd: formatUsd(priceRaw - maxUpstreamRaw),
  }
}

// ---------------------------------------------------------------------------
// POST /v1/playground/channel/chat
// ---------------------------------------------------------------------------

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

function sanitizeMessages(raw: unknown): ChatMessage[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'messages must be a non-empty array' }
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

export async function handleChannelChat(request: Request, env: Env): Promise<Response> {
  if (!channelPlaygroundEnabled(env)) return disabled()

  const body = await readJsonBody(request)
  const id = callId(body)
  if (!id) return fail(400, 'invalid_request', 'call_id must be an opaque id of 8-64 characters')

  let model
  try {
    model = assertModelCallable(body.model)
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

  const { maxUpstreamRaw, priceRaw } = channelPriceForModel(model)

  return executeMeteredChannelCall(
    request,
    env,
    id,
    priceRaw,
    maxUpstreamRaw,
    () =>
      callUpstreamJson<ChatCompletion>(env, {
        route,
        body: { model: model.id, messages, max_tokens: FORCED_MAX_TOKENS, stream: false },
        budgetAtomic: parseUsd(TIER_UPSTREAM_BUDGET_USD[model.tier]),
      }),
    async value => {
      const text = (value as ChatCompletion).choices?.[0]?.message?.content
      if (typeof text !== 'string' || text.length === 0) return null
      return { message: text, model: model.id }
    },
  )
}

// ---------------------------------------------------------------------------
// POST /v1/playground/channel/blend-activity
// ---------------------------------------------------------------------------

export async function handleChannelBlendActivity(request: Request, env: Env): Promise<Response> {
  if (!channelPlaygroundEnabled(env)) return disabled()

  const body = await readJsonBody(request)
  const id = callId(body)
  if (!id) return fail(400, 'invalid_request', 'call_id must be an opaque id of 8-64 characters')

  const chip = findChip('blend-activity')!
  const { maxUpstreamRaw, priceRaw } = channelPriceForChip(chip)

  let eventsRoute
  try {
    eventsRoute = resolvePlaygroundRoute('/v1/services/mercury/events/by-contract', 'GET')
  } catch (e: any) {
    return fail(e?.status ?? 503, e?.code ?? 'route_unavailable', e?.message ?? 'route unavailable')
  }

  return executeMeteredChannelCall(
    request,
    env,
    id,
    priceRaw,
    maxUpstreamRaw,
    () =>
      callUpstreamJson(env, {
        route: eventsRoute,
        query: { contract_id: BLEND_MAIN_POOL_CONTRACT_ID, limit: String(BLEND_EVENT_LIMIT) },
        budgetAtomic: parseUsd(chip.budgetUsd),
      }),
    async raw => {
      const aggregate = aggregateBlendEvents(extractEvents(raw), BLEND_MAIN_POOL_CONTRACT_ID)
      // Narration: bounded, optional, best-effort. Runs AFTER the voucher is
      // persisted (charge already stands); a failure is swallowed. Its max cost
      // is already folded into the quote (channel-config.ts).
      let summary = describeAggregate(aggregate)
      const summaryModel = findModel(BLEND_SUMMARY_MODEL_ID)
      if (summaryModel?.available && aggregate.events_examined > 0) {
        try {
          const nRoute = resolvePlaygroundRoute(
            summaryModel.routePublicPath,
            summaryModel.routeMethod,
          )
          const { value: nCompletion } = await callUpstreamJson<ChatCompletion>(env, {
            route: nRoute,
            body: {
              model: summaryModel.id,
              messages: [{ role: 'user', content: buildSummaryPrompt(aggregate) }],
              max_tokens: 200,
              stream: false,
            },
            timeoutMs: 15_000,
            budgetAtomic: parseUsd(TIER_UPSTREAM_BUDGET_USD[summaryModel.tier]),
          })
          const t = nCompletion.choices?.[0]?.message?.content
          if (typeof t === 'string' && t.trim().length > 0) summary = t.trim()
        } catch (e: any) {
          console.warn('[channel] blend narration skipped:', e?.message)
        }
      }
      return {
        summary,
        events_table: {
          contract_id: aggregate.contract_id,
          events_examined: aggregate.events_examined,
          ledger_range: aggregate.ledger_range,
          rows: aggregate.rows,
        },
      }
    },
  )
}

// ---------------------------------------------------------------------------
// POST /v1/playground/channel/tx-decode
// ---------------------------------------------------------------------------

export async function handleChannelTxDecode(request: Request, env: Env): Promise<Response> {
  if (!channelPlaygroundEnabled(env)) return disabled()

  const body = await readJsonBody(request)
  const id = callId(body)
  if (!id) return fail(400, 'invalid_request', 'call_id must be an opaque id of 8-64 characters')

  const txHash = typeof body.tx_hash === 'string' ? body.tx_hash.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    return fail(400, 'invalid_request', 'tx_hash must be a 64-character hex transaction hash')
  }

  const chip = findChip('tx-decode')!
  const { maxUpstreamRaw, priceRaw } = channelPriceForChip(chip)

  let route
  try {
    route = resolvePlaygroundRoute('/v1/services/mercury/txs/by-hash', 'GET')
  } catch (e: any) {
    return fail(e?.status ?? 503, e?.code ?? 'route_unavailable', e?.message ?? 'route unavailable')
  }

  return executeMeteredChannelCall(
    request,
    env,
    id,
    priceRaw,
    maxUpstreamRaw,
    () =>
      callUpstreamJson(env, {
        route,
        query: { tx_hash: txHash },
        budgetAtomic: parseUsd(chip.budgetUsd),
      }),
    async result => ({ tx_hash: txHash, transaction: result }),
  )
}

/**
 * The one place the metered-call money invariant is enforced. Post-verify work
 * runs inside a try/FINALLY so the delivery lock is ALWAYS released (P0-3a), and
 * the ordering guarantees that once upstream is PAID the redeemable voucher is
 * persisted BEFORE the response body is ever inspected (P0-4). On every path the
 * user's charged_usd equals what the collector can redeem.
 *
 * `doUpstream` performs the (possibly-throwing) paid call; `buildBody` turns a
 * successful upstream value into the response fields, or null when the paid body
 * is unusable (garbage/empty) — it must not throw the caller out of the paid
 * section (we catch it defensively and treat it as unusable).
 */
async function executeMeteredChannelCall(
  request: Request,
  env: Env,
  id: string,
  priceRaw: bigint,
  maxUpstreamRaw: bigint,
  doUpstream: () => Promise<{ value: unknown; paid: boolean; upstreamCostRaw?: string }>,
  buildBody: (value: unknown) => Promise<Record<string, unknown> | null>,
): Promise<Response> {
  const verify = await verifyChannelVoucher(request, env, priceRaw, id)
  if (verify.kind === 'respond') return verify.response
  const { channelContract, voucher, lockId, withReceipt } = verify

  let released = false
  const release = async () => {
    if (released) return
    released = true
    await releaseChannelDeliveryLock(env, channelContract, lockId).catch(() => {})
  }

  try {
    // Re-validate the fencing token BEFORE spending money. If a TTL takeover
    // superseded us, abort WITHOUT paying — no router loss, no charge. A success
    // also refreshes the lock TTL so the pay+persist that follow can't be raced.
    if (!(await revalidateChannelDeliveryLock(env, channelContract, lockId))) {
      await reverseChargeOrFence(env, channelContract, voucher)
      return withReceipt(
        fail(409, 'lock_superseded', 'this call was superseded before payment; you were not charged', {
          call_id: id,
          charged_usd: '0.00',
        }),
      )
    }

    let up: { value: unknown; paid: boolean; upstreamCostRaw?: string }
    try {
      up = await doUpstream()
    } catch (e) {
      const ue =
        e instanceof UpstreamError
          ? e
          : new UpstreamError('upstream_error', 502, (e as any)?.message ?? 'upstream call failed', 'no')
      if (ue.paymentEvidence === 'yes') {
        // Money moved → the charge stands. Persist the redeemable voucher
        // BEFORE returning (never leave an advanced, uncollectable cumulative),
        // re-checking the fencing token first.
        const r = await commitPaidVoucher(env, channelContract, voucher, lockId, id)
        if (r) return withReceipt(r)
        return withReceipt(
          fail(ue.status, ue.code, ue.message, {
            call_id: id,
            ...pricingFields(priceRaw, maxUpstreamRaw, undefined),
            support_note:
              'The upstream provider was paid but did not return a usable result, so this call was charged.',
          }),
        )
      }
      // No credential signed → nothing billed. charged_usd 0 is accurate.
      await reverseChargeOrFence(env, channelContract, voucher)
      return withReceipt(fail(ue.status, ue.code, ue.message, { call_id: id, charged_usd: '0.00' }))
    }

    if (!up.paid) {
      await reverseChargeOrFence(env, channelContract, voucher)
      return withReceipt(
        fail(502, 'upstream_unpaid', 'the call did not complete a payment; you were not charged', {
          call_id: id,
          charged_usd: '0.00',
        }),
      )
    }

    // PAID → persist the redeemable voucher BEFORE inspecting the body (P0-4),
    // re-checking the fencing token first (P0-1).
    {
      const r = await commitPaidVoucher(env, channelContract, voucher, lockId, id)
      if (r) return withReceipt(r)
    }

    // Parse AFTER persist. A garbage/null body must not escape the paid section;
    // treat any throw or null as an unusable-but-paid result (charge stands).
    let bodyFields: Record<string, unknown> | null = null
    try {
      bodyFields = await buildBody(up.value)
    } catch (e: any) {
      console.error(`[channel] response body build threw for ${id}: ${e?.message}`)
      bodyFields = null
    }
    if (!bodyFields) {
      return withReceipt(
        fail(502, 'upstream_empty', 'upstream was paid but returned no usable result', {
          call_id: id,
          ...pricingFields(priceRaw, maxUpstreamRaw, up.upstreamCostRaw),
          support_note:
            'The upstream provider was paid but did not return a usable result, so this call was charged.',
        }),
      )
    }
    return withReceipt(
      json({ call_id: id, ...bodyFields, ...pricingFields(priceRaw, maxUpstreamRaw, up.upstreamCostRaw) }),
    )
  } finally {
    // P0-3a: the lock is released on EVERY path — success, error, or throw.
    await release()
  }
}
