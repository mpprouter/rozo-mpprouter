/**
 * Low-balance monitoring for the Stellar gas sponsor.
 *
 * The gas sponsor pays the XLM transaction fee for every on-chain action the
 * router takes — settlement, channel close, refunds. It is the one funded
 * account with **no monitoring at all**: a threat-model re-derivation on
 * 2026-08-17 found it appears in exactly three places (an env declaration, an
 * accessor, and a field echoed by `/health`) and nothing anywhere reads its
 * balance. If it drains, the first signal is transactions failing to broadcast
 * — i.e. we learn from the damage. This closes `DoS.3.R.1` on the Stellar side.
 *
 * Two failure modes from this repo's own history are designed against here:
 *
 * 1. **An unreadable balance must never become a confident zero.** A previous
 *    incident had `Number(malformed) || 0` manufacture a legitimate-looking
 *    zero from an unreadable response, producing a full-drain alert for an
 *    account that had not moved. Every parse step here returns `null` on doubt,
 *    and `null` never alerts as "low" — it is a separate, quieter state.
 *
 * 2. **A cron that alerts on a level re-alerts forever.** The scheduled handler
 *    runs every 2 minutes; a naive threshold check would re-send the same alert
 *    720 times a day for one unresolved condition. Alerts fire on TRANSITION
 *    only, with the last state persisted in KV.
 */

import type { RedactedAlert } from './alert-redaction'

/**
 * Alert below 10 XLM.
 *
 * Rationale, in fee terms rather than round numbers: the base fee is 100
 * stroops (0.00001 XLM), but this repo has had to raise the inclusion fee to
 * 1,000,000 stroops (0.1 XLM) to get mainnet deploys through congestion. At
 * that congested rate 10 XLM is ~100 transactions of headroom — enough to
 * notice and top up, not so much that the alert is academic. In stroops
 * because Horizon reports XLM as a decimal string and float math on balances
 * is how rounding bugs start.
 */
export const GAS_SPONSOR_LOW_THRESHOLD_STROOPS = 100_000_000n // 10 XLM

const STROOPS_PER_XLM = 10_000_000n

/** KV key holding the last observed state, so alerts fire on transition only. */
const STATE_KEY = 'gas-sponsor:last-alert-state'

export type GasSponsorState = 'ok' | 'low' | 'unreadable'

export interface GasSponsorBalance {
  /** Native XLM balance in stroops, or null if it could not be determined. */
  stroops: bigint | null
  /** Why it is null, for the operator. Empty when the read succeeded. */
  reason: string
}

/**
 * Read the gas sponsor's native XLM balance from Horizon.
 *
 * Returns `stroops: null` for every uncertain outcome — network error, non-200,
 * unparseable body, missing native balance line, or a numeric string that does
 * not parse cleanly. The caller must treat null as "unknown", never as zero.
 */
export const DEFAULT_HORIZON_TIMEOUT_MS = 5_000

