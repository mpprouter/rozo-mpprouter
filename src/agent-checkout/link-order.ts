/**
 * Per-payment approval (design impl-04 T6, C2): when the checkout page creates
 * the one-time deposit order for an invoice and passes the spend request's
 * `acPayToken`, link that order to the request (`pending_approval ->
 * awaiting_payment`).
 *
 * The order is the user's own money and the link is bookkeeping, so it never
 * changes the create-invoice response or blocks it: the link runs after the
 * response is built, off the response path, and any failure is only logged.
 * Without AC_REQUESTS_ENABLED=true or without a token nothing extra happens,
 * not even a body read.
 *
 * Only token-carrying creates are linked. The design's fallback (match an open
 * per-payment request by invoice id when no token is sent) is left for the
 * checkout-page PR, so a plain checkout never calls the Intents RPCs.
 */

import type { Env } from '../index'
import { acEnabled } from './routes'
import { acRpcClient, type AcRpc } from './rpc'

const PAY_TOKEN_RE = /^[0-9a-f]{64}$/
const SESSION_RE = /^paymentSession_[A-Za-z0-9_-]{1,128}$/
const LINK_RE = /^pl_[A-Za-z0-9_-]{1,128}$/
const BITREFILL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface WaitCtx {
  waitUntil(p: Promise<unknown>): void
}

/** What to link, from the create-invoice response, or null. */
export function linkArgsFromResponse(body: any, payToken: string, environment: 'prod' | 'test'): Record<string, unknown> | null {
  const rozoPaymentId = typeof body?.rozoPaymentId === 'string' ? body.rozoPaymentId : null
  if (!rozoPaymentId) return null
  if (typeof body?.linkId === 'string' && typeof body?.original === 'string') {
    const id = body.linkId
    const provider = SESSION_RE.test(id) ? 'coinbase_payment_session' : LINK_RE.test(id) ? 'coinbase_payment_link' : null
    if (!provider) return null
    return { pay_token: payToken, environment, provider, invoice_id: id, rozo_payment_id: rozoPaymentId, invoice_amount: body.original }
  }
  const brId = typeof body?.invoiceId === 'string' ? body.invoiceId.toLowerCase() : null
  const brAmount = body?.destination?.amount
  if (brId && BITREFILL_RE.test(brId) && typeof brAmount === 'string') {
    return { pay_token: payToken, environment, provider: 'bitrefill_invoice', invoice_id: brId, rozo_payment_id: rozoPaymentId, invoice_amount: brAmount }
  }
  return null
}

export async function withAgentCheckoutLink(
  request: Request,
  env: Env,
  ctx: WaitCtx | undefined,
  handler: (request: Request) => Promise<Response>,
  rpcOverride?: AcRpc,
): Promise<Response> {
  if (!acEnabled(env) || request.method !== 'POST') return handler(request)
  let payToken: string | null = null
  try {
    const peek = (await request.clone().json()) as any
    if (peek && typeof peek.acPayToken === 'string' && PAY_TOKEN_RE.test(peek.acPayToken)) payToken = peek.acPayToken
  } catch {
    // Not JSON: the handler answers it as before.
  }
  if (!payToken) return handler(request)

  const res = await handler(request)
  if (res.status !== 200) return res
  const rpc = rpcOverride ?? acRpcClient(env)
  if (!rpc) {
    console.warn('[agent-checkout] link skipped: RPC not configured')
    return res
  }
  const environment = env.AC_ENVIRONMENT === 'test' ? 'test' : 'prod'
  const task = (async () => {
    try {
      const body = await res.clone().json()
      const args = linkArgsFromResponse(body, payToken!, environment)
      if (!args) {
        console.warn('[agent-checkout] link skipped: response has no linkable order')
        return
      }
      const r = await rpc('ac_spend_link_order', args)
      if (r.outcome !== 'linked') console.warn(`[agent-checkout] link_order outcome=${r.outcome}`)
    } catch (e) {
      console.warn(`[agent-checkout] link_order failed: ${(e as Error).message}`)
    }
  })()
  if (ctx) ctx.waitUntil(task)
  else await task
  return res
}
