/**
 * Contract-variant orderId helpers. The webhook normalizes every incoming
 * Rozo orderId through baseLinkIdOf before using it as a Coinbase link id or
 * a KV fulfillment key, so both sibling orders (classic + contract supersede)
 * share one per-link record and the invoice settles at most once.
 */

import { describe, it, expect } from 'vitest'
import { baseLinkIdOf, contractVariantIds } from '../src/mpp/contract-variant'

describe('contract-variant orderIds', () => {
  it('strips every variant suffix back to the Coinbase link id', () => {
    const linkId = 'paymentSession_1dcf2338-3b67-4966-98dc-fe2331ba0ef6'
    for (const variant of contractVariantIds(linkId)) {
      expect(baseLinkIdOf(variant)).toBe(linkId)
    }
  })

  it('leaves non-variant ids untouched', () => {
    expect(baseLinkIdOf('paymentSession_abc')).toBe('paymentSession_abc')
    expect(baseLinkIdOf('pl_abc123')).toBe('pl_abc123')
    expect(baseLinkIdOf('stripe_crypto_cpis_xyz')).toBe('stripe_crypto_cpis_xyz')
    expect(baseLinkIdOf('mpprouter-1234')).toBe('mpprouter-1234')
  })

  it('allocates versioned slots in a stable order', () => {
    expect(contractVariantIds('pl_x')).toEqual([
      'pl_x__contract',
      'pl_x__contract2',
      'pl_x__contract3',
    ])
  })

  it('strips only a trailing suffix, not one in the middle', () => {
    expect(baseLinkIdOf('pl___contract_extra')).toBe('pl___contract_extra')
  })
})
