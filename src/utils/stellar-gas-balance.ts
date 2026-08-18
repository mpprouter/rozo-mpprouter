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
export async function getGasSponsorBalance(
  horizonUrl: string | undefined,
  address: string | undefined,
): Promise<GasSponsorBalance> {
  if (!horizonUrl) return { stroops: null, reason: 'horizon url not configured' }
  if (!address) return { stroops: null, reason: 'gas sponsor address not configured' }

  let res: Response
  try {
    res = await fetch(`${horizonUrl.replace(/\/$/, '')}/accounts/${address}`, {
      headers: { accept: 'application/json' },
    })
  } catch (err) {
    return { stroops: null, reason: `horizon unreachable: ${(err as Error).message}` }
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
  /** The state to persist for the next tick. */
  nextState: GasSponsorState
  /** Alert text, already built. Empty when shouldAlert is false. */
  message: string
}

/**
 * Decide whether this tick warrants an alert.
 *
 * Fires only when the state CHANGES, which is what keeps a 2-minute cron from
 * sending the same warning 720 times a day. Recovery is announced too — an
 * operator who was told about a problem is owed the "it is fixed" message, and
 * without it the only way to learn is to go and look.
 *
 * `unreadable` alerts on transition as well, but says plainly that we could
 * not read the balance rather than implying the account is empty. Repeated
 * unreadable ticks stay silent, so a Horizon outage does not become a pager
 * storm.
 */
export function decideTransition(
  previous: GasSponsorState | null,
  balance: GasSponsorBalance,
  address: string,
): TransitionDecision {
  const nextState = classify(balance)
  if (previous === nextState) {
    return { shouldAlert: false, nextState, message: '' }
  }

  // First ever observation of a healthy account is not news.
  if (previous === null && nextState === 'ok') {
    return { shouldAlert: false, nextState, message: '' }
  }

  const threshold = formatStroopsAsXlm(GAS_SPONSOR_LOW_THRESHOLD_STROOPS)

  if (nextState === 'low') {
    const current = formatStroopsAsXlm(balance.stroops!)
    return {
      shouldAlert: true,
      nextState,
      message:
        `[MPP Router] ⚠️ Stellar gas sponsor low balance: ${current} XLM\n` +
        `Account: ${address}\n` +
        `Threshold: ${threshold} XLM\n` +
        `Impact: this account pays the fee for every on-chain action — settlement, ` +
        `channel close and refunds all stop broadcasting when it empties.\n` +
        `Action needed: send XLM to the account above.`,
    }
  }

  if (nextState === 'ok') {
    const current = formatStroopsAsXlm(balance.stroops!)
    return {
      shouldAlert: true,
      nextState,
      message:
        `[MPP Router] ✅ Stellar gas sponsor recovered: ${current} XLM\n` +
        `Account: ${address}\n` +
        `Back above the ${threshold} XLM threshold.`,
    }
  }

  return {
    shouldAlert: true,
    nextState,
    message:
      `[MPP Router] ❓ Stellar gas sponsor balance could not be read: ${balance.reason}\n` +
      `Account: ${address}\n` +
      `This is NOT a report that the balance is low — we do not currently know what it is. ` +
      `If this persists, check Horizon availability and the account address.`,
  }
}

/** Read the persisted state. Unknown/corrupt values read as null (no history). */
export async function readState(kv: KVNamespace): Promise<GasSponsorState | null> {
  const raw = await kv.get(STATE_KEY)
  return raw === 'ok' || raw === 'low' || raw === 'unreadable' ? raw : null
}

export async function writeState(kv: KVNamespace, state: GasSponsorState): Promise<void> {
  await kv.put(STATE_KEY, state)
}

/**
 * One monitoring tick. Returns the alert to send, or null.
 *
 * The caller sends it — this module never reaches the network on its own, so
 * it stays testable without mocking the alert transport, and the alert goes
 * through `redactForAlert` at the call site like every other alert.
 */
export async function checkGasSponsor(args: {
  kv: KVNamespace
  horizonUrl: string | undefined
  address: string | undefined
}): Promise<{ message: string; state: GasSponsorState } | null> {
  const balance = await getGasSponsorBalance(args.horizonUrl, args.address)
  const previous = await readState(args.kv)
  const decision = decideTransition(previous, balance, args.address ?? '(unset)')

  // Persist even when not alerting: the state machine only works if every
  // observation is recorded, not just the noisy ones.
  if (previous !== decision.nextState) {
    await writeState(args.kv, decision.nextState)
  }

  if (!decision.shouldAlert) return null
  return { message: decision.message, state: decision.nextState }
}

/** Re-exported so the call site's intent is visible in one import. */
export type { RedactedAlert }
