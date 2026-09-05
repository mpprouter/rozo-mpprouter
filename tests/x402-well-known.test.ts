/**
 * `/.well-known/x402` — our own discovery manifest.
 *
 * The claims worth defending here are about honesty rather than shape:
 * a crawler reads this document instead of asking us, so every number in
 * it must be the number the router will actually charge, and anything we
 * do not sell must be unmistakably marked as such.
 */

import { describe, expect, it, beforeEach } from 'vitest'

import { handleX402WellKnown, buildX402WellKnown, toMinorUnits, fixedUsdFromPriceLabel } from '../src/routes/x402-well-known'
import { listCatalogWithOverlay } from '../src/services/catalog-overlay'
import { resetProviderCache } from '../src/services/provider-registry'
import { listThirdPartyDirectory, THIRD_PARTY_DIRECTORY } from '../src/services/third-party-directory'

const ROUTER_PAY_TO = 'GDK3AVEXAMPLEROUTERPOOLADDRESSFORTESTSONLYXXXXXXXXXXXXXX'

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) { return store.get(key) ?? null },
    async put(key: string, value: string) { store.set(key, value) },
    async list() { return { keys: [], list_complete: true, cursor: undefined } },
  }
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    MPP_STORE: makeKv(),
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_ROUTER_PUBLIC: ROUTER_PAY_TO,
    STELLAR_X402_PAY_TO: ROUTER_PAY_TO,
    X402_ENABLED: 'true',
    ...overrides,
  } as any
}

beforeEach(() => {
  resetProviderCache()
})

describe('price conversion', () => {
  it('reads a fixed price label and refuses a dynamic one', () => {
    expect(fixedUsdFromPriceLabel('$0.005/request')).toBe('0.005')
    expect(fixedUsdFromPriceLabel('dynamic')).toBeNull()
    expect(fixedUsdFromPriceLabel('$0.025+/request')).toBeNull()
  })

  it('converts to integer minor units without rounding', () => {
    expect(toMinorUnits('0.003', 7)).toBe('30000')
    expect(toMinorUnits('0.02', 7)).toBe('200000')
    expect(toMinorUnits('1', 7)).toBe('10000000')
    expect(toMinorUnits('0.02', 6)).toBe('20000')
  })

  it('refuses a price with more precision than the asset can express', () => {
    // Truncating here would advertise less than the 402 demands, and the
    // buyer would find out by having their payment rejected.
    expect(toMinorUnits('0.00000001', 7)).toBeNull()
  })
})

describe('the manifest describes our own catalog, not a hand-written list', () => {
  it('publishes the router-operated routes with the router pay_to and inline prices', async () => {
    const e = env()
    const doc = await buildX402WellKnown(e)
    const catalog = await listCatalogWithOverlay(e)
    const payable = catalog.filter(entry => entry.payment_enabled)

    expect(doc.counts.router_operated).toBe(payable.length)
    expect(doc.counts.router_operated).toBeGreaterThan(100)

    const priced = doc.resources.filter(r => r.settlement === 'pooled' && r.accepts.length > 0)
    expect(priced.length).toBeGreaterThan(0)
    for (const resource of priced.slice(0, 25)) {
      expect(resource.resource.startsWith('https://apiserver.mpprouter.dev/v1/services/')).toBe(true)
      expect(resource.accepts[0].payTo).toBe(ROUTER_PAY_TO)
      expect(resource.accepts[0].scheme).toBe('exact')
      expect(resource.accepts[0].network).toBe('stellar:pubnet')
      // The advertised amount must be the catalog price, not a rounded one.
      expect(resource.accepts[0].amount).toBe(toMinorUnits(resource.price_usd!, 7))
    }
  })

  it('advertises no x402 accept when x402 is disabled on this deployment', async () => {
    const doc = await buildX402WellKnown(env({ X402_ENABLED: 'false' }))
    const pooledWithAccepts = doc.resources.filter(
      r => r.settlement === 'pooled' && r.accepts.length > 0,
    )
    expect(pooledWithAccepts).toEqual([])
  })

  it('never publishes a route the proxy would refuse', async () => {
    const e = env()
    const doc = await buildX402WellKnown(e)
    const catalog = await listCatalogWithOverlay(e)
    // Keyed by method + path: one public path can carry both a payable GET
    // and an unavailable POST, so a URL-only comparison would report a
    // false positive.
    const broken = new Set(
      catalog
        .filter(entry => !entry.payment_enabled)
        .map(entry => `${entry.method} https://apiserver.mpprouter.dev${entry.public_path}`),
    )
    expect(broken.size).toBeGreaterThan(0)
    expect(doc.resources.filter(r => broken.has(`${r.method} ${r.resource}`))).toEqual([])
  })
})

