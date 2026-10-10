/**
 * Hourly x402 payer reconciliation. SKELETON ONLY (v1): it reads the ledger
 * totals and logs them. No alert is sent yet.
 *
 * TODO(x402 v1.1), design 5.2 "余额总额对 funder 余额每小时对账":
 *   1. Read the Base funder USDC balance (utils/base-usdc-balance.ts) and the
 *      Solana funder USDC balance (getTokenAccountBalance on its USDC ATA).
 *   2. Compare against balance_usd_total + signed_unsettled_usd per network
 *      (signed credentials not yet settled are still a claim on the funder).
 *      Reuse brain.db hub_balance_snapshot history if the comparison needs a
 *      trend rather than one point.
 *   3. Expired credentials: for each 'signed' row past valid_before, check
 *      USDC authorizationState(funder, nonce) on Base (or the tx signature on
 *      Solana). Unused -> mark 'expired' and credit the balance back; used ->
 *      mark 'settled' with tx_hash. Needs a new secret-gated ledger RPC.
 *   4. Alert through utils/alert.ts sendAlert on a shortfall, state-transition
 *      only (same pattern as watchFunderBalance), never per tick.
 */

import type { X402Ledger } from './ledger'

const LAST_RUN_KEY = 'x402payer:reconcile:last-hour'

export async function reconcileX402Payer(
  kv: KVNamespace,
  ledger: X402Ledger | null,
  nowMs: number = Date.now(),
): Promise<{ ran: boolean; snapshot?: Record<string, unknown> }> {
  if (!ledger) return { ran: false }
  // The Worker cron fires every 2 minutes; run once per UTC hour.
  const hour = String(Math.floor(nowMs / 3_600_000))
  if ((await kv.get(LAST_RUN_KEY)) === hour) return { ran: false }
  await kv.put(LAST_RUN_KEY, hour, { expirationTtl: 7200 })

  const snapshot = await ledger.liabilitySnapshot()
  if (snapshot.mode === 'off') return { ran: true, snapshot }
  console.log(
    `[x402-reconcile] mode=${String(snapshot.mode)} accounts=${String(snapshot.accounts)} ` +
      `balance_usd_total=${String(snapshot.balance_usd_total)} signed_unsettled_usd=${String(snapshot.signed_unsettled_usd)} ` +
      `topups_review=${String(snapshot.topups_review)}`,
  )
  // TODO(x402 v1.1): steps 1 to 4 above.
  return { ran: true, snapshot }
}
