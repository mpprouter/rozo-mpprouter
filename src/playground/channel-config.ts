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
  PLAYGROUND_CHIPS,
  PLAYGROUND_MODELS,
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

/** Markup applied on top of the known upstream cost. */
const CHANNEL_MARKUP_BPS = 1000n // 10%
const CHANNEL_MARKUP_MIN_RAW = parseUsd('0.001') // $0.001 floor

/**
 * Known upstream cost per callable model id, in 7-decimal USDC atomic units.
 * Individual per-model — the whole point of real-cost metering is that a small
 * model is not billed like a flagship one. Conservative estimates, reconciled
 * against the live captured cost on every call (see module header).
 */
const MODEL_UPSTREAM_COST_RAW: Record<string, bigint> = {
  'llama-3.1-8b-instant': parseUsd('0.0004'),
  'deepseek-v4-flash': parseUsd('0.0006'),
  'claude-haiku-4-5': parseUsd('0.004'),
  'gpt-4o-mini': parseUsd('0.002'),
  'claude-opus-5': parseUsd('0.03'),
  'claude-sonnet-5': parseUsd('0.012'),
}

/** Known upstream cost per chip id, in 7-decimal USDC atomic units. */
const CHIP_UPSTREAM_COST_RAW: Record<string, bigint> = {
  'blend-activity': parseUsd('0.02'),
  'tx-decode': parseUsd('0.005'),
}

/**
 * Add the markup to a known upstream cost. markup = max(10% of cost, $0.001).
 * All bigint 7-decimal atomic math — no float ever touches a price.
 */
export function applyMarkup(costRaw: bigint): bigint {
  const pct = (costRaw * CHANNEL_MARKUP_BPS) / 10_000n
  const markup = pct > CHANNEL_MARKUP_MIN_RAW ? pct : CHANNEL_MARKUP_MIN_RAW
  return costRaw + markup
}

export interface ChannelPrice {
  /** Known upstream cost, 7-decimal atomic. */
  costRaw: bigint
  /** Effective price charged to the channel (cost + markup), 7-decimal atomic. */
  priceRaw: bigint
}

/**
 * Effective price for a chat model. Falls back to a safe non-zero default for
 * any allow-listed model that lacks an explicit cost entry, so a new model can
 * never accidentally be served for free.
 */
export function channelPriceForModel(model: PlaygroundModel): ChannelPrice {
  const costRaw = MODEL_UPSTREAM_COST_RAW[model.id] ?? parseUsd('0.01')
  return { costRaw, priceRaw: applyMarkup(costRaw) }
}

/** Effective price for a chip. */
export function channelPriceForChip(chip: PlaygroundChip): ChannelPrice {
  const costRaw = CHIP_UPSTREAM_COST_RAW[chip.id] ?? parseUsd('0.01')
  return { costRaw, priceRaw: applyMarkup(costRaw) }
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
 * The `models` + `chips` blocks for GET /v1/playground/config, annotated with
 * the real-cost effective price so the UI shows honest per-call pricing.
 */
export function channelPricingConfig() {
  return {
    models: PLAYGROUND_MODELS.map(m => {
      const { costRaw, priceRaw } = channelPriceForModel(m)
      return {
        id: m.id,
        tier: m.tier,
        provider: m.provider,
        upstream_cost_usd: formatUsd(costRaw),
        markup_usd: formatUsd(priceRaw - costRaw),
        price_usd: formatUsd(priceRaw),
        available: m.available,
        ...(m.unavailableReason ? { unavailable_reason: m.unavailableReason } : {}),
      }
    }),
    chips: PLAYGROUND_CHIPS.map(c => {
      const { costRaw, priceRaw } = channelPriceForChip(c)
      return {
        id: c.id,
        label: c.label,
        upstream_cost_usd: formatUsd(costRaw),
        markup_usd: formatUsd(priceRaw - costRaw),
        price_usd: formatUsd(priceRaw),
        description: c.description,
      }
    }),
    pricing: {
      model: 'real-cost',
      markup: '10% of upstream cost, minimum $0.001',
      note: 'Each call is priced at the known upstream cost for that route plus markup. The voucher cumulative advances by exactly the charged amount; failed calls are rolled back and never billed.',
    },
  }
}

/** Render a 7-decimal atomic price as the fixed USDC decimal string mppx wants. */
export function priceToChannelAmount(priceRaw: bigint): string {
  return formatUsdc7(priceRaw)
}
