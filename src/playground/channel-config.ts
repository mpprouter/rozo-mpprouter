/**
 * Non-custodial "channel playground" configuration and real-cost pricing.
 *
 * This module is the single source of truth for the channel-mode playground:
 * the feature flag, the on-chain channel parameters the router will accept at
 * register time, and the per-route real-cost pricing used to meter each call.
 *
 * It lives ALONGSIDE the existing custodial playground (src/playground/*.ts,
 * src/routes/playground.ts) and does not touch it. The custodial path is the
 * prepaid-ledger model; this is the Stellar Soroban one-way payment channel
 * model where the router is the payee and the user spends via client-signed
 * cumulative vouchers. See todos/20260813-mpprouter-channel-playground.md.
 *
 * ---------------------------------------------------------------------------
 * Real-cost metering (founder decision, 2026-08-13)
 * ---------------------------------------------------------------------------
 * Price each call by the ACTUAL upstream cost of that route/model, not a flat
 * two-tier bucket. There is one hard constraint imposed by the payment-channel
 * protocol: a voucher is a cumulative authorization the client signs BEFORE
 * the upstream call runs, so the exact live cost of THIS call cannot be known
 * at authorization time. The router therefore:
 *
 *   1. Quotes a deterministic per-route price = knownUpstreamCost(route) +
 *      markup, where knownUpstreamCost is an individual per-model / per-chip
 *      cost (not a coarse tier) and markup = max(10%, $0.001).
 *   2. Issues a 402 for exactly that delta; the client's channel method signs
 *      a voucher advancing the cumulative by exactly that amount. So "the
 *      voucher cumulative advances by exactly the charged amount" holds.
 *   3. Runs the upstream call under the existing budget ceiling, then captures
 *      the amount it ACTUALLY paid upstream from the charge seam
 *      (challenge.request.amount, surfaced via onCredentialSigned) and reports
 *      it. The quote always covers the real cost because the quote already
 *      includes the markup and the router enforces the budget ceiling; if the
 *      captured real cost ever exceeds the quote it is logged for
 *      reconciliation and the router absorbs the (budget-bounded) difference —
 *      it can never charge the user more than the cumulative they signed.
 *   4. Rolls the voucher back entirely on any upstream failure so a failed
 *      call is never billed (reuses rollbackFailedChannelVoucher).
 *
 * The knownUpstreamCost numbers below are the router's best estimate of the
 * real per-call Tempo/indexer cost for each route. They are deliberately
 * conservative and are reconciled against the live captured cost on every
 * call. GET /v1/playground/config advertises the effective price so the UI
 * never carries a checked-in copy that can drift.
 */

import { formatUsd, formatUsdc7, parseUsd } from './amount'
import {
  BLEND_SUMMARY_MODEL_ID,
  CHAT_OUTAGE_REASON,
  chatModelsDisabled,
  PLAYGROUND_CHIPS,
  PLAYGROUND_MODELS,
  TIER_UPSTREAM_BUDGET_USD,
  findModel,
  type PlaygroundChip,
  type PlaygroundModel,
} from './models'

/**
 * refund_waiting_period the router requires every playground channel to be
 * opened with, in ledgers. Matches the value baked into
 * scripts/admin/deploy-stellar-channel-for-agent.ts (100 ledgers ≈ 8–10 min on
 * pubnet). A channel opened with a different period is rejected at register
 * time — a too-short period would not give the router time to settle its
 * latest voucher before the funder can unilaterally refund.
 */
export const CHANNEL_REFUND_WAITING_PERIOD = 100

/**
 * Minimum on-chain balance a channel must actually hold to be registered, in
 * 7-decimal USDC atomic units. A channel with no real deposit is useless and
 * accepting it would let anyone flood KV with empty channels.
 */
export const CHANNEL_MIN_DEPOSIT_USD = '0.1'
export const CHANNEL_MIN_DEPOSIT_RAW = parseUsd(CHANNEL_MIN_DEPOSIT_USD)

/**
 * Deposit cap advertised to the UI, mirroring the custodial MAX_DEPOSIT_USD.
 * Not enforced on-chain (the user funds their own channel with their own XLM
 * for gas); purely a UI guardrail for a demo surface.
 */
export const CHANNEL_MAX_DEPOSIT_USD = '10'

