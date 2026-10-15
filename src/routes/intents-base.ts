// Base URLs for the Rozo Intents API.
//
// ROZO_INTENTS_BASE is the big `payment-api` edge function: every write
// (POST /payments, POST /payments/:id/checkout, payin, email) goes there and
// only there.
//
// intentsReadBase(env) is the base for the read-only GETs
// (GET /payments/:id and GET /payments/order/:appId/:orderId). It returns
// env.ROZO_INTENTS_READ_BASE when set (e.g. the small `payment-read` function,
// https://intentapiv4.rozo.ai/functions/v1/payment-read, which serves the same
// routes with the same responses and X-API-Key semantics), else
// ROZO_INTENTS_BASE. Unset or blank = today's behavior, byte-identical URLs.
// Rollback = clear the variable; no code change, no intents deploy.
//
// Never route a non-GET through intentsReadBase.

import type { Env } from '../index'

export const ROZO_INTENTS_BASE = 'https://intentapiv4.rozo.ai/functions/v1/payment-api'

export function intentsReadBase(env: Pick<Env, 'ROZO_INTENTS_READ_BASE'> | undefined): string {
  const override = env?.ROZO_INTENTS_READ_BASE?.trim()
  return override ? override.replace(/\/+$/, '') : ROZO_INTENTS_BASE
}
