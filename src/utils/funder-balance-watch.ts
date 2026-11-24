/**
 * Low-balance and abnormal-drop monitoring for the Base USDC funder wallet.
 *
 * The funder (`FUNDER_WALLET`) pays every Coinbase / coupon / Stripe invoice
 * on the customer's behalf before the payout leg refills it. When it runs dry,
 * redemptions fail with `insufficient funder balance`.
 *
 * Until 2026-09-29 this was watched by a launchd job (ainative
 * `scripts/funder_balance_alert.py`) installed on two laptops. Each machine
 * kept its own dedupe state, so every alert arrived twice, and each machine
 * could be offline. Running it on this Worker's cron gives one sender with one
 * state, and no dependency on a machine being awake. The thresholds below are
 * the ones that script used, so the move changes where the alert comes from,
 * not when it fires.
 *
 * Same two rules as `stellar-gas-balance.ts`:
 *   1. An unreadable balance is never a confident zero; it is its own state.
 *   2. Alerts fire on TRANSITION (or a discrete drop event), never on level —
 *      the cron runs every 2 minutes.
 */

import { getBaseUsdcBalance } from './base-usdc-balance'

const USDC = 1_000_000n

/** P0: one OpenRouter top-up can exhaust it; redemptions may already fail. */
export const FUNDER_P0_THRESHOLD = 50n * USDC
/**
 * P1: time to top up. Founder rule 2026-09-29: while the balance is at or
 * above $200, send nothing at all, including sudden-drop alerts.
 */
export const FUNDER_P1_THRESHOLD = 200n * USDC
/** A drop between two samples counts as abnormal only if it is both >50% ... */
export const DROP_MIN_RATIO_PCT = 50n
/** ... and at least $20, so small balances wobbling do not page anyone. */
export const DROP_MIN_ABS = 20n * USDC

/**
 * Sample every 15 minutes, not every cron tick. The drop rule compares two
 * consecutive samples, so the interval defines what "sudden" means; 15 min is
 * what the launchd job used. It also keeps paid-RPC usage at 96 calls/day.
 */
export const SAMPLE_INTERVAL_MS = 15 * 60 * 1000

/** Consecutive unreadable samples (~1 hour) before we report being blind. */
export const UNREADABLE_ALERT_AFTER = 4

const STATE_KEY = 'funder-balance:watch-state'

export type Band = 'ok' | 'p1' | 'p0'

export interface FunderWatchState {
  /** Last band we actually knew. Never overwritten by an unreadable sample. */
  band: Band | null
  /** Last successfully read balance in USDC base units, as a decimal string. */
  lastBalance: string | null
  /** When the last sample (readable or not) was taken, epoch ms. */
  lastSampleAt: number
  unreadableStreak: number
  unreadableAlerted: boolean
}

const EMPTY_STATE: FunderWatchState = {
  band: null,
  lastBalance: null,
  lastSampleAt: 0,
  unreadableStreak: 0,
  unreadableAlerted: false,
}

/**
 * Thresholds and wording for one watched wallet. The default is the legacy
 * single funder (texts unchanged). Tiered funders (FUNDER_TIERS_ENABLED) get
 * their own profile and their own KV state (FUNDER_TIER_WATCH_PROFILES).
 */
export interface WatchProfile {
  p0: bigint
  p1: bigint
  /** Message prefix, e.g. "Funder" or "Funder T1". */
  label: string
}

export const DEFAULT_WATCH_PROFILE: WatchProfile = {
  p0: FUNDER_P0_THRESHOLD,
  p1: FUNDER_P1_THRESHOLD,
  label: 'Funder',
}

/**
 * Per-tier thresholds (proposed, agent-set, change freely). T1 holds at most
 * 50 USDC and is topped up by hand when it drops below 10 (design 2026-11-24);
 * T2 holds at most 200; T3A / T3B use the legacy bands.
 */
