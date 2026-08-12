/**
 * Playground configuration: the model allow-list, the chip catalog, and the
 * deposit options. This module is the single source of truth for all three —
 * `GET /v1/playground/config` serialises it verbatim so the frontend never
 * carries a checked-in copy that can drift.
 *
 * ---------------------------------------------------------------------------
 * Why an allow-list at all
 * ---------------------------------------------------------------------------
 * The playground pays upstream merchants out of the router's own pool. A user
 * with a $1 prepaid session must never be able to name an arbitrary model, an
 * arbitrary route, or an arbitrary token budget — the router's exposure per
 * call has to be a backend-owned constant. So: a fixed model id list, a fixed
 * upstream route per model, a forced `max_tokens`, and a flat playground price
 * per tier that the caller cannot influence.
 *
 * ---------------------------------------------------------------------------
 * Payment modes, and what is callable (2026-08-13)
 * ---------------------------------------------------------------------------
 * The playground reaches upstreams through two seams, both already used by the
 * paid proxy and both reused verbatim (see `./upstream.ts`):
 *
 *   - `payMerchant()`        — `tempo.charge`. Groq, DeepSeek.
 *   - `payMerchantSession()` — `tempo.session`. OpenAI, Anthropic. Signs a
 *     cumulative voucher against a Tempo channel pre-opened by
 *     `scripts/admin/open-tempo-channel.ts`.
 *
 * Both flagship providers resolve to session mode:
 *
 *   - `openai_chat` — `OPERATOR_OVERLAY['openai::/v1/chat/completions']` pins
 *     `upstreamPaymentMethod: 'tempo.session'` explicitly (merchants.ts).
 *   - `anthropic_chat_completions` — the overlay sets no explicit method, so
 *     `pickUpstreamPaymentMethod()` (build-routes.ts) derives it from the
 *     catalog snapshot, where the `anthropic` service advertises
 *     `methods.tempo.intents = ["session"]` and nothing else. Note the overlay
 *     ALSO carries `verifiedMode: 'charge'` — that field is a verification
 *     label, not a payment mode, and the two disagree. Flagged to the operator;
 *     the derived session mode is what actually runs.
 *
 * ---------------------------------------------------------------------------
 * Which model ids are pinned, and on what evidence
 * ---------------------------------------------------------------------------
 * Anthropic: `merchants.ts`'s `verifiedNote` for `anthropic_chat_completions`
 * records real paid calls on 2026-08-09 returning 202 + a completion for six
 * current model ids, including `claude-opus-5`, `claude-sonnet-5` and
 * `claude-haiku-4-5`. Those three are pinned here. Retired 2024-era ids 404 at
 * the merchant, so an id must come from that verified list, never from memory.
 *
 * OpenAI: the ONLY concretely evidenced model id for the `openai_chat` route
 * anywhere in this repo is `gpt-4o-mini`, and it appears three times
 * independently — `scripts/admin/open-tempo-channel.ts` (the channel-open
 * probe body), `scripts/e2e/providers.mjs`, and `scripts/e2e/monitor-verified.mjs`.
 * `docs/verified-runs.json` records `session_verified_at` for `openai_chat` but
 * its `runs` array is empty, so it names no model. `gpt-4o-mini` is a small
 * model, not a flagship one, so it is pinned in the CHEAP tier at $0.02 — tier
 * follows the model, not the provider, and billing a mini model at the flagship
 * $0.10 would overcharge for it.
 *
 * No flagship OpenAI model id has ever been recorded as verified through this
 * router, so the flagship OpenAI slot stays `available: false`. It is NOT
 * guessed at: an unverified id would 404 at the merchant AFTER the router had
 * already paid for the call. (An earlier revision of this file carried an
 * invented `gpt-5.2` id with no verification behind it; it has been removed.)
 *
 * ---------------------------------------------------------------------------
 * Unavailable entries are advertised, not hidden
 * ---------------------------------------------------------------------------
 * Models we cannot call are still listed, with `available: false` and a reason,
 * so the UI greys them honestly instead of pretending they don't exist.
 * `assertModelCallable()` rejects them, so an unavailable model can never reach
 * a payment seam even if the frontend ignores the flag.
 *
 * A session-mode model can also fail at CALL time if the operator never opened
 * a channel for its route — `scripts/admin/open-tempo-channel.ts` provisions
 * `anthropic_messages` and `openai_chat`, but not `anthropic_chat_completions`.
 * That surfaces as a 503 `session_channel_not_installed` with the reservation
 * released, never as a silent charge.
 */

