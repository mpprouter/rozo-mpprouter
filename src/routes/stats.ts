/**
 * GET /v1/stats?window=24h|7d|30d|90d|all — public per-service statistics.
 *
 * Feeds the /stats page. Defaults to 30d, matching the page's default view.
 *
 * Volume and call counts are published alongside the quality figures rather
 * than instead of them: reviewers asked for service quality, and our volume
 * is small enough that leading with it would invite a comparison against
 * ecosystem-wide scanners that measure a different thing. Both are here, and
 * neither is hidden.
 */

import { getStats } from '../services/stats'
import { ledgerRateLimit } from './ledger'
import { isMetricsWindow, type MetricsWindow } from '../services/route-metrics'
import type { Env } from '../index'

export async function handleStats(request: Request, env: Env): Promise<Response> {
  // Rate limited with the SAME limiter as /v1/ledger, and for the same
  // reason: this endpoint is unauthenticated and each uncached request fans
  // out across the order-ledger keyspace in MPP_STORE — the namespace that
  // also carries payment state. A client can defeat the Cache-Control header
  // by varying the query string, so without a server-side limit a handful of
  // requests per second amplifies into thousands of storage reads against
  // live payments. A stats page is never worth degrading settlement.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const verdict = await ledgerRateLimit(env, ip)
  if (verdict === 'throttle') {
    return new Response(
      JSON.stringify({ error: 'rate_limited', detail: '1 request per second.' }, null, 2),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
      },
    )
  }
  if (verdict === 'unavailable') {
    return new Response(
      JSON.stringify({ error: 'rate_limiter_unavailable' }, null, 2),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
      },
    )
  }

  const raw = new URL(request.url).searchParams.get('window') ?? '30d'
  if (!isMetricsWindow(raw)) {
    return new Response(
      JSON.stringify({ error: 'invalid_window', allowed: ['24h', '7d', '30d', '90d', 'all'] }, null, 2),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }
  const window: MetricsWindow = raw

  const payload = await getStats(env, window)
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
