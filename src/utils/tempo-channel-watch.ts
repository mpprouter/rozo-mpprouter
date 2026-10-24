/**
 * Low-deposit watch for the router's Tempo session channels
 * (router -> merchant, KV `tempoChannel:<key>`).
 *
 * Why this exists (2026-10-25): anthropic_messages and openai_chat failed
 * with the merchant's 402 "amount-exceeds-deposit". KV recorded deposits of
 * 1.001 and 2.001 USDC, but the channels on chain held 0.001 USDC each: the
 * top-up in scripts/admin/open-tempo-channel.ts had failed and its error was
 * swallowed, and nothing ever compared KV with the chain. The routes kept
 * working only while the merchant also accepted tempo.charge; once it went
 * session-only, every call failed and the first signal was a paid
 * verification run.
 *
 * So this reads the ON-CHAIN deposit (never the KV figure) and alerts when the
 * headroom left for new vouchers, deposit - max(settled, KV cumulative), drops
 * below a threshold. Same discipline as the gas sponsor and funder watches:
 * transition-only alerts (the cron runs every 2 minutes), an unreadable chain
 * is never reported as "low", and state is committed only after the alert was
 * delivered.
 */

import { Session } from 'mppx/tempo'

/** TIP-1034 escrow precompile. Channels on other escrows are not checked. */
export const TIP1034_ESCROW = '0x4d50500000000000000000000000000000000000'

/** Alert when a channel's voucher headroom is below $0.05 (USDC, 6 decimals). */
export const CHANNEL_LOW_HEADROOM_RAW = 50_000n

/** Sample at most every 15 minutes. */
export const CHANNEL_WATCH_INTERVAL_MS = 15 * 60 * 1000

const STATE_KEY = 'tempo-channel-watch:state'
const LAST_RUN_KEY = 'tempo-channel-watch:last-run'
const CHANNEL_PREFIX = 'tempoChannel:'

export type ChannelHealth = 'ok' | 'low'

export interface ChannelReading {
  key: string
  channelId: string
  depositRaw: bigint
  usedRaw: bigint
  headroomRaw: bigint
}

export interface ChannelOnChainState {
  deposit: bigint
  settled: bigint
}

export interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }>
}

export interface ChannelWatchDeps {
  kv: KvLike
  /** Batch read of on-chain channel states, same order as `channelIds`. */
  readStates: (channelIds: `0x${string}`[]) => Promise<ChannelOnChainState[]>
  now?: Date
}

export interface ChannelWatchResult {
  messages: string[]
  commit: () => Promise<void>
}

export function formatUsdc(raw: bigint): string {
  const neg = raw < 0n
  const abs = neg ? -raw : raw
  const whole = abs / 1_000_000n
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

export function classifyChannel(r: ChannelReading): ChannelHealth {
  return r.headroomRaw < CHANNEL_LOW_HEADROOM_RAW ? 'low' : 'ok'
}

async function listChannelKeys(kv: KvLike): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i++) {
    const page = await kv.list({ prefix: CHANNEL_PREFIX, cursor })
    for (const k of page.keys) out.push(k.name)
    if (page.list_complete || !page.cursor) break
    cursor = page.cursor
  }
  return out
}

/**
 * Decide what to alert this tick. Returns null when gated by the sampling
 * interval or when nothing could be read.
 */
export async function checkTempoChannels(deps: ChannelWatchDeps): Promise<ChannelWatchResult | null> {
  const now = deps.now ?? new Date()
  const lastRun = Number((await deps.kv.get(LAST_RUN_KEY)) ?? '0')
  if (Number.isFinite(lastRun) && now.getTime() - lastRun < CHANNEL_WATCH_INTERVAL_MS) return null

  const entries: Array<{ key: string; channelId: `0x${string}`; cumulative: bigint }> = []
  for (const name of await listChannelKeys(deps.kv)) {
    const raw = await deps.kv.get(name)
    if (!raw) continue
    try {
      const v = JSON.parse(raw) as { channelId?: string; escrowContract?: string; cumulativeRaw?: string }
      if (!v.channelId || !/^0x[0-9a-fA-F]{64}$/.test(v.channelId)) continue
      if ((v.escrowContract ?? '').toLowerCase() !== TIP1034_ESCROW) continue
      const cumulative = /^\d+$/.test(v.cumulativeRaw ?? '') ? BigInt(v.cumulativeRaw as string) : 0n
      entries.push({ key: name.slice(CHANNEL_PREFIX.length), channelId: v.channelId as `0x${string}`, cumulative })
    } catch {
      // A malformed KV entry is the payment path's problem to report; skip.
    }
  }

  const lastRunCommit = () => deps.kv.put(LAST_RUN_KEY, String(now.getTime()))
  if (entries.length === 0) return { messages: [], commit: lastRunCommit }

  let states: ChannelOnChainState[]
  try {
    states = await deps.readStates(entries.map((e) => e.channelId))
  } catch {
    // Unreadable chain: say nothing, try again next tick. Never "low".
    return null
  }
  if (states.length !== entries.length) return null

  let previous: Record<string, ChannelHealth> = {}
  try {
    previous = JSON.parse((await deps.kv.get(STATE_KEY)) ?? '{}') as Record<string, ChannelHealth>
  } catch {
    previous = {}
  }

  const next: Record<string, ChannelHealth> = {}
  const lowLines: string[] = []
  const recoveredLines: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const s = states[i]
    const used = s.settled > e.cumulative ? s.settled : e.cumulative
    const reading: ChannelReading = {
      key: e.key,
      channelId: e.channelId,
      depositRaw: s.deposit,
      usedRaw: used,
      headroomRaw: s.deposit - used,
    }
    const health = classifyChannel(reading)
    next[e.key] = health
    const line =
      `- ${e.key} (${e.channelId.slice(0, 10)}...): on-chain deposit ${formatUsdc(reading.depositRaw)} USDC, ` +
      `used ${formatUsdc(reading.usedRaw)}, headroom ${formatUsdc(reading.headroomRaw)}`
    if (health === 'low' && previous[e.key] !== 'low') lowLines.push(line)
    if (health === 'ok' && previous[e.key] === 'low') recoveredLines.push(line)
  }

  const messages: string[] = []
  if (lowLines.length > 0) {
    messages.push(
      `[MPP Router] Tempo session channel low deposit: ${lowLines.length} channel(s) below ` +
        `${formatUsdc(CHANNEL_LOW_HEADROOM_RAW)} USDC headroom\n` +
        lowLines.join('\n') +
        '\nSession-mode calls to these merchants fail with 402 amount-exceeds-deposit ' +
        '(auto-refunded) until the channel is topped up. Founder action (L3): ' +
        'npx tsx scripts/admin/topup-tempo-channel.ts <key> --amount <USDC>',
    )
  }
  if (recoveredLines.length > 0) {
    messages.push(`[MPP Router] Tempo session channel deposit restored\n${recoveredLines.join('\n')}`)
  }

  return {
    messages,
    commit: async () => {
      await deps.kv.put(STATE_KEY, JSON.stringify(next))
      await lastRunCommit()
    },
  }
}

/** Production reader: the TIP-1034 precompile via the router's Tempo client. */
export function precompileStateReader(client: unknown) {
  return async (channelIds: `0x${string}`[]): Promise<ChannelOnChainState[]> => {
    const states = await Session.Precompile.Chain.getChannelStatesBatch(client as any, channelIds)
    return states.map((s: any) => ({ deposit: BigInt(s.deposit), settled: BigInt(s.settled) }))
  }
}
