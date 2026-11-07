/**
 * Pre-payment check for routes the merchant serves through a Tempo session.
 *
 * A session call spends channel deposit, not the wallet's balance, and only
 * works when the channel holds the token the merchant quotes. Both are checked
 * here because a refusal now costs the buyer nothing, while a failure after the
 * buyer has paid needs a refund.
 *
 * Reads the chain on every call. An unreadable channel is refused: this path
 * exists to stop a payment we cannot honour, so "unknown" cannot pass.
 */
import { Session } from 'mppx/tempo'

import type { Env } from '../index'
import { getTempoChannel } from './channel-store'
import type { TempoChannelState } from './channel-store'
import { getTempoClient } from './tempo-rpc'

/**
 * Concurrent requests read the same headroom, and the KV watermark can lag, so
 * require room for two calls of this size rather than one. A voucher past the
 * deposit is still refused unsigned in nextSessionCumulative.
 */
export const SESSION_HEADROOM_SAFETY_FACTOR = 2n

export type SessionPreflightFailure =
  | 'channel_not_installed'
  | 'currency_mismatch'
  | 'read_failed'
  | 'channel_closing'
  | 'insufficient_headroom'

export type SessionPreflightResult = { ok: true } | { ok: false; reason: SessionPreflightFailure }

export interface ChannelChainState {
  deposit: bigint
  settled: bigint
  closeRequestedAt: bigint
}

export function evaluateSessionPreflight(
  channel: Pick<TempoChannelState, 'currency' | 'cumulativeRaw'>,
  challengeCurrency: string,
  quoteRaw: bigint,
  state: ChannelChainState,
): SessionPreflightResult {
  if (channel.currency?.toLowerCase() !== challengeCurrency.toLowerCase()) {
    return { ok: false, reason: 'currency_mismatch' }
  }
  if (state.closeRequestedAt !== 0n) return { ok: false, reason: 'channel_closing' }
  const cumulative = BigInt(channel.cumulativeRaw)
  const used = cumulative > state.settled ? cumulative : state.settled
  const headroom = state.deposit - used
  if (headroom < quoteRaw * SESSION_HEADROOM_SAFETY_FACTOR) {
    return { ok: false, reason: 'insufficient_headroom' }
  }
  return { ok: true }
}

export async function checkSessionPreflight(
  env: Env,
  channelKey: string,
  challengeCurrency: string,
  quoteRaw: bigint,
  readState: (channelId: `0x${string}`) => Promise<ChannelChainState> = (channelId) =>
    readChannelState(env, channelId),
): Promise<SessionPreflightResult> {
  const channel = await getTempoChannel(env, channelKey)
  if (!channel) return { ok: false, reason: 'channel_not_installed' }
  try {
    const state = await readState(channel.channelId as `0x${string}`)
    return evaluateSessionPreflight(channel, challengeCurrency, quoteRaw, state)
  } catch (err) {
    console.warn(`[proxy] session preflight read failed for ${channelKey}: ${(err as Error).name}`)
    return { ok: false, reason: 'read_failed' }
  }
}

async function readChannelState(env: Env, channelId: `0x${string}`): Promise<ChannelChainState> {
  const client = getTempoClient(env.TEMPO_RPC_URL, env.TEMPO_RPC_URL_PRIMARY)
  const state = await Session.Precompile.Chain.getChannelState(client as any, channelId)
  return {
    deposit: BigInt(state.deposit),
    settled: BigInt(state.settled),
    closeRequestedAt: BigInt(state.closeRequestedAt),
  }
}
