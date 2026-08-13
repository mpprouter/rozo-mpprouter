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
  /** Human/display USD string (e.g. "0.02"). Never used for arithmetic. */
  amountDecimal: string
  /**
   * The signed cumulative in BASE-UNIT stroops (7-decimal USDC) — the exact
   * integer the client signed and the collector redeems on-chain. Settlement
   * submits this value verbatim as the `close` amount. Must match the voucher's
   * `payload.amount` with NO re-scaling.
   */
  cumulativeRaw: string
  signature: string
  /** Highest cumulative already settled on-chain, base-unit stroops. */
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

/** True once a channel has been marked closed (fast atomic marker). */
export async function isChannelClosed(env: Env, channelContract: string): Promise<boolean> {
  const v = await store(env).get(closedKey(channelContract))
  return v != null
}

// ---------------------------------------------------------------------------
// Lock-INDEPENDENT persistent fence (P0-2 / P0-6). Kept on the STRONGLY
// consistent atomic DO store — NOT eventually-consistent KV, which could leave
// a fence invisible cross-colo and let a call in another colo absorb the
// uncharged increment. The dispatch gate checks the closed marker AND this
// fence on every call, so a fenced channel rejects immediately everywhere,
// regardless of lock state — a released/taken-over lock can never let a call
// advance a fenced channel.
// ---------------------------------------------------------------------------

const fencedKey = (c: string) => `pg:channel:fenced:${c}`

/**
 * Durably fence a channel on the atomic store, retrying a few times. Returns
 * true iff the marker was written. The caller logs CRITICAL when this returns
 * false — the only (astronomically rare, store-down) case where it could miss.
 */
export async function fenceChannelPersistent(env: Env, channelContract: string): Promise<boolean> {
  const s = store(env)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await (s.update as any)(fencedKey(channelContract), () => ({
        op: 'set',
        value: { fencedAt: new Date().toISOString() },
        result: true,
      }))
      return true
    } catch (e: any) {
      console.error(`[channel] persistent fence write attempt ${attempt + 1} failed: ${e?.message}`)
    }
  }
  return false
}

/**
 * A channel is BLOCKED for new calls if either the fast atomic closed marker OR
 * the durable atomic fence is set. The dispatch gate calls this on every
 * request. Both reads hit the strongly-consistent store, so a fence is visible
 * immediately in every colo.
 */
export async function isChannelBlocked(env: Env, channelContract: string): Promise<boolean> {
  const s = store(env)
  const [closed, fenced] = await Promise.all([s.get(closedKey(channelContract)), s.get(fencedKey(channelContract))])
  return closed != null || fenced != null
}

// ---------------------------------------------------------------------------
// Recon: count of paid-then-superseded aborts (the documented bounded router
// loss — a call that paid upstream, hung past the lock TTL, was superseded, and
// aborted its own persist). Surfaced via the operator totals endpoint so it is
// recon-visible, never a silent hole.
// ---------------------------------------------------------------------------

const RECON_SUPERSEDE_KEY = 'pg:channel:recon:superseded-aborts'

export async function incrSupersededAbort(env: Env): Promise<void> {
  const s = store(env)
  await (s.update as any)(RECON_SUPERSEDE_KEY, (current: any) => ({
    op: 'set',
    value: { count: (current?.count ?? 0) + 1 },
    result: true,
  }))
}

export async function getSupersededAbortCount(env: Env): Promise<number> {
  const v = (await store(env).get(RECON_SUPERSEDE_KEY)) as any
  return v?.count ?? 0
}

const writeoffKey = (c: string) => `pg:channel:writeoff:${c}`

export interface VoucherWriteoff {
  /** The signed cumulative that was NOT collectable on-chain, base-unit stroops. */
  cumulativeRaw: string
  reason: string
  at: string
}

/**
 * Terminal write-off record: the funder's unilateral refund emptied the channel
 * before the collector's close landed, so this cumulative is forgiven debt, NOT
 * settled funds. Kept under its own key so reconciliation can distinguish
 * collected from written-off amounts; the caller ALSO advances lastSettledRaw
 * (documented there as "no longer collectable") purely to stop the cron
 * retrying a dead channel.
 */
const RECON_WRITEOFF_KEY = 'pg:channel:recon:writeoffs'

export async function markVoucherWrittenOff(
  env: Env,
  channelContract: string,
  cumulativeRaw: string,
  reason: string,
): Promise<void> {
  const s = store(env)
  // Per-channel terminal record (idempotent set) ...
  const wrote = await (s.update as any)(writeoffKey(channelContract), (current: any) =>
    current
      ? { op: 'noop', result: false }
      : {
          op: 'set',
          value: { cumulativeRaw, reason, at: new Date().toISOString() } satisfies VoucherWriteoff,
          result: true,
        },
  )
  // ...plus a global recon aggregate (count + total raw), bumped only on the
  // FIRST write for a channel so a retried write-off never double-counts.
  if (wrote) {
    await (s.update as any)(RECON_WRITEOFF_KEY, (current: any) => ({
      op: 'set',
      value: {
        count: (current?.count ?? 0) + 1,
        totalRaw: (BigInt(current?.totalRaw ?? '0') + BigInt(cumulativeRaw)).toString(),
      },
      result: true,
    }))
  }
}

export async function getWriteoffTotals(env: Env): Promise<{ count: number; totalRaw: string }> {
  const v = (await store(env).get(RECON_WRITEOFF_KEY)) as any
  return { count: v?.count ?? 0, totalRaw: v?.totalRaw ?? '0' }
}

export async function getVoucherWriteoff(
  env: Env,
  channelContract: string,
): Promise<VoucherWriteoff | null> {
  const v = (await store(env).get(writeoffKey(channelContract))) as VoucherWriteoff | null
  return v && typeof v === 'object' ? v : null
}