export const FUNDER_TIER_WATCH_PROFILES: Record<'T1' | 'T2' | 'T3A' | 'T3B', WatchProfile> = {
  T1: { p0: 10n * USDC, p1: 20n * USDC, label: 'Funder T1 (x402)' },
  T2: { p0: 50n * USDC, p1: 100n * USDC, label: 'Funder T2 (Coinbase < $200)' },
  T3A: { p0: FUNDER_P0_THRESHOLD, p1: FUNDER_P1_THRESHOLD, label: 'Funder T3A (Coinbase >= $200)' },
  T3B: { p0: FUNDER_P0_THRESHOLD, p1: FUNDER_P1_THRESHOLD, label: 'Funder T3B (Stripe / Bitrefill)' },
}

/** KV key of the watch state: legacy key for the legacy funder, one per tier otherwise. */
export function watchStateKey(tier?: string): string {
  return tier ? `${STATE_KEY}:${tier}` : STATE_KEY
}

export function classifyBand(balance: bigint, profile: WatchProfile = DEFAULT_WATCH_PROFILE): Band {
  if (balance < profile.p0) return 'p0'
  if (balance < profile.p1) return 'p1'
  return 'ok'
}

/** "$1,234.56" from base units, truncating (never rounding up) the cents. */
export function formatUsd(units: bigint): string {
  const neg = units < 0n
  const abs = neg ? -units : units
  const dollars = (abs / USDC).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cents = ((abs % USDC) / 10_000n).toString().padStart(2, '0')
  return `${neg ? '-' : ''}$${dollars}.${cents}`
}

export interface WatchDecision {
  messages: string[]
  nextState: FunderWatchState
}

function bandLabel(band: Band, profile: WatchProfile): string {
  if (band === 'ok') return 'OK'
  return band === 'p1' ? `P1 (< ${formatUsd(profile.p1)})` : `P0 (< ${formatUsd(profile.p0)})`
}

/**
 * Pure decision for one sample. `balance` null means every RPC failed.
 */
export function decide(
  previous: FunderWatchState,
  balance: bigint | null,
  address: string,
  now: number,
  rpcSummary = '',
  profile: WatchProfile = DEFAULT_WATCH_PROFILE,
): WatchDecision {
  const label = profile.label
  if (balance === null) {
    const streak = previous.unreadableStreak + 1
    const alert = streak >= UNREADABLE_ALERT_AFTER && !previous.unreadableAlerted
    return {
      messages: alert
        ? [
            `[MPP Router] ❓ ${label} balance unreadable for ${streak} consecutive checks\n` +
              `Wallet: ${address} (Base USDC)\n` +
              `This is NOT a low-balance report; the balance is unknown. Low balance cannot be detected until reads recover.\n` +
              (rpcSummary ? `RPCs: ${rpcSummary}` : ''),
          ]
        : [],
      nextState: {
        ...previous,
        lastSampleAt: now,
        unreadableStreak: streak,
        unreadableAlerted: previous.unreadableAlerted || alert,
      },
    }
  }

  const band = classifyBand(balance, profile)
  const messages: string[] = []
  const current = formatUsd(balance)

  // Founder rule: nothing at all while the balance is $200+. So no "online"
  // message on a healthy first sample and no "recovered" message on returning
  // to OK; only moves into (or between) the low bands are announced.
  if (band !== 'ok' && band !== previous.band) {
    const worse = previous.band === null || previous.band === 'ok' || band === 'p0'
    messages.push(
      worse
        ? `[MPP Router] ${band === 'p0' ? '🚨' : '⚠️'} ${label} balance ${bandLabel(band, profile)}: ${current}\n` +
            `Wallet: ${address} (Base USDC)\n` +
            (band === 'p0'
              ? `Impact: coupon / Coinbase / Stripe payments may already fail with insufficient funder balance.\n`
              : `Impact: top up soon; below ${formatUsd(profile.p0)} payments start failing.\n`) +
            `Action needed: send Base USDC to the wallet above.`
        : `[MPP Router] ${label} balance improved to ${bandLabel(band, profile)}: ${current}\n` +
            `Wallet: ${address} (Base USDC)`,
    )
  }

  // The drop rule only compares two consecutive readable samples taken about
  // one interval apart. After an RPC outage or a cron gap the last good
  // reading can be hours old, and ordinary spend over that span would look
  // like a sudden drop.
  const elapsed = now - previous.lastSampleAt
  if (previous.lastBalance !== null && previous.unreadableStreak === 0 && elapsed <= 2 * SAMPLE_INTERVAL_MS) {
    const prev = BigInt(previous.lastBalance)
    const drop = prev - balance
    // Quiet above the P1 line (founder rule): a big payment that still leaves
    // $200+ on hand is not worth a message.
    if (balance < profile.p1 && prev > 0n && drop >= DROP_MIN_ABS && drop * 100n > prev * DROP_MIN_RATIO_PCT) {
      messages.push(
        `[MPP Router] ⚠️ ${label} balance dropped sharply: ${formatUsd(prev)} → ${current} ` +
          `(-${formatUsd(drop)}, -${(drop * 100n) / prev}%) in ${Math.round(elapsed / 60_000)} min\n` +
          `Wallet: ${address} (Base USDC)\n` +
          `Check whether this is a normal large payment or an unexpected withdrawal.`,
      )
    }
  }

  return {
    messages,
    nextState: {
      band,
      lastBalance: balance.toString(),
      lastSampleAt: now,
      unreadableStreak: 0,
      unreadableAlerted: false,
    },
  }
}

