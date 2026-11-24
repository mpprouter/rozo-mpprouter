/**
 * Tiered funders: an order paid out of a wallet whose nominal amount range
 * does not include it (founder 2026-11-24: amounts route new orders; money
 * that already landed in a wallet is paid out by that wallet, never blocked).
 * This only reports: one structured log line and the ops alert. Never throws,
 * never affects the payment.
 */
import { alertSinkConfigured, sendAlert, type AlertEnv } from './alert'
import { redactForAlert } from './alert-redaction'

export interface FunderRangeWarning {
  site: string
  orderId: string | null
  invoiceId: string | null
  wallet: string
  address: string
  amountAtomic: bigint
  nominal: string | null
  warning: string
}

function mask(addr: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(addr) ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr
}

/** Upper bound on the background alert (it is never on the payment path). */
export const FUNDER_RANGE_ALERT_TIMEOUT_MS = 5_000

/**
 * Synchronous and non-blocking: the log line is written now; the ops alert is
 * sent in the background (handed to `waitUntil` when the caller has one) and
 * bounded by FUNDER_RANGE_ALERT_TIMEOUT_MS. Callers never await it, so a hung
 * alert channel can never delay or block the payment.
 */
export function reportFunderRangeWarning(
  env: AlertEnv,
  w: FunderRangeWarning,
  waitUntil?: (p: Promise<unknown>) => void,
): void {
  let p: Promise<void>
  try {
    p = sendRangeWarning(env, w)
  } catch {
    return
  }
  const bounded = Promise.race([
    p,
    new Promise<void>((resolve) => setTimeout(resolve, FUNDER_RANGE_ALERT_TIMEOUT_MS)),
  ]).catch(() => undefined)
  if (waitUntil) {
    try {
      waitUntil(bounded)
    } catch {
      // never affects the payment
    }
  }
}

async function sendRangeWarning(env: AlertEnv, w: FunderRangeWarning): Promise<void> {
  try {
    console.warn(
      JSON.stringify({
        event: 'funder_tier_range_warning',
        site: w.site,
        order_id: w.orderId,
        invoice_id: w.invoiceId,
        wallet: w.wallet,
        wallet_address: mask(w.address),
        amount_atomic: w.amountAtomic.toString(),
        nominal_wallet: w.nominal,
        warning: w.warning,
      }),
    )
    if (!alertSinkConfigured(env)) return
    const usd = (Number(w.amountAtomic) / 1e6).toFixed(2)
    await sendAlert(
      env,
      redactForAlert(
        [
          '[MPP Router] ⚠️ Funder tier range: order paid by its receiving wallet outside the nominal range (not blocked)',
          `Site: ${w.site}`,
          `Order: ${w.orderId ?? '?'}${w.invoiceId ? `, invoice ${w.invoiceId}` : ''}`,
          `Paid by: ${w.wallet} ${mask(w.address)}, amount ${usd} USDC, nominal wallet ${w.nominal ?? 'none'}`,
          'Action: none required. Check why the order was routed to this wallet if it repeats.',
        ].join('\n'),
      ),
    )
  } catch {
    // never affects the payment
  }
}
