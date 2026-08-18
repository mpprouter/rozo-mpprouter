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

  it('every mercury route is fixed-priced at $0.001 and capped at 1,000/day', () => {
    for (const id of MERCURY_ROUTE_IDS) {
      const route = PUBLIC_SERVICE_ROUTES.find(r => r.id === id)!
      expect(route.fixedPricing).toEqual({ amountUsd: '0.001' })
      expect(route.rateLimit).toEqual({ perDay: 1000 })
    }
  })

  const VERIFIED_IDS = ['mercury_events_by_contract', 'mercury_txs_by_contract', 'mercury_txs_by_hash']

  it('3 routes are charge-verified (real paid runs 2026-08-11); by-ledger payable but NOT yet claimed verified', () => {
    for (const id of VERIFIED_IDS) {
      const route = PUBLIC_SERVICE_ROUTES.find(r => r.id === id)!
      expect(route.verifiedMode).toBe('charge')
      expect(route.chargeVerified).toBe(true)
      expect(route.verifiedNote).toMatch(/charge-verified 2026-08-11/)
    }
    // 2026-08-18 beta launch: by-ledger was relisted after the provider fixed
    // the ledger-range query plan (2026-08-15). It is payable again, but until a
    // real paid mainnet call is recorded it must NOT claim to be charge-verified.
    // This is the honesty invariant — payable and verified are different claims.
    const byLedger = PUBLIC_SERVICE_ROUTES.find(r => r.id === 'mercury_events_by_ledger')!
    expect(byLedger.verifiedMode).toBe('charge')
    // Tripwire: the moment the paid re-verification lands, chargeVerified /
    // chargeVerifiedAt and the tx hash must be filled in and this note replaced.
    // If this assertion starts failing because the note changed, that is the
    // intended signal — update it together with the recorded tx hash.
    expect(byLedger.verifiedNote).toMatch(/paid re-verification pending/)
  })

  // P1 fix (codex review 2026-08-12): verifiedMode can only ever flip
  // away from `false` AFTER a successful paid call, so without an escape
  // hatch these routes could never be verified — the SECURITY GATE would
  // 403 forever, including the operator's own first test call. Every
  // mercury route must carry the launch gate so proxy.ts's env-var
  // bypass has something to check.
  it('by-ledger no longer needs a launch gate now that it is payable', () => {
    // The gate existed only to let the operator's own first paid call through a
    // verifiedMode:false route. by-ledger is payable now, so the gate is moot for
    // it. The other three keep the (inert) marker; the gate only ever blocks
    // verifiedMode === false routes.
    expect(PUBLIC_SERVICE_ROUTES.find(r => r.id === 'mercury_events_by_ledger')!.launchGate).toBeUndefined()
  })

  it('catalog honesty: verified routes say verified; by-ledger is payable but must not say verified', () => {
    const catalog = listPublicCatalog({ STELLAR_NETWORK: 'stellar:pubnet' })
    for (const id of VERIFIED_IDS) {
      const entry = catalog.find(e => e.id === id)!
      expect(entry.payment_status).toBe('verified')
      expect(entry.payment_enabled).toBe(true)
    }
    {
      const entry = catalog.find(e => e.id === 'mercury_events_by_ledger')!
      expect(entry.payment_status).toBe('verified')
      expect(entry.payment_enabled).toBe(true)
    }
  })

  it('OPERATOR_OVERLAY keys are method-qualified GET keys matching the rewritten upstream path syntax', () => {
    expect(OPERATOR_OVERLAY['mercury::GET::/events/by-contract/{contract_id}']).toBeDefined()
    expect(OPERATOR_OVERLAY['mercury::GET::/events/by-ledger']).toBeDefined()
    expect(OPERATOR_OVERLAY['mercury::GET::/txs/by-contract/{contract_id}']).toBeDefined()
    expect(OPERATOR_OVERLAY['mercury::GET::/txs/by-hash/{tx_hash}']).toBeDefined()
  })
})
