/**
 * Non-custodial "channel playground" endpoints (Stellar one-way payment
 * channel). Lives ALONGSIDE the custodial prepaid-ledger playground in
 * src/routes/playground.ts — nothing there is deleted; the cutover and removal
 * happen in a later step once this path is verified live. Every route here
 * 404s unless PLAYGROUND_CHANNEL_ENABLED === 'true'.
 *
 * Model: the router is the channel PAYEE. A user opens a Soroban channel with
 * Freighter (router = `to`), then spends by signing cumulative ed25519
 * vouchers with a browser-ephemeral commitment key. The router verifies each
 * voucher with the EXISTING production dispatch engine
 * (src/mpp/stellar-channel-dispatch.ts) — the same engine the paid proxy uses
 * — pays the upstream out of its own pool, and returns the result. On any
 * upstream failure the voucher is rolled back so nothing is billed.
 *
 * This module deliberately reuses, without reinventing:
 *   - resolveStellarChannelMppx / rollbackFailedChannelVoucher /
 *     acquire/releaseChannelDeliveryLock  (stellar-channel-dispatch.ts)
 *   - putStellarChannel / getStellarChannel                (stellar-channel-store.ts)
 *   - callUpstreamJson / resolvePlaygroundRoute            (playground/upstream.ts)
 *   - the model/chip allow-list + sanitiser                (playground/models.ts, playground.ts helpers)
 *   - real-cost pricing                                    (playground/channel-config.ts)
 */

import { Credential } from 'mppx'
import { Store } from 'mppx/server'
import type { Env } from '../index'
import { doAtomicParams } from '../mpp/kv-atomic-store'
import { getRouterStellarAddress, getStellarUsdcSac } from '../mpp/stellar-server'
import {
  acquireChannelDeliveryLock,
  releaseChannelDeliveryLock,
  resolveStellarChannelMppx,
  rollbackFailedChannelVoucher,
  StellarChannelNotRegisteredError,
} from '../mpp/stellar-channel-dispatch'
import {
  getStellarChannel,
  putStellarChannel,
  type StellarChannelState,
} from '../mpp/stellar-channel-store'
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
  channelFactoryAddress,
  channelPlaygroundEnabled,
  channelPriceForChip,
  channelPriceForModel,
  channelPricingConfig,
  priceToChannelAmount,
} from '../playground/channel-config'
import {
  checkChannelMatches,
  readChannelOnChain,
  type OnChainChannel,
} from '../playground/channel-onchain'
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
  readChannelOnChain: (env: Env, channelContract: string) => Promise<OnChainChannel>
}

const DEFAULT_DEPS: ChannelRegisterDeps = {
  readChannelOnChain: (env, c) => readChannelOnChain(env, c),
}

/**
 * Register a channel the client opened on-chain. Unlike the trusting admin
 * script (scripts/admin/register-stellar-channel.ts) this VERIFIES the channel
 * on-chain before writing KV: the on-chain `to` must be this router, the token
 * must be the pubnet USDC SAC, the funder + commitment key must match what the
 * client claims, the refund period must be the required value, and the channel
 * must actually hold a deposit above the minimum. Only then do we write the
 * `stellarChannel:<C>` / `stellarAgent:<G>` records that make the router honor
 * this channel's vouchers.
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
  const routerPublic = getRouterStellarAddress(env)

  // Only USDC channels in the playground (design Q5). Reject a mismatched
  // currency early so we never register an XLM channel the metered path
  // (which skips FX) cannot price.
  if (currency && currency !== usdcSac) {
    return fail(400, 'unsupported_currency', 'only the pubnet USDC SAC is supported')
  }
  if (network !== env.STELLAR_NETWORK) {
    return fail(400, 'network_mismatch', `network must be ${env.STELLAR_NETWORK}`)
  }

  // Idempotency / conflict: an existing record for this contract with the same
  // funder + commitment key is a replay (200). A different one is a conflict.
  const existing = await getStellarChannel(env, channelContract)
  if (existing) {
    if (existing.agentAccount === agentAccount && existing.commitmentKey === commitmentKey) {
      return json({
        ok: true,
        replayed: true,
        channel: channelContract,
        funder: agentAccount,
        commitment_key: commitmentKey,
        deposit_usd: formatUsd(parseAtomic(existing.depositRaw)),
      })
    }
    return fail(409, 'channel_conflict', 'this channel is already registered with different parameters')
  }

  // On-chain verification — the trust boundary. Any RPC/decode failure is a
  // 502; we never trust the client's word for what the channel contains.
  let onchain: OnChainChannel
  try {
    onchain = await deps.readChannelOnChain(env, channelContract)
  } catch (e: any) {
    console.error(`[channel] on-chain read failed for ${channelContract}: ${e?.message}`)
    return fail(502, 'onchain_read_failed', 'could not read the channel on-chain')
  }

  const check = checkChannelMatches(onchain, {
    routerPublic,
    usdcSac,
    funder: agentAccount,
    commitmentKeyG: commitmentKey,
    refundWaitingPeriod: CHANNEL_REFUND_WAITING_PERIOD,
    minDepositRaw: CHANNEL_MIN_DEPOSIT_RAW,
  })
  if (!check.ok) {
    return fail(400, check.reason, check.detail)
  }

  // Persist. depositRaw is the ON-CHAIN balance, not the client's claim.
  const state: StellarChannelState = {
    channelContract,
    commitmentKey,
    agentAccount,
    currency: usdcSac,
    network: env.STELLAR_NETWORK,
    depositRaw: onchain.balanceRaw,
    openedAt: new Date().toISOString(),
  }
  await putStellarChannel(env, channelContract, state)

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
    resolved = await resolveStellarChannelMppx(env, authHeader, agentHint)
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
    const store = Store.cloudflare(doAtomicParams(env.ATOMIC_STORE))
    const prev = (await store.get(`stellar:channel:cumulative:${channelContract}`)) as any
    previousAmount =
      prev && typeof prev === 'object' && 'amount' in prev ? String(prev.amount) : '0'
    mppx.onPaymentSuccess((payment: any) => {
      const action = payment.credential.payload.action === 'close' ? 'close' : 'voucher'
      voucher = {
        challengeId: payment.challenge.id,
        acceptedAmount: String(payment.credential.payload.amount),
        previousAmount,
        action,
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
 * Settle after the upstream call, preserving the single source of truth from
 * the custodial path: a charge stands ONLY when a credential was provably
 * signed for this call (`paid === true`, or an UpstreamError whose
 * paymentEvidence is 'yes'). Everything else rolls the voucher back so the
 * cumulative returns to `previousAmount` and nothing is billed.
 */