export async function readWatchState(kv: KVNamespace, stateKey: string = STATE_KEY): Promise<FunderWatchState> {
  const raw = await kv.get(stateKey)
  if (!raw) return { ...EMPTY_STATE }
  try {
    const p = JSON.parse(raw) as Partial<FunderWatchState>
    return {
      band: p.band === 'ok' || p.band === 'p1' || p.band === 'p0' ? p.band : null,
      lastBalance: typeof p.lastBalance === 'string' && /^\d+$/.test(p.lastBalance) ? p.lastBalance : null,
      lastSampleAt: typeof p.lastSampleAt === 'number' && Number.isFinite(p.lastSampleAt) ? p.lastSampleAt : 0,
      unreadableStreak: Number.isInteger(p.unreadableStreak) ? (p.unreadableStreak as number) : 0,
      unreadableAlerted: p.unreadableAlerted === true,
    }
  } catch {
    return { ...EMPTY_STATE }
  }
}

/**
 * One cron tick. Returns null when it is not time to sample or nothing is due;
 * otherwise the messages plus a `commit()` the caller invokes after sending
 * (at-least-once delivery, same reasoning as `checkGasSponsor`).
 */
export async function checkFunderBalance(args: {
  kv: KVNamespace
  address: string
  rpcUrl?: string
  now?: number
  readBalance?: typeof getBaseUsdcBalance
  /** Tiered funders only: own KV state + thresholds. Default = legacy funder. */
  stateKey?: string
  profile?: WatchProfile
}): Promise<{ messages: string[]; commit: () => Promise<void> } | null> {
  const now = args.now ?? Date.now()
  const stateKey = args.stateKey ?? STATE_KEY
  const previous = await readWatchState(args.kv, stateKey)
  if (now - previous.lastSampleAt < SAMPLE_INTERVAL_MS) return null

  const read = await (args.readBalance ?? getBaseUsdcBalance)(args.address, args.rpcUrl)
  const rpcSummary = read.rpcsTried.map((r) => `${r.url} ${r.ok ? 'ok' : r.reason ?? 'failed'}`).join('; ')
  const decision = decide(previous, read.balance, args.address, now, rpcSummary, args.profile ?? DEFAULT_WATCH_PROFILE)
  const commit = () => args.kv.put(stateKey, JSON.stringify(decision.nextState))

  if (decision.messages.length === 0) {
    await commit()
    return null
  }
  return { messages: decision.messages, commit }
}
