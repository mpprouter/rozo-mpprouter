/**
 * Inclusion fee bid for x402 settlement transactions.
 *
 * @x402/stellar bids its default of 100 stroops. On 2026-11-07 the network
 * was including Soroban transactions at 200 (getFeeStats, every percentile)
 * and our settlements took 12 to 29 s or did not land at all, while the RPC
 * answered in about 15 ms.
 *
 * The bid is a ceiling, not a price. It is added to the transaction's max fee;
 * the amount charged follows the network's fee level. The gas sponsor therefore
 * only pays near this value during real surge pricing, and CAP bounds that.
 */
import { rpc } from '@stellar/stellar-sdk'

export const INCLUSION_BID_FLOOR_STROOPS = 400
/** Used until the first successful read of the network's fee level. */
export const INCLUSION_BID_DEFAULT_STROOPS = 1_000
/** 0.001 XLM. Hard limit per settlement however congested the reading is. */
export const INCLUSION_BID_CAP_STROOPS = 10_000
export const INCLUSION_BID_TTL_MS = 60_000
/** Comes out of the settlement's own deadline, so it must stay short. */
export const INCLUSION_BID_READ_TIMEOUT_MS = 1_500

export function computeInclusionBid(p90: unknown): number {
  const value = typeof p90 === 'string' && /^\d+$/.test(p90) ? Number(p90) : NaN
  if (!Number.isSafeInteger(value)) return INCLUSION_BID_DEFAULT_STROOPS
  return Math.min(INCLUSION_BID_CAP_STROOPS, Math.max(INCLUSION_BID_FLOOR_STROOPS, value * 2))
}

let bid = INCLUSION_BID_DEFAULT_STROOPS
let readAt: number | null = null

export function currentInclusionBid(): number {
  return bid
}

/** Test seam: module state otherwise lives as long as the isolate. */
export function resetInclusionBidForTest(): void {
  bid = INCLUSION_BID_DEFAULT_STROOPS
  readAt = null
}

type ReadP90 = (rpcUrl: string) => Promise<unknown>

const readP90FromRpc: ReadP90 = async (rpcUrl) =>
  (await new rpc.Server(rpcUrl).getFeeStats()).sorobanInclusionFee.p90

/**
 * Refresh the bid at most once per TTL. Never throws and never waits past the
 * timeout: a failed read keeps the last good bid. Failures also start the TTL,
 * so a broken RPC cannot add this wait to every settlement.
 *
 * Concurrent callers each read rather than share a promise: Workers forbid
 * awaiting I/O started by another request.
 */
export async function refreshInclusionBid(
  rpcUrl: string,
  now: number = Date.now(),
  read: ReadP90 = readP90FromRpc,
  timeoutMs: number = INCLUSION_BID_READ_TIMEOUT_MS,
): Promise<number> {
  if (readAt !== null && now - readAt < INCLUSION_BID_TTL_MS) return bid
  readAt = now
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const p90 = await Promise.race([
      read(rpcUrl),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      }),
    ])
    // An unusable reading keeps the last good bid, same as a failed read.
    if (readAt !== now) return bid // A newer read started; it decides.
    if (typeof p90 === 'string' && /^\d+$/.test(p90)) bid = computeInclusionBid(p90)
    else console.warn('[x402] fee stats unusable, keeping inclusion bid')
  } catch (err) {
    // The name only: an RPC error message can carry the keyed URL.
    console.warn(`[x402] fee stats read failed: ${(err as Error)?.name ?? 'Error'}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
  return bid
}
