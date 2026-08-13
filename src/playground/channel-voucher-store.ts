/**
 * Latest-voucher store for the channel playground (Option A online settlement).
 *
 * The mppx atomic store tracks the cumulative WATERMARK, but to actually
 * COLLECT what a user spent the router must re-present the latest signed
 * commitment on-chain via the channel's `settle`/`close`. That needs the raw
 * ed25519 SIGNATURE plus the cumulative amount — neither of which the mppx
 * watermark keeps. So on every KEPT charge we persist the latest voucher here,
 * keyed by channel, and the every-2-minutes settlement cron reads it.
 *
 * Key: `playgroundVoucher:<channelContract>` in MPP_STORE. Distinct from the
 * `stellarChannel:*` metadata and mppx's `stellar:channel:*` prefixes.
 */

import type { Env } from '../index'

export interface LatestVoucher {
  /** Cumulative amount as the decimal string the client signed (channel units). */
  amountDecimal: string
  /** Cumulative amount in 7-decimal atomic base units (for the on-chain i128). */
  cumulativeRaw: string
  /** Raw ed25519 signature over the commitment, as the credential carried it. */
  signature: string
  /** Highest cumulative already settled on-chain, atomic base units. */
  lastSettledRaw: string
  updatedAt: string
}

const PREFIX = 'playgroundVoucher:'

function key(channelContract: string): string {
  return `${PREFIX}${channelContract}`
}

export async function getLatestVoucher(
  env: Env,
  channelContract: string,
): Promise<LatestVoucher | null> {
  const raw = await env.MPP_STORE.get(key(channelContract))
  if (!raw) return null
  try {
    return JSON.parse(raw) as LatestVoucher
  } catch {
    return null
  }
}

/**
 * Record the latest voucher, but only if it advances the cumulative (monotone)
 * — a stale write from a slower concurrent call must never lower the amount the
 * router can collect. Preserves the existing `lastSettledRaw`.
 */
export async function putLatestVoucher(
  env: Env,
  channelContract: string,
  v: { amountDecimal: string; cumulativeRaw: string; signature: string },
): Promise<void> {
  const existing = await getLatestVoucher(env, channelContract)
  if (existing && BigInt(existing.cumulativeRaw) >= BigInt(v.cumulativeRaw)) return
  const next: LatestVoucher = {
    amountDecimal: v.amountDecimal,
    cumulativeRaw: v.cumulativeRaw,
    signature: v.signature,
    lastSettledRaw: existing?.lastSettledRaw ?? '0',
    updatedAt: new Date().toISOString(),
  }
  await env.MPP_STORE.put(key(channelContract), JSON.stringify(next))
}

/** Mark a cumulative amount as settled on-chain so the cron does not re-settle it. */
export async function markVoucherSettled(
  env: Env,
  channelContract: string,
  settledRaw: string,
): Promise<void> {
  const existing = await getLatestVoucher(env, channelContract)
  if (!existing) return
  if (BigInt(existing.lastSettledRaw) >= BigInt(settledRaw)) return
  await env.MPP_STORE.put(
    key(channelContract),
    JSON.stringify({ ...existing, lastSettledRaw: settledRaw, updatedAt: new Date().toISOString() }),
  )
}