/** Deposit amounts (USD) the frontend offers for opening a channel. */
export const CHANNEL_DEPOSIT_OPTIONS: readonly number[] = [0.5, 1, 2]

/** Stellar mainnet Horizon, used by the frontend to submit open/close txs. */
const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org'

/**
 * Network passphrase the frontend must build the Soroban open tx against.
 * Pubnet unless the router is explicitly on testnet.
 */
export function channelNetworkPassphrase(env: { STELLAR_NETWORK?: string }): string {
  return env.STELLAR_NETWORK === 'stellar:testnet'
    ? 'Test SDF Network ; September 2015'
    : 'Public Global Stellar Network ; September 2015'
}

/** Horizon base URL advertised to the frontend (override via PLAYGROUND_HORIZON_URL). */
export function channelHorizonUrl(env: { PLAYGROUND_HORIZON_URL?: string }): string {
  return env.PLAYGROUND_HORIZON_URL?.trim() || DEFAULT_HORIZON_URL
}

/** Markup applied on top of the MAX possible upstream cost. */
const CHANNEL_MARKUP_BPS = 1000n // 10%
const CHANNEL_MARKUP_MIN_RAW = parseUsd('0.001') // $0.001 floor

/**
 * Add the markup to a base amount. markup = max(10% of base, $0.001). All
 * bigint 7-decimal atomic math — no float ever touches a price.
 */
export function applyMarkup(baseRaw: bigint): bigint {
  const pct = (baseRaw * CHANNEL_MARKUP_BPS) / 10_000n
  const markup = pct > CHANNEL_MARKUP_MIN_RAW ? pct : CHANNEL_MARKUP_MIN_RAW
  return baseRaw + markup
}

export interface ChannelPrice {
  /**
   * The MAXIMUM the router could pay upstream for this call, 7-decimal atomic.
   * This is the enforced budget ceiling (see TIER_UPSTREAM_BUDGET_USD / chip
   * budgetUsd), NOT a point estimate. The voucher quote is built from this so
   * the charged amount ALWAYS covers the real cost — the router can never pay
   * upstream more than the user signed for.
   */
  maxUpstreamRaw: bigint
  /** Effective price charged to the channel (maxUpstream + markup), 7-dec atomic. */
  priceRaw: bigint
}

/**
 * The narration model the Blend chip may additionally call. Its cost must be
 * folded into the Blend quote so a chip that makes TWO paid upstream calls is
 * never under-quoted.
 */
function blendNarrationMaxRaw(): bigint {
  const narrationModel = findModel(BLEND_SUMMARY_MODEL_ID)
  const tier = narrationModel?.tier ?? 'cheap'
  return parseUsd(TIER_UPSTREAM_BUDGET_USD[tier])
}

/**
 * Quote for a chat model = the tier's enforced upstream budget ceiling +
 * markup. Because the metered call passes exactly this ceiling as the upstream
 * budget, actual spend can never exceed it, so the quote can never be
 * under-charged.
 */
/**
 * Founder decision (2026-08-13): every chat model costs the SAME flat price
 * per call — the dropdown must never show per-model / per-tier price spread.
 * The flat price must still cover the worst-case upstream cost of ANY tier,
 * so it is floored at applyMarkup(maxUpstreamRaw): if a future budget bump
 * pushes cost+markup above the flat price, the larger amount wins and the
 * router can never under-charge.
 */
export const CHANNEL_FLAT_MODEL_PRICE_USD = '0.10'

export function channelPriceForModel(model: PlaygroundModel): ChannelPrice {
  const maxUpstreamRaw = parseUsd(TIER_UPSTREAM_BUDGET_USD[model.tier])
  const covered = applyMarkup(maxUpstreamRaw)
  const flat = parseUsd(CHANNEL_FLAT_MODEL_PRICE_USD)
  return { maxUpstreamRaw, priceRaw: flat > covered ? flat : covered }
}

/**
 * Quote for a chip = the chip's upstream budget ceiling (+ the Blend narration
 * ceiling for the blend chip, which makes a second paid call) + markup.
 */
export function channelPriceForChip(chip: PlaygroundChip): ChannelPrice {
  let maxUpstreamRaw = parseUsd(chip.budgetUsd)
  if (chip.id === 'blend-activity') maxUpstreamRaw += blendNarrationMaxRaw()
  return { maxUpstreamRaw, priceRaw: applyMarkup(maxUpstreamRaw) }
}

