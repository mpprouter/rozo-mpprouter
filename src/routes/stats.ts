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
import { isMetricsWindow, type MetricsWindow } from '../services/route-metrics'
import type { Env } from '../index'

export async function handleStats(request: Request, env: Env): Promise<Response> {
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
