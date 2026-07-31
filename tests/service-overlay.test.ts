import { describe, it, expect } from 'vitest'
import { buildRoutesFromMppSnapshot } from '../src/services/build-routes'
import { PUBLIC_SERVICE_ROUTES } from '../src/services/merchants'

const snapshot = {
  services: [
    {
      id: 'brokenco',
      name: 'BrokenCo',
      serviceUrl: 'https://api.brokenco.example',
      categories: ['data'],
      endpoints: [
        { path: '/a', method: 'POST', description: 'a', payment: { amount: '10000' } },
        { path: '/b', method: 'POST', description: 'b', payment: { amount: '20000' } },
      ],
    },
  ],
} as any

describe('SERVICE_OVERLAY (service-level operator overlay)', () => {
  it('applies to every route of the service, not just one', () => {
    const routes = buildRoutesFromMppSnapshot(snapshot, {}, {
      brokenco: { verifiedMode: false, verifiedNote: 'upstream down' },
    })
    expect(routes).toHaveLength(2)
    expect(routes.every((r) => r.verifiedMode === false)).toBe(true)
    expect(routes.every((r) => r.verifiedNote === 'upstream down')).toBe(true)
  })

  it('loses to a per-route overlay entry, which stays authoritative', () => {
    const routes = buildRoutesFromMppSnapshot(
      snapshot,
      { 'brokenco::/a': { verifiedMode: 'charge' } },
      { brokenco: { verifiedMode: false } },
    )
    const a = routes.find((r) => r.upstreamPath === '/a')
    const b = routes.find((r) => r.upstreamPath === '/b')
    expect(a?.verifiedMode).toBe('charge')
    expect(b?.verifiedMode).toBe(false)
  })

  it('is inert for services it does not name', () => {
    const routes = buildRoutesFromMppSnapshot(snapshot, {}, {
      someoneelse: { verifiedMode: false },
    })
    expect(routes.every((r) => r.verifiedMode === undefined)).toBe(true)
  })
})

describe('nansen is disabled provider-wide', () => {
  // 2026-07-31: 10/10 probed routes returned 502 "Merchant returned 402
  // without WWW-Authenticate header" — no payment can be constructed, so
  // advertising them as payable spends the caller's money and trust.
  const nansen = PUBLIC_SERVICE_ROUTES.filter((r) => r.service === 'nansen')

  it('still lists its routes (disabled, not deleted)', () => {
    expect(nansen.length).toBe(45)
  })

  it('marks every one unpayable', () => {
    expect(nansen.filter((r) => r.verifiedMode !== false)).toHaveLength(0)
  })

  it('says why, so the next operator can re-probe rather than guess', () => {
    expect(nansen[0]?.verifiedNote).toMatch(/WWW-Authenticate/)
  })
})