async function rollbackAndRelease(
  env: Env,
  channelContract: string,
  voucher: ChannelVoucher,
  lockId: string,
): Promise<boolean> {
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
    console.error(`[channel] voucher rollback failed: ${e?.message}`)
  }
  await releaseChannelDeliveryLock(env, channelContract, lockId).catch(() => {})
  return rolledBack
}

/** Effective charge/cost figures for a response body. */
function pricingFields(priceRaw: bigint, costRaw: bigint, upstreamCostRaw?: string) {
  // Reconcile: the real cost captured from the charge seam is USDC-6; convert
  // to the playground's 7-decimal atomic. Fall back to the known estimate.
  let realCostRaw = costRaw
  if (upstreamCostRaw && /^\d+$/.test(upstreamCostRaw)) {
    realCostRaw = BigInt(upstreamCostRaw) * 10n // USDC-6 → 7-decimal atomic
    if (realCostRaw > priceRaw) {
      // The quote should always cover the real cost. If it does not, the
      // router absorbs the (budget-bounded) difference — the client only ever
      // authorized `priceRaw`, so this can never overcharge. Log for recon.
      console.warn(
        `[channel] real cost ${realCostRaw} exceeded quote ${priceRaw}; router absorbs difference`,
      )
    }
  }
  return {
    charged_usd: formatUsd(priceRaw),
    upstream_cost_usd: formatUsd(realCostRaw),
    markup_usd: formatUsd(priceRaw - costRaw),
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

  const { costRaw, priceRaw } = channelPriceForModel(model)

  const verify = await verifyChannelVoucher(request, env, priceRaw, id)
  if (verify.kind === 'respond') return verify.response
  const { channelContract, voucher, lockId, withReceipt } = verify

  let completion: ChatCompletion
  let paid: boolean
  let upstreamCostRaw: string | undefined
  try {
    ;({ value: completion, paid, upstreamCostRaw } = await callUpstreamJson<ChatCompletion>(env, {
      route,
      body: {
        model: model.id,
        messages,
        max_tokens: FORCED_MAX_TOKENS,
        stream: false,
      },
      budgetAtomic: parseUsd(TIER_UPSTREAM_BUDGET_USD[model.tier]),
    }))
  } catch (e) {
    return withReceipt(await settleUpstreamError(env, channelContract, voucher, lockId, e))
  }

  if (!paid) {
    await rollbackAndRelease(env, channelContract, voucher, lockId)
    return withReceipt(
      fail(502, 'upstream_unpaid', 'the call did not complete a payment; you were not charged', {
        call_id: id,
        charged_usd: '0.00',
      }),
    )
  }

  const text = completion.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text.length === 0) {
    // paid === true: the router DID pay upstream, the content was just
    // unusable. Keep the charge (commit) with a support note.
    await releaseChannelDeliveryLock(env, channelContract, lockId).catch(() => {})
    return withReceipt(
      fail(502, 'upstream_empty', 'upstream returned no completion', {
        call_id: id,
        ...pricingFields(priceRaw, costRaw, upstreamCostRaw),
        support_note:
          'The upstream provider was paid but did not return a usable result, so this call was charged.',
      }),
    )
  }

  await releaseChannelDeliveryLock(env, channelContract, lockId).catch(() => {})
  return withReceipt(
    json({
      call_id: id,
      message: text,
      model: model.id,
      ...pricingFields(priceRaw, costRaw, upstreamCostRaw),
    }),
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
  const { costRaw, priceRaw } = channelPriceForChip(chip)

  let eventsRoute
  try {
    eventsRoute = resolvePlaygroundRoute('/v1/services/mercury/events/by-contract', 'GET')
  } catch (e: any) {
    return fail(e?.status ?? 503, e?.code ?? 'route_unavailable', e?.message ?? 'route unavailable')
  }

  const verify = await verifyChannelVoucher(request, env, priceRaw, id)
  if (verify.kind === 'respond') return verify.response
  const { channelContract, voucher, lockId, withReceipt } = verify

  let raw: unknown
  let paid: boolean
  let upstreamCostRaw: string | undefined
  try {
    ;({ value: raw, paid, upstreamCostRaw } = await callUpstreamJson(env, {
      route: eventsRoute,
      query: { contract_id: BLEND_MAIN_POOL_CONTRACT_ID, limit: String(BLEND_EVENT_LIMIT) },
      budgetAtomic: parseUsd(chip.budgetUsd),
    }))
  } catch (e) {
    return withReceipt(await settleUpstreamError(env, channelContract, voucher, lockId, e))
  }

  if (!paid) {
    await rollbackAndRelease(env, channelContract, voucher, lockId)
    return withReceipt(
      fail(502, 'upstream_unpaid', 'the call did not complete a payment; you were not charged', {
        call_id: id,
        charged_usd: '0.00',
      }),
    )
  }

  const aggregate = aggregateBlendEvents(extractEvents(raw), BLEND_MAIN_POOL_CONTRACT_ID)

  // Narration: bounded, optional, best-effort — mirrors the custodial chip.
  let summary = describeAggregate(aggregate)
  const summaryModel = findModel(BLEND_SUMMARY_MODEL_ID)
  if (summaryModel?.available && aggregate.events_examined > 0) {
    try {
      const nRoute = resolvePlaygroundRoute(summaryModel.routePublicPath, summaryModel.routeMethod)
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

  await releaseChannelDeliveryLock(env, channelContract, lockId).catch(() => {})
  return withReceipt(
    json({
      call_id: id,
      summary,
      events_table: {
        contract_id: aggregate.contract_id,
        events_examined: aggregate.events_examined,
        ledger_range: aggregate.ledger_range,
        rows: aggregate.rows,
      },
      ...pricingFields(priceRaw, costRaw, upstreamCostRaw),
    }),
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
  const { costRaw, priceRaw } = channelPriceForChip(chip)

  let route
  try {
    route = resolvePlaygroundRoute('/v1/services/mercury/txs/by-hash', 'GET')
  } catch (e: any) {
    return fail(e?.status ?? 503, e?.code ?? 'route_unavailable', e?.message ?? 'route unavailable')
  }

  const verify = await verifyChannelVoucher(request, env, priceRaw, id)
  if (verify.kind === 'respond') return verify.response
  const { channelContract, voucher, lockId, withReceipt } = verify

  let result: unknown
  let paid: boolean
  let upstreamCostRaw: string | undefined
  try {
    ;({ value: result, paid, upstreamCostRaw } = await callUpstreamJson(env, {
      route,
      query: { tx_hash: txHash },
      budgetAtomic: parseUsd(chip.budgetUsd),
    }))
  } catch (e) {
    return withReceipt(await settleUpstreamError(env, channelContract, voucher, lockId, e))
  }

  if (!paid) {
    await rollbackAndRelease(env, channelContract, voucher, lockId)
    return withReceipt(
      fail(502, 'upstream_unpaid', 'the call did not complete a payment; you were not charged', {
        call_id: id,
        charged_usd: '0.00',
      }),
    )
  }

  await releaseChannelDeliveryLock(env, channelContract, lockId).catch(() => {})
  return withReceipt(
    json({
      call_id: id,
      tx_hash: txHash,
      transaction: result,
      ...pricingFields(priceRaw, costRaw, upstreamCostRaw),
    }),
  )
}

/**
 * Map an upstream throw to a settled Response. THE ONLY thing that keeps a
 * charge is `paymentEvidence === 'yes'` (a credential was provably signed) —
 * every other outcome rolls the voucher back. This is the exact single source
 * of truth from the custodial `failCall`.
 */
async function settleUpstreamError(
  env: Env,
  channelContract: string,
  voucher: ChannelVoucher,
  lockId: string,
  e: unknown,
): Promise<Response> {
  const upstream = e instanceof UpstreamError ? e : null
  const code = upstream?.code ?? 'upstream_error'
  const status = upstream?.status ?? 502
  const message = upstream?.message ?? 'upstream call failed'
  const shouldCommit = upstream?.paymentEvidence === 'yes'

  if (shouldCommit) {
    // Money moved: leave the voucher cumulative advanced, just release the lock.
    await releaseChannelDeliveryLock(env, channelContract, lockId).catch(() => {})
    return fail(status, code, message, {
      support_note:
        'The upstream provider was paid but did not return a usable result, so this call was charged.',
    })
  }

  const rolledBack = await rollbackAndRelease(env, channelContract, voucher, lockId)
  return fail(status, code, message, {
    charged_usd: '0.00',
    refund_status: rolledBack ? 'voucher-not-consumed' : 'manual-review',
  })
}
