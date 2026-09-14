/**
 * Mercury direct settlement (2026-09-14): with `MERCURYDATA_X402_ADDRESS`
 * set, the four mercury routes resolve as router-hosted paywalls whose
 * operator payout is Mercury's own Stellar address, the public catalog
 * says so, and the x402 challenge names Mercury rather than the pool.
 * Unset, everything is byte-for-byte the pooled route it was before.
 */

import { describe, it, expect, vi } from 'vitest'
import { PUBLIC_SERVICE_ROUTES, listPublicCatalog } from '../src/services/merchants'
import { withEnvDirectSettlement } from '../src/services/catalog-direct-settlement'
import { getRouteWithOverlay } from '../src/services/catalog-overlay'
import { buildX402PaymentRequiredHeader } from '../src/mpp/stellar-x402-server'

// Any well-formed key works for the unit: the real value is a Worker var.
const MERCURY_G = 'GC5KJLQ4XPGZ2VJ2QGGFQ7YB2MXLQ2W2VZ3C6QQGEZ2BJ3HZ4RR4MHC3'
const POOL_G = 'GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB'
const MERCURY_IDS = ['mercury_events_by_contract', 'mercury_events_by_ledger', 'mercury_txs_by_contract', 'mercury_txs_by_hash']

const mercuryRoutes = () => PUBLIC_SERVICE_ROUTES.filter(r => r.service === 'mercury')

const baseEnv = {
  STELLAR_NETWORK: 'stellar:pubnet',
  X402_ENABLED: 'true',
  STELLAR_X402_PAY_TO: POOL_G,
  STELLAR_ROUTER_PUBLIC: POOL_G,
  MPP_STORE: { get: async () => null, list: async () => ({ keys: [] }) },
} as any

describe('withEnvDirectSettlement', () => {
  it('every mercury route carries the directSettlement spec; no other snapshot route does', () => {
    expect(mercuryRoutes().map(r => r.id).sort()).toEqual([...MERCURY_IDS].sort())
    for (const r of mercuryRoutes()) {
      expect(r.directSettlement).toEqual({ providerId: 'mercurydata', providerName: 'Mercury Data', payToBinding: 'MERCURYDATA_X402_ADDRESS' })
      expect(r.operator).toBeUndefined()
      expect(r.hosted).toBeUndefined()
    }
    expect(PUBLIC_SERVICE_ROUTES.filter(r => r.directSettlement && r.service !== 'mercury')).toHaveLength(0)
  })

  it('binding unset → the route object is returned unchanged (pooled path)', () => {
    const route = mercuryRoutes()[0]
    expect(withEnvDirectSettlement(route, baseEnv)).toBe(route)
    expect(withEnvDirectSettlement(route, { ...baseEnv, MERCURYDATA_X402_ADDRESS: '' })).toBe(route)
  })

  it('binding set → hosted operator route paying Mercury on the configured network, credential kept', () => {
    const route = mercuryRoutes()[0]
    const direct = withEnvDirectSettlement(route, { ...baseEnv, MERCURYDATA_X402_ADDRESS: ` ${MERCURY_G} ` })
    expect(direct).not.toBe(route)
    expect(direct.hosted).toBe(true)
    expect(direct.operator).toEqual({
      id: 'mercurydata',
      name: 'Mercury Data',
      payouts: [{ network: 'stellar:pubnet', payTo: MERCURY_G, asset: 'USDC' }],
      verifiedAt: route.chargeVerifiedAt,
    })
    expect(direct.upstreamAuth).toEqual(route.upstreamAuth)
    expect(direct.fixedPricing).toEqual(route.fixedPricing)
    expect(direct.rateLimit).toEqual(route.rateLimit)
  })

  it('binding set to a non-Stellar value → operator with no payouts (proxy 503s), never the pool', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const direct = withEnvDirectSettlement(mercuryRoutes()[0], { ...baseEnv, MERCURYDATA_X402_ADDRESS: '0x1234' })
    expect(direct.hosted).toBe(true)
    expect(direct.operator?.payouts).toEqual([])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('a route that already has an operator is left alone', () => {
    const route = { ...mercuryRoutes()[0], operator: { id: 'x', name: 'x', payouts: [] } }
    expect(withEnvDirectSettlement(route, { ...baseEnv, MERCURYDATA_X402_ADDRESS: MERCURY_G })).toBe(route)
  })
})

describe('route resolution and catalog', () => {
  it('getRouteWithOverlay hands the proxy a hosted operator route for a mercury path', async () => {
    const env = { ...baseEnv, MERCURYDATA_X402_ADDRESS: MERCURY_G }
    const route = await getRouteWithOverlay(env, '/v1/services/mercury/txs/by-hash', 'GET')
    expect(route?.operator?.payouts[0]?.payTo).toBe(MERCURY_G)
    expect(route?.hosted).toBe(true)
    const pooled = await getRouteWithOverlay(baseEnv, '/v1/services/mercury/txs/by-hash', 'GET')
    expect(pooled?.operator).toBeUndefined()
  })

  it('listPublicCatalog: direct + router_paywall + Mercury pay_to when set; pooled hints when unset', () => {
    const on = listPublicCatalog({ ...baseEnv, MERCURYDATA_X402_ADDRESS: MERCURY_G })
    for (const id of MERCURY_IDS) {
      const e = on.find(x => x.id === id)!
      expect(e.settlement).toBe('direct')
      expect(e.settlement_mode).toBe('router_paywall')
      expect(e.operator).toMatchObject({ id: 'mercurydata', payouts: [{ network: 'stellar:pubnet', pay_to: MERCURY_G, asset: 'USDC' }] })
      expect(e.payment_hints?.pay_to).toBe(MERCURY_G)
      expect(e.payment_hints?.dialect).toBe('x402')
      expect(e.methods.stellar_x402).toBeUndefined()
      expect(JSON.stringify(e)).not.toContain(POOL_G)
    }
    const off = listPublicCatalog(baseEnv)
    for (const id of MERCURY_IDS) {
      const e = off.find(x => x.id === id)!
      expect(e.settlement).toBeUndefined()
      expect(e.operator).toBeUndefined()
      expect(e.payment_hints?.pay_to).toBe(POOL_G)
    }
    // Nothing else moved.
    const others = (c: any[]) => c.filter(x => !MERCURY_IDS.includes(x.id))
    expect(others(on)).toEqual(others(off))
  })

  it('the x402 challenge for a resolved mercury route names Mercury, not the pool', async () => {
    const env = { ...baseEnv, MERCURYDATA_X402_ADDRESS: MERCURY_G }
    const route = await getRouteWithOverlay(env, '/v1/services/mercury/txs/by-hash', 'GET')
    const header = buildX402PaymentRequiredHeader(env, 1000n, 'https://apiserver.mpprouter.dev/v1/services/mercury/txs/by-hash?tx_hash=abc', route!.operator)
    expect(header).toBeTruthy()
    const decoded = JSON.parse(Buffer.from(header!, 'base64').toString('utf8'))
    const accepts = decoded.accepts ?? decoded
    const json = JSON.stringify(accepts)
    expect(json).toContain(MERCURY_G)
    expect(json).not.toContain(POOL_G)
  })
})
