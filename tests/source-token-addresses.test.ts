/**
 * Source token addresses must equal rozo-intents' canonical registry
 * (supabase/functions/shared/canonical-token.ts). payment-api rejects any
 * non-canonical source.tokenAddress with a 400, so a stale entry here (e.g.
 * Polygon USDC.e instead of native USDC) breaks every order on that chain.
 */
import { describe, expect, it } from 'vitest'
import { resolveSource } from '../src/routes/create-invoice'
import { STABLE_SOURCES } from '../src/routes/native-sources'

// Copied from rozo-intents-api canonical-token.ts EVM_CHAIN_TOKENS on origin/main (2026-10-05).
const CANONICAL: Record<string, Record<string, string>> = {
  '1': {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  '137': {
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
  '42161': {
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  },
  '8453': { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
}

describe('stablecoin source addresses match rozo-intents canonical registry', () => {
  for (const [chainId, tokens] of Object.entries(CANONICAL)) {
    for (const [symbol, address] of Object.entries(tokens)) {
      it(`${symbol} on ${chainId}`, () => {
        expect(STABLE_SOURCES[chainId]).toContain(symbol)
        const r = resolveSource({ chainId, tokenSymbol: symbol })
        expect(r.error).toBeUndefined()
        expect(r.resolved?.tokenAddress.toLowerCase()).toBe(address.toLowerCase())
      })
    }
  }

  it('never resolves Polygon USDC to bridged USDC.e', () => {
    const r = resolveSource({ chainId: '137', tokenSymbol: 'USDC' })
    expect(r.resolved?.tokenAddress.toLowerCase()).not.toBe('0x2791bca1f2de4661ed88a30c99a7a9449aa84174')
  })
})
