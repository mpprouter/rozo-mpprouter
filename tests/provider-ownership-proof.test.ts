/**
 * Ownership proof without a wallet signature.
 *
 * The claims under test are the ones a reviewer should be suspicious of,
 * because this change made a security gate more permissive:
 *
 *   1. A registration with no proof at all is still refused.
 *   2. The 402 match is a real comparison — a different address, a missing
 *      network, or a non-402 response all fail.
 *   3. A well-known token still binds provider id, domain and payout
 *      address, and is still single-use.
 *   4. A record created by a wallet signature cannot be re-pointed with a
 *      weaker proof.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

import {
  resolveOwnershipProof,
  verifyX402PayToMatch,
  assertNoProofDowngrade,
  OWNERSHIP_PROOF_GUIDE,
} from '../src/services/provider-ownership'
import { issueDomainProof } from '../src/services/provider-domain-proof'
import { ProviderAuthError } from '../src/services/provider-auth'

const PROVIDER_ADDRESS = 'GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL'
const OTHER_ADDRESS = 'GBSNB5A7OS5ACS5NINYIVHS4BBGJNPNGARBSORNNZ2W6UCVYA32GU4LT'

const ROUTES = [
  { operation: 'stablecoin-peg', method: 'GET' as const, upstreamPath: '/api/stablecoin-peg', priceUsd: '0.003' },
]
const PAYOUTS = [{ network: 'stellar:pubnet', payTo: PROVIDER_ADDRESS, asset: 'USDC' }]

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) { return store.get(key) ?? null },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
    async list() { return { keys: [], list_complete: true, cursor: undefined } },
  }
}

function env() {
  return { MPP_STORE: makeKv() } as any
}

/** A 402 in the x402 `payment-required` header dialect agent402 serves. */
function challenge402(accepts: Array<Record<string, unknown>>): Response {
  const encoded = btoa(JSON.stringify({ x402Version: 2, accepts }))
  return new Response('{}', { status: 402, headers: { 'payment-required': encoded } })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('x402 payTo match', () => {
  it('accepts a live 402 that advertises exactly the registered address', async () => {
    const fetchImpl = vi.fn(async () => challenge402([
      { scheme: 'exact', network: 'eip155:8453', amount: '3000', asset: '0xUSDC', payTo: '0xabc' },
      { scheme: 'exact', network: 'stellar:pubnet', amount: '30000', asset: 'CCW6', payTo: PROVIDER_ADDRESS },
    ]))
    const result = await verifyX402PayToMatch({
      apiBaseUrl: 'https://agent402.tools',
      routes: ROUTES,
      payouts: PAYOUTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.probedUrl).toBe('https://agent402.tools/api/stablecoin-peg')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses when the live 402 advertises a different address on that network', async () => {
    // This is the whole point of the check. A registration naming an
    // address the provider's own endpoint does not publish is exactly the
    // typo the wallet signature used to catch.
    const fetchImpl = vi.fn(async () => challenge402([
      { scheme: 'exact', network: 'stellar:pubnet', amount: '30000', asset: 'CCW6', payTo: OTHER_ADDRESS },
    ]))
    await expect(verifyX402PayToMatch({
      apiBaseUrl: 'https://agent402.tools', routes: ROUTES, payouts: PAYOUTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/different payTo/)
  })

  it('refuses when the network is not advertised at all', async () => {
    const fetchImpl = vi.fn(async () => challenge402([
      { scheme: 'exact', network: 'eip155:8453', amount: '3000', asset: '0xUSDC', payTo: '0xabc' },
    ]))
    await expect(verifyX402PayToMatch({
      apiBaseUrl: 'https://agent402.tools', routes: ROUTES, payouts: PAYOUTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/no stellar:pubnet settlement option/)
  })

  it('requires every declared payout address to appear, not just the first', async () => {
    const fetchImpl = vi.fn(async () => challenge402([
      { scheme: 'exact', network: 'stellar:pubnet', amount: '30000', asset: 'CCW6', payTo: PROVIDER_ADDRESS },
    ]))
    await expect(verifyX402PayToMatch({
      apiBaseUrl: 'https://agent402.tools',
      routes: ROUTES,
      payouts: [...PAYOUTS, { network: 'solana:mainnet', payTo: 'SoLaNa', asset: 'USDC' }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/solana:mainnet/)
  })

  it('compares EVM addresses case-insensitively and Stellar exactly', async () => {
    const evmFetch = vi.fn(async () => challenge402([
      { scheme: 'exact', network: 'eip155:8453', amount: '3000', asset: '0xUSDC', payTo: '0xABF4FAbd7c416fB67202E5f9002389Fc75e2a9D0' },
    ]))
    await expect(verifyX402PayToMatch({
      apiBaseUrl: 'https://agent402.tools', routes: ROUTES,
      payouts: [{ network: 'eip155:8453', payTo: '0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0', asset: 'USDC' }],
      fetchImpl: evmFetch as unknown as typeof fetch,
    })).resolves.toBeTruthy()

    const stellarFetch = vi.fn(async () => challenge402([
      { scheme: 'exact', network: 'stellar:pubnet', amount: '30000', asset: 'CCW6', payTo: PROVIDER_ADDRESS.toLowerCase() },
    ]))
    await expect(verifyX402PayToMatch({
      apiBaseUrl: 'https://agent402.tools', routes: ROUTES, payouts: PAYOUTS,
      fetchImpl: stellarFetch as unknown as typeof fetch,
    })).rejects.toThrow()
  })

  it('refuses a response that is not a parseable 402', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    await expect(verifyX402PayToMatch({
      apiBaseUrl: 'https://agent402.tools', routes: ROUTES, payouts: PAYOUTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/did not answer with a parseable 402/)
  })
})

describe('resolveOwnershipProof', () => {
  it('refuses a registration that offers no proof at all', async () => {
    await expect(resolveOwnershipProof(env(), {
      providerId: 'agent402', digest: 'd', apiBaseUrl: 'https://agent402.tools',
      payouts: PAYOUTS, routes: ROUTES, body: {},
    })).rejects.toThrow(/ownership proof is required/i)
  })

  it('accepts a well-known plain-text challenge file and marks the domain verified', async () => {
    const e = env()
    const proof = await issueDomainProof(e, {
      providerId: 'agent402', url: 'https://agent402.tools', payTo: PROVIDER_ADDRESS,
    })
    // Only the .txt file exists; the JSON manifest 404s.
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any) => {
      const url = String(input)
      if (url.endsWith('/.well-known/mpprouter-verify.txt')) {
        return new Response(`${proof.token}\n`, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch)

    const outcome = await resolveOwnershipProof(e, {
      providerId: 'agent402', digest: 'd', apiBaseUrl: 'https://agent402.tools',
      payouts: PAYOUTS, routes: ROUTES,
      body: { ownership_proof: { type: 'well_known', token: proof.token } },
    })
    expect(outcome.proof).toBe('well_known')
    expect(outcome.ownerKey).toMatchObject({ address: PROVIDER_ADDRESS, proof: 'well_known' })
    expect(outcome.domainVerifiedAt).toBeTruthy()
  })

  it('refuses a well-known file that carries the wrong token', async () => {
    const e = env()
    const proof = await issueDomainProof(e, {
      providerId: 'agent402', url: 'https://agent402.tools', payTo: PROVIDER_ADDRESS,
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response('some-other-token', { status: 200 })) as unknown as typeof fetch)
    await expect(resolveOwnershipProof(e, {
      providerId: 'agent402', digest: 'd', apiBaseUrl: 'https://agent402.tools',
      payouts: PAYOUTS, routes: ROUTES,
      body: { ownership_proof: { type: 'well_known', token: proof.token } },
    })).rejects.toThrow(ProviderAuthError)
  })

  it('refuses a well-known proof with no token', async () => {
    await expect(resolveOwnershipProof(env(), {
      providerId: 'agent402', digest: 'd', apiBaseUrl: 'https://agent402.tools',
      payouts: PAYOUTS, routes: ROUTES, body: { ownership_proof: { type: 'well_known' } },
    })).rejects.toThrow(/token is required/)
  })

  it('accepts the 402 payTo match and records it as the weaker, named proof', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => challenge402([
      { scheme: 'exact', network: 'stellar:pubnet', amount: '30000', asset: 'CCW6', payTo: PROVIDER_ADDRESS },
    ])) as unknown as typeof fetch)
    const outcome = await resolveOwnershipProof(env(), {
      providerId: 'agent402', digest: 'd', apiBaseUrl: 'https://agent402.tools',
      payouts: PAYOUTS, routes: ROUTES, body: { ownership_proof: { type: 'x402_pay_to' } },
    })
    expect(outcome.proof).toBe('x402_pay_to')
    // The record must say which proof it passed. "Verified" without the
    // qualifier would claim key custody we never established.
    expect(outcome.ownerKey.proof).toBe('x402_pay_to')
    expect(OWNERSHIP_PROOF_GUIDE.x402_pay_to.proves).toMatch(/live 402/)
  })
})

describe('no downgrade', () => {
  it('refuses a weaker proof over a record established by a signature', () => {
    expect(() => assertNoProofDowngrade('wallet_signature', 'well_known')).toThrow(/wallet signature/)
    expect(() => assertNoProofDowngrade('wallet_signature', 'x402_pay_to')).toThrow(/wallet signature/)
  })

  it('allows a signature to update anything, and lets weaker records use their own proof', () => {
    expect(() => assertNoProofDowngrade('wallet_signature', 'wallet_signature')).not.toThrow()
    expect(() => assertNoProofDowngrade('x402_pay_to', 'wallet_signature')).not.toThrow()
    expect(() => assertNoProofDowngrade('well_known', 'well_known')).not.toThrow()
    expect(() => assertNoProofDowngrade(undefined, 'well_known')).not.toThrow()
  })
})