import { parseUsd } from './amount'

export type ModelTier = 'cheap' | 'flagship'

export interface PlaygroundModel {
  /** Caller-facing model id, sent verbatim to the upstream as `model`. */
  id: string
  tier: ModelTier
  /** Upstream service (informational; matches the catalog `service` field). */
  provider: string
  /** Public router path of the upstream route used to serve this model. */
  routePublicPath: string
  /** HTTP method of that route. */
  routeMethod: 'POST' | 'GET'
  /**
   * False when the upstream route's payment mode is one the playground's
   * charge seam cannot satisfy. `unavailableReason` explains it to the UI.
   */
  available: boolean
  unavailableReason?: string
}

/** Flat playground price charged to the user, per chat message, by tier. */
export const TIER_PRICE_USD: Record<ModelTier, string> = {
  cheap: '0.02',
  flagship: '0.10',
}

/**
 * Server-forced completion length. Not caller-controllable: token count is the
 * only meaningful lever on what the router pays the upstream, and the flat
 * per-message playground price only stays profitable if that lever is ours.
 */
export const FORCED_MAX_TOKENS = 800

/** Hard cap on how many messages a playground chat turn may carry. */
export const MAX_MESSAGES_PER_TURN = 12

/** Hard cap on total characters across all messages in a turn. */
export const MAX_MESSAGE_CHARS = 8_000

export const PLAYGROUND_MODELS: readonly PlaygroundModel[] = [
  // ---- cheap tier: both charge-verified, both actually callable ----
  {
    id: 'llama-3.1-8b-instant',
    tier: 'cheap',
    provider: 'groq',
    routePublicPath: '/v1/services/groq/chat',
    routeMethod: 'POST',
    available: true,
  },
  {
    id: 'deepseek-v4-flash',
    tier: 'cheap',
    provider: 'deepseek',
    routePublicPath: '/v1/services/deepseek/chat',
    routeMethod: 'POST',
    available: true,
  },
  {
    // Verified 2026-08-09 alongside the flagship Claude ids (merchants.ts
    // verifiedNote). Session-mode upstream, paid via payMerchantSession.
    id: 'claude-haiku-4-5',
    tier: 'cheap',
    provider: 'anthropic',
    routePublicPath: '/v1/services/anthropic/chat_completions',
    routeMethod: 'POST',
    available: true,
  },
  {
    // The only OpenAI model id evidenced anywhere in this repo for the
    // openai_chat route — channel-open probe + both E2E scripts. A small
    // model, so it is priced in the cheap tier, not flagship.
    id: 'gpt-4o-mini',
    tier: 'cheap',
    provider: 'openai',
    routePublicPath: '/v1/services/openai/chat',
    routeMethod: 'POST',
    available: true,
  },

  // ---- flagship tier ----
  {
    // Verified with a real paid call 2026-08-09 (202 + completion).
    id: 'claude-opus-5',
    tier: 'flagship',
    provider: 'anthropic',
    routePublicPath: '/v1/services/anthropic/chat_completions',
    routeMethod: 'POST',
    available: true,
  },
  {
    // Verified with a real paid call 2026-08-09 (202 + completion).
    id: 'claude-sonnet-5',
    tier: 'flagship',
    provider: 'anthropic',
    routePublicPath: '/v1/services/anthropic/chat_completions',
    routeMethod: 'POST',
    available: true,
  },
  {
    // Placeholder id, NOT a callable model. No flagship OpenAI model has ever
    // been verified through this router: verified-runs.json records a session
    // verification for openai_chat but names no model, and every concrete id
    // in the repo is gpt-4o-mini. Pinning a guessed flagship id here would
    // 404 at the merchant AFTER the router paid for the call. Replace this
    // entry with a real id only once a paid run records one.
    id: 'openai-flagship-pending-verification',
    tier: 'flagship',
    provider: 'openai',
    routePublicPath: '/v1/services/openai/chat',
    routeMethod: 'POST',
    available: false,
    unavailableReason:
      'No flagship OpenAI model id has been verified through this router yet. gpt-4o-mini (cheap tier) is the only evidenced OpenAI model.',
  },
] as const

