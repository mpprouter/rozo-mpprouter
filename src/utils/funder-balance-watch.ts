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
/** P1: the payout refill is not keeping up with spend. */
export const FUNDER_P1_THRESHOLD = 100n * USDC
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

export function classifyBand(balance: bigint): Band {
  if (balance < FUNDER_P0_THRESHOLD) return 'p0'
  if (balance < FUNDER_P1_THRESHOLD) return 'p1'
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

const BAND_LABEL: Record<Band, string> = {
  ok: 'OK',
  p1: `P1 (< ${formatUsd(FUNDER_P1_THRESHOLD)})`,
  p0: `P0 (< ${formatUsd(FUNDER_P0_THRESHOLD)})`,
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
): WatchDecision {
  if (balance === null) {
    const streak = previous.unreadableStreak + 1
    const alert = streak >= UNREADABLE_ALERT_AFTER && !previous.unreadableAlerted
    return {
      messages: alert
        ? [
            `[MPP Router] ❓ Funder balance unreadable for ${streak} consecutive checks\n` +
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

  const band = classifyBand(balance)
  const messages: string[] = []
  const current = formatUsd(balance)

  if (previous.band === null) {
    // First ever sample. Say we are live even when healthy: it is the one
    // message that proves the delivery path works end to end.
    messages.push(
      `[MPP Router] ✅ Funder balance monitor online: ${current}\n` +
        `Wallet: ${address} (Base USDC)\n` +
        `Alerts: below ${formatUsd(FUNDER_P1_THRESHOLD)} (P1), below ${formatUsd(FUNDER_P0_THRESHOLD)} (P0), ` +
        `or a drop of more than ${DROP_MIN_RATIO_PCT}% and at least ${formatUsd(DROP_MIN_ABS)} within ~15 min.` +
        (band === 'ok' ? '' : `\nCurrently ${BAND_LABEL[band]}: top up the wallet above.`),
    )
  } else if (band !== previous.band) {
    const worse = band === 'p0' || (band === 'p1' && previous.band === 'ok')
    messages.push(
      worse
        ? `[MPP Router] ${band === 'p0' ? '🚨' : '⚠️'} Funder balance ${BAND_LABEL[band]}: ${current}\n` +
            `Wallet: ${address} (Base USDC)\n` +
            (band === 'p0'
              ? `Impact: coupon / Coinbase / Stripe payments may already fail with insufficient funder balance.\n`
              : `Impact: the payout refill is not keeping up with spend.\n`) +
            `Action needed: send Base USDC to the wallet above.`
        : `[MPP Router] ✅ Funder balance back to ${BAND_LABEL[band]}: ${current}\n` +
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
    if (prev > 0n && drop >= DROP_MIN_ABS && drop * 100n > prev * DROP_MIN_RATIO_PCT) {
      messages.push(
        `[MPP Router] ⚠️ Funder balance dropped sharply: ${formatUsd(prev)} → ${current} ` +
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

export async function readWatchState(kv: KVNamespace): Promise<FunderWatchState> {
  const raw = await kv.get(STATE_KEY)
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
}): Promise<{ messages: string[]; commit: () => Promise<void> } | null> {
  const now = args.now ?? Date.now()
  const previous = await readWatchState(args.kv)
  if (now - previous.lastSampleAt < SAMPLE_INTERVAL_MS) return null

  const read = await (args.readBalance ?? getBaseUsdcBalance)(args.address, args.rpcUrl)
  const rpcSummary = read.rpcsTried.map((r) => `${r.url} ${r.ok ? 'ok' : r.reason ?? 'failed'}`).join('; ')
  const decision = decide(previous, read.balance, args.address, now, rpcSummary)
  const commit = () => args.kv.put(STATE_KEY, JSON.stringify(decision.nextState))

  if (decision.messages.length === 0) {
    await commit()
    return null
  }
  return { messages: decision.messages, commit }
}
