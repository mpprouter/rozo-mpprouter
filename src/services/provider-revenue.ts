import type { Env } from '../index'
import type { ProviderRecord } from './provider-registry'
import { STELLAR_PUBNET_USDC_ISSUER } from '../playground/deposit'

function amountToBaseUnits(amount: unknown): bigint | null {
  const match = String(amount ?? '').match(/^(\d+)\.(\d{1,7})$/)
  if (!match) return null
  return BigInt(match[1] + match[2].padEnd(7, '0'))
}

function baseUnitsToAmount(amount: bigint): string {
  const padded = amount.toString().padStart(8, '0')
  return `${padded.slice(0, -7)}.${padded.slice(-7)}`
}

export async function readProviderRevenue(env: Env, record: ProviderRecord) {
  const stellar = record.payouts.find(payout => payout.network === 'stellar:pubnet')
  if (!stellar) return { status: 'unavailable', detail: 'Direct on-chain revenue reading is currently available for Stellar payouts only.' }
  const horizon = (env.PLAYGROUND_HORIZON_URL || 'https://horizon.stellar.org').replace(/\/+$/, '')
  try {
    const response = await fetch(`${horizon}/accounts/${stellar.payTo}/payments?order=desc&limit=200`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return { status: 'unavailable', detail: `Horizon returned HTTP ${response.status}.` }
    const body = await response.json() as { _embedded?: { records?: Array<Record<string, unknown>> } }
    const inbound = (body._embedded?.records ?? []).filter(item =>
      item.to === stellar.payTo &&
      item.asset_code === 'USDC' &&
      item.asset_issuer === STELLAR_PUBNET_USDC_ISSUER &&
      amountToBaseUnits(item.amount) !== null,
    )
    const total = inbound.reduce((sum, item) => sum + (amountToBaseUnits(item.amount) ?? 0n), 0n)
    return { status: 'available', network: stellar.network, asset: 'USDC', asset_issuer: STELLAR_PUBNET_USDC_ISSUER, pay_to: stellar.payTo, total_received: baseUnitsToAmount(total), payments_sampled: inbound.length, sample_limit: 200, source: 'horizon' }
  } catch {
    return { status: 'unavailable', detail: 'Horizon could not be reached; no internal balance is substituted.' }
  }
}
