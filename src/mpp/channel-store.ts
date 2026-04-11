/**
 * Tempo channel state store — thin KV helpers.
 *
 * V1 scope: one channel per merchant, no locks, no cache, no
 * history. We persist exactly enough to rebuild the Tempo client's
 * voucher context on a cold start of the Cloudflare Worker.
 *
 * Why no in-memory cache: Cloudflare Workers spin isolates up and
 * down unpredictably, so any per-isolate cache would either be
 * stale on the next invocation or force us to deal with cache
 * invalidation races. KV is cheap enough (single read + single
 * write per paid request) that the simpler design wins.
 *
 * Why no fail-closed logic in `get()`: mppx's tempo.session server
 * code rejects a stale cumulative voucher at the merchant on sign
 * verification — we propagate that failure rather than trying to
 * re-implement voucher freshness checks here.
 */

import type { Env } from '../index'

/**
 * A single Tempo payment channel the Router has opened against
 * one upstream merchant. The shape mirrors what mppx's
 * `tempo.session()` manual-mode context expects for the `voucher`
 * action, plus the metadata the operator scripts need to inspect
 * channels without having to replay the on-chain open transaction.
 */
export type TempoChannelState = {
  /** Opaque channel id assigned by the Tempo escrow contract at open. */
  channelId: `0x${string}`
  /** Address of the escrow contract holding the channel's deposit. */
  escrowContract: `0x${string}`
  /** Merchant (payee) address — where vouchers settle to. */
  payee: `0x${string}`
  /** Token contract (e.g. Tempo USDC) used for this channel. */
  currency: `0x${string}`
  /** EVM chain id (Tempo L2). */
  chainId: number
  /**
   * EVM address of the signer the Router uses to sign vouchers for
   * this channel. Normally equals the Router's Tempo wallet derived
   * from TEMPO_ROUTER_PRIVATE_KEY.
   */
  authorizedSigner: `0x${string}`
  /**
   * Cumulative voucher amount in TOKEN BASE UNITS as a decimal
   * string (not hex, not scientific). Monotone: never decreases.
   * Every successful upstream 2xx response bumps this by the
   * merchant's 402 amount.
   *
   * Stored as a string because JavaScript `number` cannot hold
   * arbitrary-precision integers and JSON cannot round-trip bigint.
   */
  cumulativeRaw: string
  /**
   * Total deposit locked into the channel at open, in the same
   * token base units. When `cumulativeRaw` reaches `depositRaw`
   * the channel is drained and must be closed and re-opened.
   * Operator scripts read this to compute remaining balance.
   */
  depositRaw: string
  /** ISO-8601 timestamp at channel open. */
  openedAt: string
  /**
   * ISO-8601 timestamp of the most recent cumulative bump. Purely
   * informational — used by inspect-channels to show the operator
   * when the channel was last touched. Not read by the hot path.
   */
  lastVoucherAt?: string
}

/**
 * KV key layout:
 *   tempoChannel:<merchantId>  → JSON-encoded TempoChannelState
 *
 * `merchantId` is the same string used as the route's `id` field
 * in `src/services/merchants.ts`, e.g. `"openrouter"`. Keeping
 * these in lockstep is the operator's job — there is no foreign
 * key enforcement in KV.
 */
const KEY_PREFIX = 'tempoChannel:'

function key(merchantId: string): string {
  return `${KEY_PREFIX}${merchantId}`
}

/**
 * Read the current channel state for a merchant. Returns `null`
 * if no channel has been opened yet — callers must treat this as
 * "session path unavailable, fall back or fail loudly".
 */
export async function getTempoChannel(
  env: Env,
  merchantId: string,
): Promise<TempoChannelState | null> {
  const raw = await env.MPP_STORE.get(key(merchantId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as TempoChannelState
  } catch {
    // Corrupt or hand-edited value. Treat as "no channel" — the
    // operator will have to reopen. Swallowing this rather than
    // throwing keeps a single bad KV entry from breaking the
    // charge-mode routes that share the Worker.
    return null
  }
}

/**
 * Overwrite the full channel state for a merchant. Used by
 * `scripts/open-channel.ts` at channel open and by
 * `scripts/inspect-channels.ts` when the operator needs to
 * hand-edit state in response to a recovery scenario.
 *
 * This is a blind put — it does NOT preserve existing
 * `cumulativeRaw`. If you want to advance the watermark from
 * the hot path, use `bumpCumulative` instead.
 */
export async function putTempoChannel(
  env: Env,
  merchantId: string,
  state: TempoChannelState,
): Promise<void> {
  await env.MPP_STORE.put(key(merchantId), JSON.stringify(state))
}

/**
 * List every merchant that currently has a Tempo channel
 * installed. Used by `scripts/inspect-channels.ts`; not called
 * from the hot path.
 *
 * KV's list() is eventually consistent across data centers, so
 * two operator runs within a few seconds may see slightly
 * different results after a put. That's fine for an inspection
 * tool.
 */
export async function listTempoChannels(
  env: Env,
): Promise<Array<{ merchantId: string; state: TempoChannelState }>> {
  const out: Array<{ merchantId: string; state: TempoChannelState }> = []
  let cursor: string | undefined
  do {
    const page = await env.MPP_STORE.list({ prefix: KEY_PREFIX, cursor })
    for (const k of page.keys) {
      const merchantId = k.name.slice(KEY_PREFIX.length)
      const state = await getTempoChannel(env, merchantId)
      if (state) out.push({ merchantId, state })
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return out
}

/**
 * Monotone cumulative update. Called from the session path's
 * `onChannelUpdate` callback after a 2xx upstream response.
 *
 * Contract: `stored.cumulativeRaw = max(stored, incoming)`. If
 * `incoming` is lower than `stored` we silently drop the write —
 * that can only happen if two in-flight requests race and the
 * slower one lands second with stale data. The larger value is
 * the correct watermark; we never rewind.
 *
 * Uses BigInt for the comparison so amounts can exceed 2^53.
 *
 * Race window: Cloudflare KV is eventually consistent across
 * colos, so two concurrent bumps CAN both read the same old
 * value and write the same new value without last-writer-wins
 * detecting the collision. In practice mppx's tempo.session
 * server code rejects a non-strictly-monotonic voucher at the
 * merchant, so a lost bump becomes a lost request (HTTP error)
 * rather than a silent double-spend. We trade that narrow
 * failure mode for the simplicity of no locks.
 */
export async function bumpCumulative(
  env: Env,
  merchantId: string,
  newCumulativeRaw: string,
): Promise<void> {
  if (!/^\d+$/.test(newCumulativeRaw)) {
    throw new Error(
      `bumpCumulative: cumulative must be non-negative integer string, got ${newCumulativeRaw}`,
    )
  }
  const current = await getTempoChannel(env, merchantId)
  if (!current) {
    // No channel means no session to bump. This should never
    // happen in practice — callers read the channel before
    // signing a voucher — but we refuse rather than silently
    // installing a partial record.
    throw new Error(`bumpCumulative: no channel for merchant ${merchantId}`)
  }
  const stored = BigInt(current.cumulativeRaw)
  const incoming = BigInt(newCumulativeRaw)
  if (incoming <= stored) return
  const next: TempoChannelState = {
    ...current,
    cumulativeRaw: incoming.toString(),
    lastVoucherAt: new Date().toISOString(),
  }
  await env.MPP_STORE.put(key(merchantId), JSON.stringify(next))
}
