/**
 * Bug 12 (2026-08-13): paywithlocus merchants wrap the provider body in
 * { success: true, data } — unwrapped at the parse seam so extraction sees the
 * provider shape and a paid 200 can never read as "no usable result".
 */
import { describe, expect, it } from 'vitest'
import { unwrapMerchantEnvelope } from '../src/playground/upstream'

describe('unwrapMerchantEnvelope', () => {
  it('unwraps the locus success envelope', () => {
    const inner = { choices: [{ message: { content: 'PONG' } }] }
    expect(unwrapMerchantEnvelope({ success: true, data: inner })).toBe(inner)
  })
  it('passes bare provider bodies through', () => {
    const bare = { choices: [{ message: { content: 'hi' } }] }
    expect(unwrapMerchantEnvelope(bare)).toBe(bare)
  })
  it('never unwraps error envelopes or non-objects', () => {
    const err = { success: false, error: 'nope' }
    expect(unwrapMerchantEnvelope(err)).toBe(err)
    expect(unwrapMerchantEnvelope(null)).toBe(null)
    expect(unwrapMerchantEnvelope('x')).toBe('x')
    const noData = { success: true }
    expect(unwrapMerchantEnvelope(noData)).toBe(noData)
  })
})
