import { describe, expect, it, vi } from 'vitest'
import { handleUsageActivity, handleUsageLogs } from '../src/routes/usage-dashboard'
import type { Env } from '../src/index'

function request(path: string, token = 'secret'): Request {
  return new Request(`https://apiserver.mpprouter.dev${path}`, { headers: { Authorization: `Bearer ${token}` } })
}

describe('usage dashboard API', () => {
  it('fails closed without the admin credential', async () => {
    const response = await handleUsageLogs(request('/v1/usage/logs', 'wrong'), { USAGE_READ_TOKEN: 'secret' } as Env)
    expect(response.status).toBe(401)
  })

  it('masks wallet addresses in logs', async () => {
    const all = vi.fn().mockResolvedValue({ results: [{ wallet_address: '0x1234567890abcdef1234', request_id: 'r1' }] })
    const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ all })) })) }
    const response = await handleUsageLogs(request('/v1/usage/logs'), { USAGE_READ_TOKEN: 'secret', COUPON_SECURITY_DB: db } as unknown as Env)
    const body = await response.json() as { data: Array<{ wallet_address: string }> }
    expect(body.data[0].wallet_address).toBe('0x1234...1234')
  })

  it('reports unknown usage separately and derives comparable metrics', async () => {
    const first = vi.fn().mockResolvedValue({
      requests: 2, settled_requests: 1, passthrough_requests: 0, failed_requests: 1,
      fallback_requests: 1, usage_unknown_requests: 1, input_tokens: 80,
      output_tokens: 20, cached_tokens: 40, total_spend_usd: 0.01, total_margin_usd: 0.002,
    })
    const all = vi.fn().mockResolvedValue({ results: [] })
    const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first, all })) })) }
    const response = await handleUsageActivity(request('/v1/usage/activity'), { USAGE_READ_TOKEN: 'secret', COUPON_SECURITY_DB: db } as unknown as Env)
    const body = await response.json() as { totals: Record<string, number> }
    expect(body.totals.token_volume).toBe(100)
    expect(body.totals.cache_hit_rate).toBe(0.5)
    expect(body.totals.blended_usd_per_million).toBe(100)
    expect(body.totals.fallback_rate).toBe(0.5)
    expect(body.totals.usage_unknown_requests).toBe(1)
  })
})