/**
 * Kill switch for the entire non-custodial channel surface. Every
 * /v1/playground/channel/* route 404s unless this is exactly 'true'. Separate
 * from PLAYGROUND_ENABLED so the two playgrounds can be rolled out and pulled
 * independently during the cutover. Default OFF.
 */
export function channelPlaygroundEnabled(env: {
  PLAYGROUND_CHANNEL_ENABLED?: string
}): boolean {
  return env.PLAYGROUND_CHANNEL_ENABLED === 'true'
}

/**
 * The channel-factory contract address (C...) the frontend calls `open`
 * against. May be empty until the founder deploys the factory on mainnet (an
 * L3 on-chain action). Advertised via /v1/playground/config so the UI can grey
 * the "Open channel" button until it is set.
 */
export function channelFactoryAddress(env: {
  PLAYGROUND_CHANNEL_FACTORY?: string
}): string | null {
  const v = env.PLAYGROUND_CHANNEL_FACTORY?.trim()
  return v && /^C[A-Z2-7]{55}$/.test(v) ? v : null
}

/**
 * The dedicated hot collector account (G...) every playground channel must pay
 * TO (Option A). Kept DISTINCT from STELLAR_ROUTER_PUBLIC (the treasury): the
 * collector holds only spent playground cents and its key is the only one that
 * ever signs a settle/close. Returns null if unset/invalid → register and
 * settlement fail closed.
 */
export function channelCollector(env: { PLAYGROUND_CHANNEL_TO?: string }): string | null {
  const v = env.PLAYGROUND_CHANNEL_TO?.trim()
  return v && /^G[A-Z2-7]{55}$/.test(v) ? v : null
}

/**
 * Our known channel-contract WASM hash (lowercase hex) — the provenance anchor.
 * Null until the founder uploads the channel WASM and sets the var; register
 * MUST fail closed while it is null (an attacker could otherwise register a
 * look-alike contract).
 */
export function channelWasmHash(env: { PLAYGROUND_CHANNEL_WASM_HASH?: string }): string | null {
  const v = env.PLAYGROUND_CHANNEL_WASM_HASH?.trim().toLowerCase()
  return v && /^[0-9a-f]{64}$/.test(v) ? v : null
}

/**
 * The `models` + `chips` blocks for GET /v1/playground/config, annotated with
 * the real-cost effective price so the UI shows honest per-call pricing.
 */
export function channelPricingConfig(env: { PLAYGROUND_CHAT_MODELS_DISABLED?: string } = {}) {
  const chatOutage = chatModelsDisabled(env)
  return {
    models: PLAYGROUND_MODELS.map(m => {
      const { maxUpstreamRaw, priceRaw } = channelPriceForModel(m)
      const available = m.available && !chatOutage
      const reason = !m.available ? m.unavailableReason : chatOutage ? CHAT_OUTAGE_REASON : undefined
      return {
        id: m.id,
        tier: m.tier,
        provider: m.provider,
        max_upstream_cost_usd: formatUsd(maxUpstreamRaw),
        markup_usd: formatUsd(priceRaw - maxUpstreamRaw),
        price_usd: formatUsd(priceRaw),
        available,
        ...(reason ? { unavailable_reason: reason } : {}),
      }
    }),
    chips: PLAYGROUND_CHIPS.map(c => {
      const { maxUpstreamRaw, priceRaw } = channelPriceForChip(c)
      return {
        id: c.id,
        label: c.label,
        max_upstream_cost_usd: formatUsd(maxUpstreamRaw),
        markup_usd: formatUsd(priceRaw - maxUpstreamRaw),
        price_usd: formatUsd(priceRaw),
        description: c.description,
      }
    }),
    pricing: {
      model: 'flat',
      note: `Every chat model costs a flat ${CHANNEL_FLAT_MODEL_PRICE_USD} USD per call regardless of model or message length (floored at worst-case upstream cost + markup so the router never under-charges). Chips are quoted at their own budget ceiling + markup. The voucher cumulative advances by exactly the charged amount; failed calls are rolled back and never billed.`,
    },
  }
}

/** Render a 7-decimal atomic price as the fixed USDC decimal string mppx wants. */
export function priceToChannelAmount(priceRaw: bigint): string {
  return formatUsdc7(priceRaw)
}
