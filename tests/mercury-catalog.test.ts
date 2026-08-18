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

  it('3 routes are charge-verified (real paid runs 2026-08-11); by-ledger stays gated', () => {
    for (const id of VERIFIED_IDS) {
      const route = PUBLIC_SERVICE_ROUTES.find(r => r.id === id)!
      expect(route.verifiedMode).toBe('charge')
      expect(route.chargeVerified).toBe(true)
      expect(route.verifiedNote).toMatch(/charge-verified 2026-08-11/)
    }
    expect(PUBLIC_SERVICE_ROUTES.find(r => r.id === 'mercury_events_by_ledger')!.verifiedMode).toBe(false)
  })

  // P1 fix (codex review 2026-08-12): verifiedMode can only ever flip
  // away from `false` AFTER a successful paid call, so without an escape
  // hatch these routes could never be verified — the SECURITY GATE would
  // 403 forever, including the operator's own first test call. Every
  // mercury route must carry the launch gate so proxy.ts's env-var
  // bypass has something to check.
  it('every mercury route carries the MERCURY_LAUNCH_MODE launch gate', () => {
    for (const id of MERCURY_ROUTE_IDS) {
      const route = PUBLIC_SERVICE_ROUTES.find(r => r.id === id)!
      expect(route.launchGate).toBe('MERCURY_LAUNCH_MODE')
    }
  })

  it('catalog honesty: verified routes payable, by-ledger unavailable', () => {
    const catalog = listPublicCatalog({ STELLAR_NETWORK: 'stellar:pubnet' })
    for (const id of VERIFIED_IDS) {
      const entry = catalog.find(e => e.id === id)!
      expect(entry.payment_status).toBe('verified')
      expect(entry.payment_enabled).toBe(true)
    }
    {
      const entry = catalog.find(e => e.id === 'mercury_events_by_ledger')!
      expect(entry.payment_status).toBe('unavailable')
      expect(entry.payment_enabled).toBe(false)
      expect(entry.methods.stellar).toBeUndefined()
    }
  })

  // Provider feedback (Federico De Ponti, xycloo Labs, 2026-08-13): Mercury
  // does serve an llms.txt at docs.mercurydata.app/llms.txt. Wiring it into
  // the snapshot's service-level `docs` is what clears the `limited /
  // llms_txt not available` flag, because `listPublicCatalog` computes
  // `status` as `route.docs?.llmsTxt ? 'active' : 'limited'`. This locks in
  // that the docs link survives future `refresh-mpp-snapshot` runs.
  it('all 4 mercury routes are status "active" with no llms_txt caveat', () => {
    const catalog = listPublicCatalog({ STELLAR_NETWORK: 'stellar:pubnet' })
    for (const id of MERCURY_ROUTE_IDS) {
      const entry = catalog.find(e => e.id === id)!
      expect(entry.status).toBe('active')
      expect(entry.status_note).toBeUndefined()
    }
  })

  it('the llms.txt link that clears the flag is threaded onto every mercury route', () => {
    for (const id of MERCURY_ROUTE_IDS) {
      const route = PUBLIC_SERVICE_ROUTES.find(r => r.id === id)!
      expect(route.docs?.llmsTxt).toBe('https://docs.mercurydata.app/llms.txt')
    }
  })

  // by-ledger relisting is blocked on a real paid mainnet call (founder-only
  // — see docs/verified-services.md). This test is the tripwire: it fails the
  // moment someone flips the route to listed, so the flip cannot land without
  // also updating the verification record here.
  it('by-ledger stays delisted until the paid re-verification is actually run', () => {
    const route = PUBLIC_SERVICE_ROUTES.find(r => r.id === 'mercury_events_by_ledger')!
    expect(route.verifiedMode).toBe(false)
    expect(route.chargeVerified ?? false).toBe(false)
    expect(route.verifiedNote).toMatch(/DISABLED pending re-verification/)
  })

  it('OPERATOR_OVERLAY keys are method-qualified GET keys matching the rewritten upstream path syntax', () => {
    expect(OPERATOR_OVERLAY['mercury::GET::/events/by-contract/{contract_id}']).toBeDefined()
    expect(OPERATOR_OVERLAY['mercury::GET::/events/by-ledger']).toBeDefined()
    expect(OPERATOR_OVERLAY['mercury::GET::/txs/by-contract/{contract_id}']).toBeDefined()
    expect(OPERATOR_OVERLAY['mercury::GET::/txs/by-hash/{tx_hash}']).toBeDefined()
  })
})