/** Model used for the optional one-line narrative in the Blend chip. */
export const BLEND_SUMMARY_MODEL_ID = 'llama-3.1-8b-instant'

export function findModel(id: string): PlaygroundModel | undefined {
  return PLAYGROUND_MODELS.find(m => m.id === id)
}

export class ModelNotAllowedError extends Error {
  readonly code: 'model_not_allowed' | 'model_unavailable'
  readonly modelId: string
  constructor(code: 'model_not_allowed' | 'model_unavailable', modelId: string, message: string) {
    super(message)
    this.name = 'ModelNotAllowedError'
    this.code = code
    this.modelId = modelId
  }
}

/**
 * Resolve a caller-supplied model id to an allow-listed, currently-callable
 * model. Throws `ModelNotAllowedError` otherwise — distinguishing "never heard
 * of it" from "known but not callable right now", because the UI wants to say
 * different things about those two.
 */
export function assertModelCallable(id: unknown): PlaygroundModel {
  if (typeof id !== 'string' || id.length === 0) {
    throw new ModelNotAllowedError('model_not_allowed', String(id), 'model is required')
  }
  const model = findModel(id)
  if (!model) {
    throw new ModelNotAllowedError(
      'model_not_allowed',
      id,
      `model ${JSON.stringify(id)} is not in the playground allow-list`,
    )
  }
  if (!model.available) {
    throw new ModelNotAllowedError(
      'model_unavailable',
      id,
      model.unavailableReason ?? `model ${id} is temporarily unavailable`,
    )
  }
  return model
}

/** Chip = one pre-built playground use case with a flat user-facing price. */
export interface PlaygroundChip {
  id: string
  label: string
  /** Flat price charged to the user's session balance, USD decimal string. */
  priceUsd: string
  /**
   * Ceiling on what the router may spend upstream serving this chip. Reserved
   * against the router's own exposure, not the user's balance.
   */
  budgetUsd: string
  description: string
}

export const PLAYGROUND_CHIPS: readonly PlaygroundChip[] = [
  {
    id: 'chat',
    label: 'Ask an AI',
    // Display price only; the real charge is TIER_PRICE_USD[model.tier].
    priceUsd: TIER_PRICE_USD.cheap,
    budgetUsd: '0.10',
    description: 'One chat turn against a charge-verified model. Priced per tier.',
  },
  {
    id: 'blend-activity',
    label: 'Blend activity',
    priceUsd: '0.03',
    budgetUsd: '0.05',
    description:
      'Reads recent Blend pool events from the Mercury indexer, aggregates them deterministically, and summarises them in one line.',
  },
  {
    id: 'tx-decode',
    label: 'Decode a tx',
    priceUsd: '0.005',
    budgetUsd: '0.01',
    description: 'Fetches and structures a Stellar transaction by hash via the Mercury indexer.',
  },
] as const

export function findChip(id: string): PlaygroundChip | undefined {
  return PLAYGROUND_CHIPS.find(c => c.id === id)
}

/**
 * The only deposit amounts the intent endpoint will quote. Fixed choices
 * rather than a caller-supplied amount: the deposit amount is half of the
 * on-chain match in `session/open`, and a free-form amount would let a caller
 * mint an intent that matches a payment they were going to make anyway.
 */
export const DEPOSIT_OPTIONS_USD: readonly string[] = ['0.1', '1'] as const

export function isDepositOption(amountUsd: string): boolean {
  // Compare numerically-as-atomic so "1", "1.0" and "1.00" all match.
  let wanted: bigint
  try {
    wanted = parseUsd(amountUsd)
  } catch {
    return false
  }
  return DEPOSIT_OPTIONS_USD.some(opt => parseUsd(opt) === wanted)
}

/** Per-account deposit ceiling per UTC day. */
export const DEPOSIT_CAP_PER_ACCOUNT_PER_DAY_USD = '10'

/** Default global outstanding-credit ceiling; overridable via env. */
export const DEFAULT_GLOBAL_CAP_USD = '200'

/** Intents an account may create per UTC hour. Fail-closed on error. */
export const INTENT_RATE_PER_HOUR = 6

/** Session token lifetime. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

/** Deposit intent lifetime — long enough to sign in a wallet, short enough to bound the open-intent set. */
export const INTENT_TTL_SECONDS = 30 * 60

/** How many recent calls `GET /v1/playground/session` returns. */
export const CALL_HISTORY_LIMIT = 20
