import type { Env } from '../index'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (aa.length !== bb.length) return false
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean }
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(aa, bb)
  let diff = 0
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i]
  return diff === 0
}

function authorized(request: Request, env: Env): boolean {
  const value = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  return !!env.USAGE_READ_TOKEN && !!value && timingSafeEqualString(value, env.USAGE_READ_TOKEN)
}

function maskWallet(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 12) return null
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function period(url: URL): { from: number; to: number } {
  const to = Math.min(Number(url.searchParams.get('to')) || Date.now(), Date.now())
  const from = Number(url.searchParams.get('from')) || to - 30 * 24 * 60 * 60 * 1000
  return { from: Math.max(0, from), to: Math.max(from, to) }
}

export async function handleUsageLogs(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json(401, { error: 'Unauthorized' })
  if (!env.COUPON_SECURITY_DB) return json(503, { error: 'Usage database is not configured' })
  const url = new URL(request.url)
  const { from, to } = period(url)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500)
  const result = await env.COUPON_SECURITY_DB.prepare(`
    SELECT event_id, request_id, created_at, wallet_address, requested_model, actual_model,
      provider, fallback_reason, input_tokens, output_tokens, cached_tokens,
      input_price_per_million_usd, output_price_per_million_usd,
      cache_price_per_million_usd, quoted_amount_usd, upstream_cost_usd,
      CASE WHEN quoted_amount_usd IS NULL OR upstream_cost_usd IS NULL THEN NULL
        ELSE CAST(quoted_amount_usd AS REAL) - CAST(upstream_cost_usd AS REAL) END AS margin_usd,
      settlement_ref, channel_cursor_before, channel_cursor_after, status,
      reconciliation_status
    FROM llm_facade_requests WHERE created_at BETWEEN ? AND ?
    ORDER BY created_at DESC LIMIT ?
  `).bind(from, to, limit).all<Record<string, unknown>>()
  return json(200, { from, to, data: (result.results ?? []).map(row => ({ ...row, wallet_address: maskWallet(row.wallet_address) })) })
}

export async function handleUsageActivity(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json(401, { error: 'Unauthorized' })
  if (!env.COUPON_SECURITY_DB) return json(503, { error: 'Usage database is not configured' })
  const { from, to } = period(new URL(request.url))
  const totals = await env.COUPON_SECURITY_DB.prepare(`
    SELECT COUNT(*) AS requests,
      SUM(CASE WHEN status IN ('settled','fallback_used') THEN 1 ELSE 0 END) AS settled_requests,
      SUM(CASE WHEN status='passthrough' THEN 1 ELSE 0 END) AS passthrough_requests,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_requests,
      SUM(CASE WHEN fallback_reason IS NOT NULL THEN 1 ELSE 0 END) AS fallback_requests,
      SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS usage_unknown_requests,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cached_tokens) AS cached_tokens,
      SUM(CAST(quoted_amount_usd AS REAL)) AS total_spend_usd,
      SUM(CASE WHEN quoted_amount_usd IS NULL OR upstream_cost_usd IS NULL THEN NULL
        ELSE CAST(quoted_amount_usd AS REAL) - CAST(upstream_cost_usd AS REAL) END) AS total_margin_usd
    FROM llm_facade_requests WHERE created_at BETWEEN ? AND ?
  `).bind(from, to).first<Record<string, number | null>>()
  const byModel = await env.COUPON_SECURITY_DB.prepare(`
    SELECT actual_model, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens, SUM(CAST(quoted_amount_usd AS REAL)) AS spend_usd
    FROM llm_facade_requests WHERE created_at BETWEEN ? AND ? GROUP BY actual_model ORDER BY spend_usd DESC
  `).bind(from, to).all()
  const byProvider = await env.COUPON_SECURITY_DB.prepare(`
    SELECT provider, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens, SUM(CAST(quoted_amount_usd AS REAL)) AS spend_usd
    FROM llm_facade_requests WHERE created_at BETWEEN ? AND ? GROUP BY provider ORDER BY spend_usd DESC
  `).bind(from, to).all()
  const byWallet = await env.COUPON_SECURITY_DB.prepare(`
    SELECT wallet_address, COUNT(*) AS requests, SUM(CAST(quoted_amount_usd AS REAL)) AS spend_usd
    FROM llm_facade_requests WHERE created_at BETWEEN ? AND ? AND wallet_address IS NOT NULL
    GROUP BY wallet_address ORDER BY spend_usd DESC LIMIT 100
  `).bind(from, to).all<Record<string, unknown>>()
  const input = Number(totals?.input_tokens ?? 0)
  const output = Number(totals?.output_tokens ?? 0)
  const tokens = input + output
  const spend = Number(totals?.total_spend_usd ?? 0)
  return json(200, {
    from, to,
    totals: {
      ...totals,
      token_volume: tokens,
      cache_hit_rate: input > 0 ? Number(totals?.cached_tokens ?? 0) / input : null,
      blended_usd_per_million: tokens > 0 ? spend / tokens * 1_000_000 : null,
      fallback_rate: Number(totals?.requests ?? 0) > 0 ? Number(totals?.fallback_requests ?? 0) / Number(totals?.requests) : null,
    },
    usage_by_model: byModel.results ?? [],
    usage_by_provider: byProvider.results ?? [],
    top_wallets: (byWallet.results ?? []).map(row => ({ ...row, wallet_address: maskWallet(row.wallet_address) })),
  })
}
