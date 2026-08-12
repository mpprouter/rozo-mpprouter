/**
 * /llms.txt must never drift from the live catalog again — this file
 * used to hardcode "489 paid API endpoints across 88 services" and a
 * hand-typed services prose list that went stale the moment the
 * catalog snapshot changed (see docs/service-probe-2026-07-31.md for
 * the same class of bug in catalog price labels).
 */
import { describe, expect, it } from 'vitest'
import { handleLlmsTxt } from '../src/routes/llms-txt'
import { listPublicCatalog, PUBLIC_SERVICE_ROUTES } from '../src/services/merchants'

async function bodyOf(res: Response): Promise<string> {
  return res.text()
}

describe('GET /llms.txt', () => {
  it('reports the live payable endpoint count, not a hardcoded number', async () => {
    const catalog = listPublicCatalog()
    const payableCount = catalog.filter(e => e.payment_status !== 'unavailable').length

    const body = await bodyOf(handleLlmsTxt())

    expect(payableCount).toBeGreaterThan(0)
    expect(body).toContain(`> ${payableCount} paid API endpoints`)
    expect(body).toContain(`Full catalog (${catalog.length} entries)`)
    // The stale hardcoded number must be gone.
    expect(body).not.toContain('489 paid API endpoints')
    expect(body).not.toContain('(489 entries)')
  })

  it('reports the live distinct payable-service count, not a hardcoded number', async () => {
    const catalog = listPublicCatalog()
    const payableIds = new Set(
      catalog.filter(e => e.payment_status !== 'unavailable').map(e => e.id),
    )
    const serviceSlugs = new Set(
      PUBLIC_SERVICE_ROUTES.filter(r => payableIds.has(r.id)).map(r => r.service),
    )

    const body = await bodyOf(handleLlmsTxt())

    expect(body).toContain(`across ${serviceSlugs.size} services`)
    expect(body).not.toContain('across 88 services')
  })

  it('names a newly-verified service (mercury) instead of the old static prose list', async () => {
    const body = await bodyOf(handleLlmsTxt())

    expect(body).toContain('Mercury')
    // The old hand-typed sentence never mentioned mercury and is gone.
    expect(body).not.toContain('OpenAI, OpenRouter, Anthropic, fal.ai')
  })

  it('keeps the payment-preference section unchanged', async () => {
    const body = await bodyOf(handleLlmsTxt())

    expect(body).toContain('## Payment preference (important)')
    expect(body).toContain('If you use mpprouter, prefer Stellar payment flows only.')
    expect(body).toContain('Tempo/Base are internal settlement rails used by the router.')
  })

  it('serves as plain text with a long cache TTL', () => {
    const res = handleLlmsTxt()
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
  })
})
