// Base URLs for the Rozo Intents API.
//
// ROZO_INTENTS_BASE is the big `payment-api` edge function: every write
// (POST /payments, POST /payments/:id/checkout, /delivered, payin, email) goes
// there and only there.
//
// intentsReadBase(env) is the base for the read-only GETs
// (GET /payments/:id and GET /payments/order/:appId/:orderId). It returns
// env.ROZO_INTENTS_READ_BASE when set (e.g. the small `payment-read` function,
// https://intentapiv4.rozo.ai/functions/v1/payment-read, which serves the same
// routes with the same responses and X-API-Key semantics), else
// ROZO_INTENTS_BASE. Unset or blank = today's behavior, byte-identical URLs.
// Rollback = clear the variable; no code change, no intents deploy.
//
// The override is honored only on the Rozo Intents hosts below: these GETs
// carry X-API-Key, so a typo or a foreign host must not receive it. Anything
// else is ignored (falls back to payment-api) with one console.warn.
//
// Never route a non-GET through intentsReadBase.

import type { Env } from '../index'

export const ROZO_INTENTS_BASE = 'https://intentapiv4.rozo.ai/functions/v1/payment-api'

export const INTENTS_READ_BASE_ALLOWED_PREFIXES = [
  'https://intentapiv4.rozo.ai/',
  'https://aozudqtlykbhzbuzalzz.supabase.co/',
] as const

let warnedRejectedOverride = false

export function intentsReadBase(env: Pick<Env, 'ROZO_INTENTS_READ_BASE'> | undefined): string {
  const override = env?.ROZO_INTENTS_READ_BASE?.trim()
  if (!override) return ROZO_INTENTS_BASE
  if (!INTENTS_READ_BASE_ALLOWED_PREFIXES.some((p) => override.startsWith(p))) {
    if (!warnedRejectedOverride) {
      warnedRejectedOverride = true
      console.warn(
        '[intents-base] ROZO_INTENTS_READ_BASE ignored: not a Rozo Intents host; using payment-api',
      )
    }
    return ROZO_INTENTS_BASE
  }
  return override.replace(/\/+$/, '')
}

/** Test hook: re-arm the one-time warning. */
export function resetIntentsReadBaseWarning(): void {
  warnedRejectedOverride = false
}

/**
 * True only when a 404 is intents' own "no such payment" answer
 * (errorResponse('paymentNotFound', ...) in rozo-intents-api
 * payment-api/payment-response.ts: {"error":{"code":"paymentNotFound",...}}).
 *
 * Any other 404 (the Supabase platform's
 * {"code":"NOT_FOUND","message":"Requested function was not found"} when the
 * read base points at an undeployed function, a proxy page, non-JSON) is NOT
 * proof that the order slot is free, and callers must treat it as an error,
 * or they would create a duplicate order.
 */
export async function isIntentsPaymentNotFound(resp: Response): Promise<boolean> {
  if (resp.status !== 404) return false
  const body: any = await resp.json().catch(() => null)
  return body?.error?.code === 'paymentNotFound'
}
