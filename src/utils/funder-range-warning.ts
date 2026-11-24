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

export async function reportFunderRangeWarning(env: AlertEnv, w: FunderRangeWarning): Promise<void> {
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
