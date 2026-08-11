/**
 * Mercury catalog materialization (snapshot + OPERATOR_OVERLAY → routes).
 *
 * Locks in that `build-routes.ts` actually threads the new
 * upstreamAuth/fixedPricing/rateLimit overlay fields onto the built
 * route objects — the whole payment-bypass machinery in proxy.ts is
 * inert if these three fields never reach `PublicServiceRoute`.
 */

import { describe, it, expect } from 'vitest'
import { PUBLIC_SERVICE_ROUTES, listPublicCatalog, OPERATOR_OVERLAY } from '../src/services/merchants'

const MERCURY_ROUTE_IDS = [
  'mercury_events_by_contract',
  'mercury_events_by_ledger',
  'mercury_txs_by_contract',
  'mercury_txs_by_hash',
]

describe('Mercury catalog materialization', () => {
  it('builds exactly the 4 proposed GET routes with the right public paths', () => {
    const mercuryRoutes = PUBLIC_SERVICE_ROUTES.filter(r => r.service === 'mercury')
    expect(mercuryRoutes).toHaveLength(4)
    expect(mercuryRoutes.map(r => r.id).sort()).toEqual([...MERCURY_ROUTE_IDS].sort())
    for (const r of mercuryRoutes) {
      expect(r.method).toBe('GET')
      expect(r.publicPath.startsWith('/v1/services/mercury/')).toBe(true)
    }
  })

  it('every mercury route carries upstreamAuth pointed at the mainnet JWT binding', () => {
    for (const id of MERCURY_ROUTE_IDS) {
      const route = PUBLIC_SERVICE_ROUTES.find(r => r.id === id)!
      expect(route.upstreamAuth).toEqual({
        secretBinding: 'MERCURYDATA_MAINNET_JWT',
        header: 'Authorization',
        scheme: 'bearer',
      })
    }
  })

  it('every mercury route is fixed-priced at $0.0005 and capped at 1,000/day', () => {
    for (const id of MERCURY_ROUTE_IDS) {
      const route = PUBLIC_SERVICE_ROUTES.find(r => r.id === id)!
      expect(route.fixedPricing).toEqual({ amountUsd: '0.0005' })
      expect(route.rateLimit).toEqual({ perDay: 1000 })
    }
  })

  it('ships verifiedMode:false until the first real paid run (per design doc §2.4)', () => {
    for (const id of MERCURY_ROUTE_IDS) {
      const route = PUBLIC_SERVICE_ROUTES.find(r => r.id === id)!
      expect(route.verifiedMode).toBe(false)
    }
  })

  it('the security gate therefore refuses payment on mercury routes until an operator flips verifiedMode', () => {
    // Catalog honesty check, same invariant as catalog-payment-gate.test.ts:
    // verifiedMode:false ⇒ no methods.stellar block, payment_status
    // 'unavailable', payment_enabled false.
    const catalog = listPublicCatalog({ STELLAR_NETWORK: 'stellar:pubnet' })
    for (const id of MERCURY_ROUTE_IDS) {
      const entry = catalog.find(e => e.id === id)!
      expect(entry.payment_status).toBe('unavailable')
      expect(entry.payment_enabled).toBe(false)
      expect(entry.methods.stellar).toBeUndefined()
    }
  })

  it('OPERATOR_OVERLAY keys are method-qualified GET keys matching the rewritten upstream path syntax', () => {
    expect(OPERATOR_OVERLAY['mercury::GET::/events/by-contract/{contract_id}']).toBeDefined()
    expect(OPERATOR_OVERLAY['mercury::GET::/events/by-ledger']).toBeDefined()
    expect(OPERATOR_OVERLAY['mercury::GET::/txs/by-contract/{contract_id}']).toBeDefined()
    expect(OPERATOR_OVERLAY['mercury::GET::/txs/by-hash/{tx_hash}']).toBeDefined()
  })
})