describe('third-party directory entries are listed, never sold', () => {
  it('marks every directory entry unpayable through the router and points at the operator', async () => {
    const doc = await buildX402WellKnown(env())
    const directory = doc.resources.filter(r => r.payable_through_router === false)
    expect(directory.length).toBe(listThirdPartyDirectory().length)
    for (const resource of directory) {
      expect(resource.settlement).toBe('direct')
      expect(resource.operator?.name).toBeTruthy()
      // The buyer is sent to the provider's own origin. A router URL here
      // would promise a 402 we do not serve.
      expect(resource.resource.startsWith('https://apiserver.mpprouter.dev')).toBe(false)
      expect(resource.accepts.every(a => a.payTo !== ROUTER_PAY_TO)).toBe(true)
    }
  })

  it('lists the five approved Agent402 routes at their live prices', async () => {
    const doc = await buildX402WellKnown(env())
    const agent402 = doc.resources.filter(r => r.operator?.id === 'agent402')
    expect(agent402.map(r => r.price_usd).sort()).toEqual(
      ['0.003', '0.010', '0.010', '0.020', '0.020'],
    )
    expect(agent402.map(r => r.resource)).toEqual([
      'https://agent402.tools/api/stablecoin-peg',
      'https://agent402.tools/api/search',
      'https://agent402.tools/api/extract',
      'https://agent402.tools/api/render',
      'https://agent402.tools/api/pdf-to-markdown',
    ])
    // 0.003 USDC at Stellar's 7 decimals is what their live 402 advertises.
    const peg = agent402.find(r => r.price_usd === '0.003')!
    expect(peg.accepts[0]).toMatchObject({ network: 'stellar:pubnet', amount: '30000', decimals: 7 })
  })

  it('serves the whole document over HTTP with a cache header', async () => {
    const response = await handleX402WellKnown(env())
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toContain('max-age')
    const body = await response.json() as any
    expect(body.spec).toBe('https://x402.org/specs/x402-v2')
    expect(body.counts.total).toBe(body.resources.length)
  })
})

describe('directory data hygiene', () => {
  const BLACKLISTED = new Set([
    'GD2UZOA5RFWILHTPQL6CDTLIT6XPEGZQXJX4NWQC7ZU7DCEXK5NSQ2GH',
    'GAN3YSPDH5VW7YFJJFUJH7LIYTJBWGH3GJMKOG6FP5RKHXGNMPX44UYY',
    'GAIK5OR2FY4MVXVL4AZDJLAJT3MIJ5I6PAYARB2CATRRVACWFI7C6NHW',
    'GBQHLQMEPMBQEVFQXFAQ7EW54IVIC7VBGLTBCUJSRV7RUL7YAZ2CJ2IA',
  ])

  it('holds only well-formed, non-blacklisted payout addresses', () => {
    for (const provider of THIRD_PARTY_DIRECTORY) {
      expect(provider.payouts.length).toBeGreaterThan(0)
      for (const payout of provider.payouts) {
        if (payout.network.startsWith('stellar:')) {
          expect(payout.payTo).toMatch(/^G[A-Z2-7]{55}$/)
        }
        expect(BLACKLISTED.has(payout.payTo)).toBe(false)
      }
      // Every listing must name where the permission came from — a
      // directory entry without a provenance line is an unauthorised one.
      expect(provider.approval.source).toMatch(/\S/)
      expect(provider.approval.exclusive).toBe(false)
      for (const route of provider.routes) {
        expect(route.priceUsd).toMatch(/^\d+(\.\d{1,7})?$/)
        expect(new URL(route.resourceUrl).origin).toBe(new URL(provider.apiBaseUrl).origin)
      }
    }
  })
})
