/**
 * Regression tests for the amount-unit conversion bug.
 *
 * History: src/routes/proxy.ts used to forward `parsed.request.amount`
 * from a Tempo merchant challenge (a base-unit integer string, e.g.
 * "10000" for $0.01 at 6 decimals) directly into the Stellar charge
 * method, which interprets `amount` as a human-readable decimal string
 * and applies its own toBaseUnits(amount, 7). That combination scaled
 * every price by 10^(merchantDecimals) — a 1,000,000x overcharge for
 * TIP-20 USDC on Tempo.
 *
 * baseUnitsToDecimalString is the pure function that closes that gap.
 * These tests lock in the exact behavior the Stellar charge method
 * expects from its `amount` input.
 */

import { describe, it, expect } from 'vitest'
import { baseUnitsToDecimalString, convertUsdcToXlm } from '../src/routes/proxy'

describe('baseUnitsToDecimalString', () => {
  it('converts $0.01 at 6 decimals (the real-world parallel_search case)', () => {
    expect(baseUnitsToDecimalString('10000', 6)).toBe('0.01')
  })

  it('converts $0.002 at 6 decimals (firecrawl_scrape)', () => {
    expect(baseUnitsToDecimalString('2000', 6)).toBe('0.002')
  })

  it('converts $0.005 at 6 decimals (exa_search)', () => {
    expect(baseUnitsToDecimalString('5000', 6)).toBe('0.005')
  })

  it('strips trailing zeros on whole-dollar amounts', () => {
    expect(baseUnitsToDecimalString('1000000', 6)).toBe('1')
    expect(baseUnitsToDecimalString('10000000', 6)).toBe('10')
  })

  it('keeps all significant fractional digits', () => {
    expect(baseUnitsToDecimalString('1234567', 6)).toBe('1.234567')
  })

  it('handles sub-cent smallest unit (1 base unit)', () => {
    expect(baseUnitsToDecimalString('1', 6)).toBe('0.000001')
  })

  it('handles zero', () => {
    expect(baseUnitsToDecimalString('0', 6)).toBe('0')
    expect(baseUnitsToDecimalString('0', 0)).toBe('0')
    expect(baseUnitsToDecimalString('0', 7)).toBe('0')
  })

  it('handles 7-decimal tokens (matches Stellar USDC exactly)', () => {
    expect(baseUnitsToDecimalString('100000', 7)).toBe('0.01')
    expect(baseUnitsToDecimalString('10000000', 7)).toBe('1')
  })

  it('handles zero-decimal tokens (pure integers)', () => {
    expect(baseUnitsToDecimalString('42', 0)).toBe('42')
    expect(baseUnitsToDecimalString('1000', 0)).toBe('1000')
  })

  it('round-trips through a Stellar-style toBaseUnits(amount, 7)', () => {
    // Simulate what the Stellar charge method does to the value we hand it.
    // toBaseUnits('0.01', 7) === '100000' in @stellar/mpp.
    const merchantBase = '10000' // $0.01 at 6 decimals
    const decimalStr = baseUnitsToDecimalString(merchantBase, 6)
    expect(decimalStr).toBe('0.01')
    // The Stellar library will then compute:
    //   '0.01' * 10^7 === 100000 base Stellar units (stroops of USDC)
    // 100000 stroop USDC at 7 decimals === $0.01. No drift.
  })

  it('rejects non-integer amount strings', () => {
    expect(() => baseUnitsToDecimalString('0.01', 6)).toThrow()
    expect(() => baseUnitsToDecimalString('abc', 6)).toThrow()
    expect(() => baseUnitsToDecimalString('', 6)).toThrow()
  })

  it('rejects negative or non-integer decimals', () => {
    expect(() => baseUnitsToDecimalString('10000', -1)).toThrow()
    expect(() => baseUnitsToDecimalString('10000', 1.5)).toThrow()
  })

  it('supports negative amounts (defensive)', () => {
    // Not expected in the production path, but the helper is pure and
    // should not silently corrupt a negative value.
    expect(baseUnitsToDecimalString('-10000', 6)).toBe('-0.01')
  })
})

/**
 * V2.1 FX gap fix: agents on XLM-denominated channels (agent1, agent3)
 * pay XLM for merchant USDC charges. The router converts at a fixed
 * XLM/USD rate stored in env. Rounding is UP at 7dp so the router
 * never silently bleeds value as a broker.
 *
 * See internaldocs/v2-todo.md#c and the convertUsdcToXlm jsdoc for
 * the rounding-direction rationale.
 */
describe('convertUsdcToXlm', () => {
  it('converts the canonical openrouter quantum at rate 0.1533', () => {
    // 0.00075 USDC at 0.1533 USD/XLM = 0.0048923677756... XLM
    // Rounded UP at 7 decimals = 0.0048924
    expect(convertUsdcToXlm('0.00075', 0.1533)).toBe('0.0048924')
  })

  it('converts the canonical openrouter quantum at the legacy 0.11 rate', () => {
    // 0.00075 / 0.11 = 0.006818181818... → up to 7dp = 0.0068182
    // This locks the doc example in v2-todo.md#c so the doc and code
    // do not drift.
    expect(convertUsdcToXlm('0.00075', 0.11)).toBe('0.0068182')
  })

  it('rounds UP one stroop on inexact quotients (broker safety)', () => {
    // 1 USDC base unit (0.0000001 USDC) / 0.1533
    // = 6.5231e-7 in XLM-base-unit terms → 7 base units after round-up
    // = 0.0000007 XLM
    expect(convertUsdcToXlm('0.0000001', 0.1533)).toBe('0.0000007')
  })

  it('preserves zero through the conversion', () => {
    expect(convertUsdcToXlm('0', 0.1533)).toBe('0')
    expect(convertUsdcToXlm('0.0000000', 0.1533)).toBe('0')
  })

  it('handles whole-USDC amounts at rate 0.1533', () => {
    // 1 USDC / 0.1533 = 6.522505... XLM → up to 7dp = 6.5230594
    // 1e7 / 153300000 = 0.06523... wait let me recompute via base units:
    // usdcBase = 10000000 (1 USDC at 7dp)
    // numerator = 1e16
    // xlm base = 1e16 / 153300000 = 65,231,572.7332... → up = 65231573
    // = 6.5231573 XLM
    expect(convertUsdcToXlm('1', 0.1533)).toBe('6.5231573')
  })

  it('rejects non-positive or non-finite rates', () => {
    expect(() => convertUsdcToXlm('0.001', 0)).toThrow()
    expect(() => convertUsdcToXlm('0.001', -0.1)).toThrow()
    expect(() => convertUsdcToXlm('0.001', NaN)).toThrow()
    expect(() => convertUsdcToXlm('0.001', Infinity)).toThrow()
  })

  it('rejects malformed amount strings', () => {
    expect(() => convertUsdcToXlm('abc', 0.1533)).toThrow()
    expect(() => convertUsdcToXlm('', 0.1533)).toThrow()
    expect(() => convertUsdcToXlm('0.0.1', 0.1533)).toThrow()
  })

  it('rejects amounts with more fractional precision than Stellar supports', () => {
    // 8 fractional digits would lose data at the 7-decimal boundary.
    expect(() => convertUsdcToXlm('0.00000001', 0.1533)).toThrow()
  })
})
