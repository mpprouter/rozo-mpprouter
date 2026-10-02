import { describe, it, expect, vi, afterEach } from 'vitest'
import worker from '../src/index'
import * as overlay from '../src/services/catalog-overlay'
import { PUBLIC_SERVICE_ROUTES } from '../src/services/merchants'
import type { Env } from '../src/index'

/**
 * GET /v1/services/<provider> — free, read-only per-provider index of the
 * public catalog. Driven through `worker.fetch` so the routing order (paid
 * routes and reserved paths first, index only as the unknown-route
 * fallback) is covered, not just the handler.
 */

const env = {} as unknown as Env
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

const call = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://apiserver.mpprouter.dev${path}`, init), env, ctx)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /v1/services/<provider>', () => {
  it('returns the provider index with its public routes', async () => {
    const resp = await call('/v1/services/twocaptcha')
    expect(resp.status).toBe(200)
    expect(resp.headers.get('WWW-Authenticate')).toBeNull()
    const body: any = await resp.json()
    expect(body.id).toBe('twocaptcha')
    expect(typeof body.name).toBe('string')
    expect(typeof body.description).toBe('string')
    expect(body.route_count).toBe(body.routes.length)
    const create = body.routes.find((r: any) => r.public_path === '/v1/services/twocaptcha/createtask')
    expect(create).toBeDefined()
    expect(create.method).toBe('POST')
    for (const key of ['id', 'name', 'method', 'public_path', 'price', 'payment_enabled', 'status', 'docs_url']) {
      expect(create).toHaveProperty(key)
    }
  })

  it('accepts a trailing slash', async () => {
    const resp = await call('/v1/services/twocaptcha/')
    expect(resp.status).toBe(200)
  })

  it('matches the catalog exactly: same route set and same field values', async () => {
    const catalog: any = await (await call('/v1/services/catalog')).json()
    const fromCatalog = catalog.services.filter((s: any) => s.public_path.split('/')[3] === 'exa')
    expect(fromCatalog.length).toBeGreaterThan(1)

    const body: any = await (await call('/v1/services/exa')).json()
    expect(body.name).toBe('Exa')
    expect(body.routes.map((r: any) => r.id).sort()).toEqual(fromCatalog.map((s: any) => s.id).sort())
    for (const r of body.routes) {
      const c = fromCatalog.find((s: any) => s.id === r.id)
      for (const [k, v] of Object.entries(r)) expect(c[k]).toEqual(v)
    }
    // Upstream docs links come only from catalog `docs` objects.
    const catalogDocValues = new Set(fromCatalog.flatMap((s: any) => Object.values(s.docs ?? {})))
    for (const v of Object.values(body.docs)) expect(catalogDocValues.has(v)).toBe(true)
  })

  it('does not expose payment internals beyond the trimmed route fields', async () => {
    const body: any = await (await call('/v1/services/openai')).json()
    const text = JSON.stringify(body)
    expect(text).not.toContain('pay_to')
    expect(text).not.toContain('upstream')
  })

  it('keeps the 400 for an unknown provider', async () => {
    const resp = await call('/v1/services/doesnotexist123')
    expect(resp.status).toBe(400)
    const body: any = await resp.json()
    expect(body.error).toBe('Unknown public service route')
  })

  it('only answers GET', async () => {
    const resp = await call('/v1/services/twocaptcha', { method: 'POST', body: '{}' })
    expect(resp.status).toBe(400)
  })

  it('does not shadow reserved paths', async () => {
    const catalog = await call('/v1/services/catalog')
    expect(catalog.status).toBe(200)
    expect(((await catalog.json()) as any).services).toBeDefined()
    const search = await call('/v1/services/search?q=exa')
    expect(search.status).toBe(200)
    expect(((await search.json()) as any).routes).toBeUndefined()
  })

  it('never shadows operation paths', async () => {
    // Deeper paths are never an index, whatever the method.
    const resp = await call('/v1/services/twocaptcha/nosuchop')
    expect(resp.status).toBe(400)
  })

  it('loses to a paid route at the same single-segment path', async () => {
    const paid = PUBLIC_SERVICE_ROUTES.find(r => r.publicPath === '/v1/services/twocaptcha/createtask')!
    const spy = vi.spyOn(overlay, 'getRouteWithOverlay').mockImplementation(async (_env, pathname, method) =>
      pathname === '/v1/services/twocaptcha' && method === 'GET'
        ? { ...paid, publicPath: '/v1/services/twocaptcha', method: 'GET' as const, verifiedMode: false }
        : undefined,
    )
    const resp = await call('/v1/services/twocaptcha')
    expect(spy).toHaveBeenCalled()
    // The resolved paid route takes the payment path (here: blocked as
    // unverified-broken), never the free index.
    const body: any = await resp.json().catch(() => ({}))
    expect(body.routes).toBeUndefined()
    expect(resp.status).not.toBe(200)
  })

  it('no snapshot route currently has a single-segment public path', () => {
    const single = PUBLIC_SERVICE_ROUTES.filter(r => /^\/v1\/services\/[^/]+\/?$/.test(r.publicPath))
    expect(single).toEqual([])
  })
})
