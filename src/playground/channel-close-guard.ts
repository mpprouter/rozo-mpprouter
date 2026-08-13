/**
 * Call-time close-state gate (round-8 TOCTOU fix).
 *
 * A funder can close_start, wait until just before refund eligibility, submit a
 * call (the router pays upstream), then refund and empty the channel before the
 * 2-minute settlement cron can settle — leaving a charge>0 reported against
 * funds that are gone. To stop this, the channel-call path checks the channel's
 * CURRENT close state before paying upstream and refuses to spend on a channel
 * that has entered close_start.
 *
 * Why "closeEffectiveAtLedger is set" is the complete gate: on-chain, refund is
 * only reachable after close_start, which sets closeEffectiveAtLedger, followed
 * by a wait of refund_waiting_period (100 ledgers ≈ 10 min on pubnet). So while
 * closeEffectiveAtLedger is null the channel is provably not refundable for at
 * least ~10 min after any future close_start. Rejecting on ANY set
 * closeEffectiveAtLedger therefore also satisfies the "within a safety margin of
 * refund eligibility" requirement — the whole 100-ledger window is the margin,
 * and it dwarfs the short read-cache TTL and the 2-min cron interval.
 *
 * The read is cached briefly per channel (isolate-local) to avoid an RPC on
 * every call; the TTL is far smaller than the refund window so a just-started
 * close is caught well before any refund could land. Fail-closed: if the close
 * state cannot be read, the call is refused (we never pay upstream on an
 * unverifiable channel).
 */

import { getChannelState } from '@stellar/mpp/channel/server'
import type { Env } from '../index'

/**
 * Conservative safety margin, in ledgers, documented for reasoning. The
 * effective gate rejects on ANY started close (closeEffectiveAtLedger != null),
 * so the full refund_waiting_period (100 ledgers) is the real margin; this
 * constant records the minimum head-room — a couple of ~2-min cron ticks plus
 * settle/RPC latency (~24 ledgers/tick) — that the design guarantees.
 */
export const CLOSE_SAFETY_MARGIN_LEDGERS = 60

/** Isolate-local read cache. Short TTL << the ~600-ledger refund window. */
const CACHE_TTL_MS = 15_000

interface CloseState {
  closeEffectiveAtLedger: number | null
  currentLedger: number
}

const cache = new Map<string, CloseState & { fetchedAt: number }>()

export interface CloseGuardDeps {
  getChannelState: (p: {
    channel: string
    network?: string
    rpcUrl?: string
  }) => Promise<CloseState>
}

const DEFAULT_DEPS: CloseGuardDeps = {
  getChannelState: p => getChannelState(p as any) as any,
}

async function readCloseState(
  env: Env,
  channelContract: string,
  deps: CloseGuardDeps,
): Promise<CloseState> {
  const now = Date.now()
  const cached = cache.get(channelContract)
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached
  const s = await deps.getChannelState({
    channel: channelContract,
    network: env.STELLAR_NETWORK,
    rpcUrl: env.STELLAR_RPC_URL,
  })
  const entry = {
    closeEffectiveAtLedger: s.closeEffectiveAtLedger,
    currentLedger: s.currentLedger,
    fetchedAt: now,
  }
  cache.set(channelContract, entry)
  return entry
}

/** Pure predicate: is this channel closing (or within the refund margin)? */
export function isClosingOrRefundable(
  state: CloseState,
  marginLedgers: number = CLOSE_SAFETY_MARGIN_LEDGERS,
): boolean {
  if (state.closeEffectiveAtLedger == null) return false
  // A started close: reject regardless of remaining ledgers. (The margin check
  // is a strict subset — remaining < margin — and is always caught here.)
  void marginLedgers
  return true
}

/**
 * True if the channel must NOT be spent on (closing/refundable, or the state is
 * unreadable → fail closed). Called before paying upstream.
 */
export async function channelClosingForSpend(
  env: Env,
  channelContract: string,
  deps: CloseGuardDeps = DEFAULT_DEPS,
): Promise<boolean> {
  try {
    const state = await readCloseState(env, channelContract, deps)
    return isClosingOrRefundable(state)
  } catch (e: any) {
    console.error(
      `[channel] close-state read failed for ${channelContract}: ${e?.message}; failing closed`,
    )
    return true
  }
}

/** Drop the cached close state (used by tests). */
export function _clearCloseStateCache(): void {
  cache.clear()
}
