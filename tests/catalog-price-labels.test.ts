/**
 * Catalog price labels must not lie to paying agents.
 *
 * Two regressions this guards against, both observed live on
 * 2026-07-31 (see docs/service-probe-2026-07-31.md):
 *
 *   1. Dynamically-priced endpoints advertised as "free". Tavily
 *      search said `free` and its live 402 asked $0.09; Dune SQL
 *      execute said `free` and billed $4 on a `SELECT 1`.
 *   2. Prices floored to 3 decimal places. mapbox geocode-forward
 *      charges $0.00375 and advertised `$0.003`; every sub-$0.001
 *      route advertised `$0.000`, indistinguishable from free.
 */
import { describe, expect, it } from 'vitest'
import { buildRoutesFromMppSnapshot } from '../src/services/build-routes'

function snapshotWith(payment: Record<string, unknown> | null) {
  return {
    services: [
      {
        id: 'acme',
        name: 'Acme',
        serviceUrl: 'https://acme.example',
        status: 'active',
        endpoints: [{ method: 'POST', path: '/v1/thing', payment }],
      },
    ],
  } as any
}

function priceOf(payment: Record<string, unknown> | null): string | undefined {
  const routes = buildRoutesFromMppSnapshot(snapshotWith(payment), {}) as any[]
  return routes[0]?.price
}

const base = { intent: 'charge', method: 'tempo', decimals: 6 }

describe('catalog price labels', () => {
  it('never labels a dynamically-priced endpoint "free"', () => {
    const price = priceOf({ ...base, dynamic: true, amountHint: '$0.05-$4' })
    expect(price).not.toBe('free')
    expect(price).toContain('$0.05-$4')
    expect(price).toContain('dynamic')
  })

  it('says "dynamic" when the merchant gives no range', () => {
    expect(priceOf({ ...base, dynamic: true })).toBe('dynamic')
    // No amount at all is the same promise: priced at call time.
    expect(priceOf({ ...base })).toBe('dynamic')
  })

  it('does not floor sub-cent prices to $0.003 / $0.000', () => {
    // mapbox geocode-forward, real snapshot value
    expect(priceOf({ ...base, amount: '3750' })).toBe('$0.00375/request')
    // alchemy rpc / storage upload, real snapshot values
    expect(priceOf({ ...base, amount: '100' })).toBe('$0.0001/request')
    expect(priceOf({ ...base, amount: '10' })).toBe('$0.00001/request')
  })

  it('keeps existing whole-tenth-of-a-cent labels stable', () => {
    expect(priceOf({ ...base, amount: '2000' })).toBe('$0.002/request')
    expect(priceOf({ ...base, amount: '60000' })).toBe('$0.060/request')
    expect(priceOf({ ...base, amount: '1000000' })).toBe('$1.000/request')
  })

  it('appends /request only to bare amounts and ranges', () => {
    // Real snapshot hints. Dune, dripstack: bare range → needs a unit.
    expect(priceOf({ ...base, dynamic: true, amountHint: '$0.05-$4' }))
      .toBe('$0.05-$4/request (dynamic)')
    // En-dash and a leading tilde are both live in the snapshot.
    expect(priceOf({ ...base, dynamic: true, amountHint: '~$0.001–$0.02' }))
      .toBe('~$0.001–$0.02/request (dynamic)')
    expect(priceOf({ ...base, dynamic: true, amountHint: '$1–$100' }))
      .toBe('$1–$100/request (dynamic)')
  })

  it('never double-labels a hint that already states its unit', () => {
    // These six read "$0.12/hr/request" and "$0.01/result/request" in
    // production until 2026-07-31 — a different lie about what a call
    // costs than the "free" one this file's other tests guard.
    expect(priceOf({ ...base, dynamic: true, amountHint: '$0.12/hr' }))
      .toBe('$0.12/hr (dynamic)')
    expect(priceOf({ ...base, dynamic: true, amountHint: '$0.01/result' }))
      .toBe('$0.01/result (dynamic)')
    expect(priceOf({ ...base, dynamic: true, amountHint: '$0.008/org' }))
      .toBe('$0.008/org (dynamic)')
    expect(
      priceOf({ ...base, dynamic: true, amountHint: '~$0.005 per 1,000 characters' }),
    ).toBe('~$0.005 per 1,000 characters (dynamic)')
  })

  it('leaves prose hints alone', () => {
    // "Varies by TLD/request" is not English.
    expect(priceOf({ ...base, dynamic: true, amountHint: 'Varies by TLD' }))
      .toBe('Varies by TLD (dynamic)')
    expect(priceOf({ ...base, dynamic: true, amountHint: 'Model-dependent' }))
      .toBe('Model-dependent (dynamic)')
  })

  it('still calls a genuinely zero-priced endpoint free', () => {
    expect(priceOf({ ...base, amount: '0' })).toBe('free')
    expect(priceOf(null)).toBeUndefined() // no payment → route is skipped
  })
})