export async function getGasSponsorBalance(
  horizonUrl: string | undefined,
  address: string | undefined,
  timeoutMs: number = DEFAULT_HORIZON_TIMEOUT_MS,
): Promise<GasSponsorBalance> {
  if (!horizonUrl) return { stroops: null, reason: 'horizon url not configured' }
  if (!address) return { stroops: null, reason: 'gas sponsor address not configured' }

  let res: Response
  try {
    // Explicit timeout. This runs on the cron shared with refund reconciliation
    // and channel settlement, so a hung Horizon connection would eat the
    // invocation's budget and silently starve work that matters more than this
    // monitor does.
    res = await fetch(`${horizonUrl.replace(/\/$/, '')}/accounts/${address}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const e = err as Error
    const reason = e.name === 'TimeoutError' || e.name === 'AbortError'
      ? `horizon timed out after ${timeoutMs}ms`
      : `horizon unreachable: ${e.message}`
    return { stroops: null, reason }
  }

  // A 404 is genuinely different from a read failure: it means the account is
  // not funded on this network at all. That is a real, alertable condition,
  // but it is not "balance zero after being funded" — say which one it is.
  if (res.status === 404) {
    return { stroops: null, reason: 'account not found on this network (never funded, or wrong network)' }
  }
  if (!res.ok) {
    return { stroops: null, reason: `horizon returned ${res.status}` }
  }

  let body: { balances?: Array<{ asset_type?: string; balance?: string }> }
  try {
    body = await res.json()
  } catch {
    return { stroops: null, reason: 'horizon response was not JSON' }
  }

  const native = body.balances?.find((b) => b.asset_type === 'native')
  if (!native || typeof native.balance !== 'string') {
    return { stroops: null, reason: 'no native balance line in horizon response' }
  }

  const stroops = parseXlmToStroops(native.balance)
  if (stroops === null) {
    // Deliberately does NOT echo the raw value: it is attacker-influenced only
    // in theory, but the rule that unparseable input is described rather than
    // quoted costs nothing here.
    return { stroops: null, reason: 'native balance was not a parseable decimal' }
  }

  return { stroops, reason: '' }
}

/**
 * Parse Horizon's decimal XLM string ("123.4567890") into stroops.
 *
 * Exact integer arithmetic, no floats: `Number("0.1") * 1e7` is not 1000000 in
 * binary floating point, and a balance comparison that is off by a stroop at
 * the threshold boundary produces an alert that flaps.
 *
 * Returns null — never 0 — for anything that does not match the expected
 * shape, so a malformed response cannot masquerade as a drained account.
 */
export function parseXlmToStroops(value: string): bigint | null {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null

  const [whole, frac = ''] = trimmed.split('.')
  // Stellar has exactly 7 decimal places. More than that is not a value we
  // recognise, so refuse rather than silently truncating someone's balance.
  if (frac.length > 7) return null

  try {
    return BigInt(whole) * STROOPS_PER_XLM + BigInt(frac.padEnd(7, '0') || '0')
  } catch {
    return null
  }
}

/** Human-facing XLM string from stroops, without float rounding. */
export function formatStroopsAsXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM
  const frac = (stroops % STROOPS_PER_XLM).toString().padStart(7, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** Classify a reading. `null` stroops is its own state, never "low". */
export function classify(balance: GasSponsorBalance): GasSponsorState {
  if (balance.stroops === null) return 'unreadable'
  return balance.stroops < GAS_SPONSOR_LOW_THRESHOLD_STROOPS ? 'low' : 'ok'
}

export interface TransitionDecision {
  /** Whether an alert should be sent for this tick. */
  shouldAlert: boolean
  /** The state to persist AFTER the alert is confirmed sent. */
  nextState: PersistedState
  /** Alert text, already built. Empty when shouldAlert is false. */
  message: string
}

/**
 * What we persist between ticks.
 *
 * `substantive` deliberately holds only `ok` / `low` — never `unreadable`.
 *
 * Codex review finding: with a single flat state, `low -> unreadable -> low`
 * alerted three times, so one intermittent Horizon blip re-raised an
 * unchanged low balance. Because Horizon blips are routine and a low balance
 * can persist for hours, that is not a rare interleaving; it is the normal
 * case. Keeping "what we last actually knew" on its own track means an
 * unreadable tick cannot erase it, and returning to the same substantive
 * state is silent.
 *
 * `unreadableStreak` counts consecutive failed reads. `unreadableAlerted`
 * records whether we already said so, so a Horizon outage produces one
 * message rather than one every two minutes.
 */
export interface PersistedState {
  substantive: 'ok' | 'low' | null
  unreadableStreak: number
  unreadableAlerted: boolean
}

const EMPTY_STATE: PersistedState = { substantive: null, unreadableStreak: 0, unreadableAlerted: false }

/**
 * Consecutive failed reads before we say anything.
 *
 * A single blip is not worth a message; ~10 minutes of not knowing is. This is
 * the one alert that reports our own blindness rather than a balance, so it
 * should be rare enough that it still means something.
 */
export const UNREADABLE_ALERT_AFTER = 5

/**
 * Decide whether this tick warrants an alert.
 *
 * Alerts on CHANGE, never on level: at 2-minute granularity a level check
 * would send the same warning 720 times a day for one unresolved condition.
 */
export function decideTransition(
  previous: PersistedState,
  balance: GasSponsorBalance,
  address: string,
): TransitionDecision {
  const threshold = formatStroopsAsXlm(GAS_SPONSOR_LOW_THRESHOLD_STROOPS)
  const observed = classify(balance)

  // ── Could not read ────────────────────────────────────────────────────
  // Never touches `substantive`: not knowing is not the same as knowing the
  // state changed, and conflating them is what caused the flapping.
  if (observed === 'unreadable') {
    const streak = previous.unreadableStreak + 1
    const shouldAlert = streak >= UNREADABLE_ALERT_AFTER && !previous.unreadableAlerted
    return {
      shouldAlert,
      nextState: { ...previous, unreadableStreak: streak, unreadableAlerted: previous.unreadableAlerted || shouldAlert },
      message: shouldAlert
        ? `[MPP Router] ❓ Stellar gas sponsor balance unreadable for ${streak} consecutive checks: ${balance.reason}\n` +
          `Account: ${address}\n` +
          `This is NOT a report that the balance is low — we do not currently know what it is. ` +
          `Check Horizon availability and that the account address is correct.`
        : '',
    }
  }

  // ── Read succeeded ────────────────────────────────────────────────────
  const current = formatStroopsAsXlm(balance.stroops!)
  const base: PersistedState = { substantive: observed, unreadableStreak: 0, unreadableAlerted: false }

  // Same as what we last actually knew → silent, regardless of any unreadable
  // ticks in between. This is the case the review found re-alerting.
  if (previous.substantive === observed) {
    return { shouldAlert: false, nextState: base, message: '' }
  }

  // First ever observation of a healthy account is not news.
  if (previous.substantive === null && observed === 'ok') {
    return { shouldAlert: false, nextState: base, message: '' }
  }

  if (observed === 'low') {
    return {
      shouldAlert: true,
      nextState: base,
      message:
        `[MPP Router] ⚠️ Stellar gas sponsor low balance: ${current} XLM\n` +
        `Account: ${address}\n` +
        `Threshold: ${threshold} XLM\n` +
        `Impact: this account pays the fee for every on-chain action — settlement, ` +
        `channel close and refunds all stop broadcasting when it empties.\n` +
        `Action needed: send XLM to the account above.`,
    }
  }

  // Only a genuine low → ok is a "recovery". Reaching `ok` from no prior
  // knowledge is not, and the review was right that calling it one would be
  // misleading — it implies a problem that may never have existed.
  return {
    shouldAlert: true,
    nextState: base,
    message:
      `[MPP Router] ✅ Stellar gas sponsor recovered: ${current} XLM\n` +
      `Account: ${address}\n` +
      `Back above the ${threshold} XLM threshold.`,
  }
}

/** Read persisted state. Anything unrecognised reads as "no history". */
export async function readState(kv: KVNamespace): Promise<PersistedState> {
  const raw = await kv.get(STATE_KEY)
  if (!raw) return { ...EMPTY_STATE }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    return {
      substantive: parsed.substantive === 'ok' || parsed.substantive === 'low' ? parsed.substantive : null,
      unreadableStreak: Number.isInteger(parsed.unreadableStreak) ? parsed.unreadableStreak as number : 0,
      unreadableAlerted: parsed.unreadableAlerted === true,
    }
  } catch {
    return { ...EMPTY_STATE }
  }
}

export async function writeState(kv: KVNamespace, state: PersistedState): Promise<void> {
  await kv.put(STATE_KEY, JSON.stringify(state))
}

/**
 * One monitoring tick.
 *
 * Returns an alert to send plus a `commit()` the caller MUST invoke once the
 * alert has actually gone out.
 *
 * Codex review finding: the first version persisted the new state before the
 * alert was delivered, so a failed send left `low` recorded and every
 * subsequent low reading was deduped away — the monitor stayed silent forever
 * while looking healthy. Committing after delivery means a failed send is
 * simply retried on the next tick, which is the behaviour you want from
 * something whose entire job is to speak up.
 *
 * When no alert is due, the state is committed immediately: those writes carry
 * no risk of being lost mid-notification.
 */
export async function checkGasSponsor(args: {
  kv: KVNamespace
  horizonUrl: string | undefined
  address: string | undefined
  timeoutMs?: number
}): Promise<{ message: string; state: PersistedState; commit: () => Promise<void> } | null> {
  const balance = await getGasSponsorBalance(args.horizonUrl, args.address, args.timeoutMs)
  const previous = await readState(args.kv)
  const decision = decideTransition(previous, balance, args.address ?? '(unset)')

  if (!decision.shouldAlert) {
    await writeState(args.kv, decision.nextState)
    return null
  }

  return {
    message: decision.message,
    state: decision.nextState,
    commit: () => writeState(args.kv, decision.nextState),
  }
}

/** Re-exported so the call site's intent is visible in one import. */
export type { RedactedAlert }
