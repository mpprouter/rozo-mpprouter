/**
 * Latest-voucher store + channel closed-marker for Option A settlement.
 *
 * To COLLECT what a user spent, the router must re-present the latest signed
 * commitment on-chain via `settle`/`close`. That needs the raw ed25519
 * SIGNATURE plus the cumulative amount — which the mppx cumulative watermark
 * does not keep. So on every KEPT charge we persist the latest voucher here.
 *
 * P0-C fix: this is backed by the SAME DO atomic store as the cumulative
 * watermark (`Store.cloudflare(doAtomicParams(env.ATOMIC_STORE))`), NOT plain
 * KV get/put. Every write is a linearizable compare-and-set, so a slower
 * concurrent call can never clobber a newer voucher or rewind the settled
 * watermark. The same store also holds a per-channel `closed` flag that fences
 * calls against an in-flight / completed settlement.
 *
 * DO keys (distinct from mppx's `stellar:channel:cumulative:*` and
 * `stellar:channel:challenge:*`):
 *   pg:channel:voucher:<C>  → { amountDecimal, cumulativeRaw, signature, lastSettledRaw, updatedAt }
 *   pg:channel:closed:<C>   → { closedAt }
 */

import { Store } from 'mppx/server'
import type { Env } from '../index'
import { doAtomicParams } from '../mpp/kv-atomic-store'

export interface LatestVoucher {
  amountDecimal: string
  cumulativeRaw: string
  signature: string
  lastSettledRaw: string
  updatedAt: string
}

const voucherKey = (c: string) => `pg:channel:voucher:${c}`
const closedKey = (c: string) => `pg:channel:closed:${c}`

function store(env: Env) {
  return Store.cloudflare(doAtomicParams(env.ATOMIC_STORE))
}

export async function getLatestVoucher(env: Env, channelContract: string): Promise<LatestVoucher | null> {
  const v = (await store(env).get(voucherKey(channelContract))) as LatestVoucher | null
  return v && typeof v === 'object' ? v : null
}

/**
 * Persist the latest voucher via atomic CAS. Monotone: a lower cumulative never
 * overwrites a higher one (a stale concurrent write is dropped). Throws on a
 * store failure so the caller can FAIL CLOSED (roll back the charge) rather
 * than leave a paid call with no redeemable voucher.
 */
export async function putLatestVoucher(
  env: Env,
  channelContract: string,
  v: { amountDecimal: string; cumulativeRaw: string; signature: string },
): Promise<void> {
  const s = store(env)
  await (s.update as any)(voucherKey(channelContract), (current: LatestVoucher | null) => {
    if (current && BigInt(current.cumulativeRaw) >= BigInt(v.cumulativeRaw)) {
      // A voucher at least this high is already stored — still redeemable.
      return { op: 'noop', result: true }
    }
    return {
      op: 'set',
      value: {
        amountDecimal: v.amountDecimal,
        cumulativeRaw: v.cumulativeRaw,
        signature: v.signature,
        lastSettledRaw: current?.lastSettledRaw ?? '0',
        updatedAt: new Date().toISOString(),
      },
      result: true,
    }
  })
}

/** Monotonically record a cumulative amount as settled on-chain (atomic CAS). */
export async function markVoucherSettled(
  env: Env,
  channelContract: string,
  settledRaw: string,
): Promise<void> {
  const s = store(env)
  await (s.update as any)(voucherKey(channelContract), (current: LatestVoucher | null) => {
    if (!current) return { op: 'noop', result: false }
    if (BigInt(current.lastSettledRaw) >= BigInt(settledRaw)) return { op: 'noop', result: false }
    return {
      op: 'set',
      value: { ...current, lastSettledRaw: settledRaw, updatedAt: new Date().toISOString() },
      result: true,
    }
  })
}

/** Atomically mark a channel closed (settlement in progress / done). */
export async function markChannelClosed(env: Env, channelContract: string): Promise<void> {
  const s = store(env)
  await (s.update as any)(closedKey(channelContract), () => ({
    op: 'set',
    value: { closedAt: new Date().toISOString() },
    result: true,
  }))
}

/** True once a channel has been marked closed — calls must reject afterwards. */
export async function isChannelClosed(env: Env, channelContract: string): Promise<boolean> {
  const v = await store(env).get(closedKey(channelContract))
  return v != null
}
