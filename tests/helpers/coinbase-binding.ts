// Upstream payloads that satisfy the Coinbase settle path's order binding
// (webhook.ts verifyCoinbaseOrderBinding): a paid Rozo order for the link on
// the Coinbase app, and a Coinbase v1 payment link whose amount fits it.

export const BINDING_APP_ID = 'merchant_openrouter'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** Rozo GET /payments/<id> body for a paid order of `plId`. */
export function boundRozoOrder(
  id: string,
  plId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    appId: BINDING_APP_ID,
    orderId: plId,
    status: 'payment_payout_completed',
    source: { amount: '1.00', chainId: '8453' },
    destination: { amount: '1.00', chainId: '8453' },
    ...overrides,
  }
}

/** Coinbase next-api v1 payment link body charging `amount` USDC. */
export function boundCoinbaseLink(
  plId: string,
  amount = '1.00',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: plId,
    status: 'ACTIVE',
    fiat: { amount, currency: 'USD' },
    maxAmount: amount,
    token: BASE_USDC,
    networkId: 8453,
    usageCount: 0,
    maxUsage: 1,
    preApprovalExpiry: String(Math.floor(Date.now() / 1000) + 86400),
    ...overrides,
  }
}

/**
 * For stubs that do not model these upstreams themselves: answers the
 * binding reads (Rozo GET /payments/<id> and Coinbase next-api) for `plId`,
 * or returns null so the stub falls through to its own routing.
 */
export function bindingUpstream(
  url: string,
  init: RequestInit | undefined,
  opts: { plId: string; rozoId: string; order?: Record<string, unknown>; invoiceAmount?: string },
): Response | null {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (url.includes('payments.coinbase.com/next-api/')) {
    return Response.json(boundCoinbaseLink(opts.plId, opts.invoiceAmount ?? '1.00'))
  }
  if (
    method === 'GET' &&
    url.includes('intentapiv4.rozo.ai') &&
    url.includes(`/payments/${encodeURIComponent(opts.rozoId)}`) &&
    !url.endsWith('/delivered')
  ) {
    return Response.json(boundRozoOrder(opts.rozoId, opts.plId, opts.order ?? {}))
  }
  return null
}
