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
import { handleProviderRegister } from '../src/routes/providers'
import { issueDashboardToken } from '../src/services/provider-dashboard-auth'
import { resetProviderCache, type ProviderRecord } from '../src/services/provider-registry'

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

describe('well-known tokens are bound to the declared payouts', () => {
  it('refuses a token issued for an address the registration does not declare', async () => {
    const e = env()
    const proof = await issueDomainProof(e, {
      providerId: 'agent402', url: 'https://agent402.tools', payTo: OTHER_ADDRESS,
    })
    await expect(resolveOwnershipProof(e, {
      providerId: 'agent402', digest: 'd', apiBaseUrl: 'https://agent402.tools',
      payouts: PAYOUTS, routes: ROUTES,
      body: { ownership_proof: { type: 'well_known', token: proof.token } },
    })).rejects.toThrow(/does not declare/)
  })

  it('refuses when a second payout address rides along unproven', async () => {
    // The token proves one address. Without this check it would also
    // publish every other address in the same registration.
    const e = env()
    const proof = await issueDomainProof(e, {
      providerId: 'agent402', url: 'https://agent402.tools', payTo: PROVIDER_ADDRESS,
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any) =>
      String(input).endsWith('.txt')
        ? new Response(proof.token, { status: 200 })
        : new Response('nope', { status: 404 })) as unknown as typeof fetch)
    await expect(resolveOwnershipProof(e, {
      providerId: 'agent402', digest: 'd', apiBaseUrl: 'https://agent402.tools',
      payouts: [...PAYOUTS, { network: 'eip155:8453', payTo: '0xdead', asset: 'USDC' }],
      routes: ROUTES,
      body: { ownership_proof: { type: 'well_known', token: proof.token } },
    })).rejects.toThrow(/eip155:8453/)
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
  })

  it('treats a record with no recorded proof as signature-established', () => {
    // Every record written before proofs were pluralised was signed.
    // Reading the missing marker as "weak" would open the takeover this
    // function exists to close, through the one door nobody would check.
    expect(() => assertNoProofDowngrade(undefined, 'well_known', true)).toThrow(/wallet signature/)
    expect(() => assertNoProofDowngrade(undefined, 'wallet_signature', true)).not.toThrow()
    // No existing record at all: any proof may create one.
    expect(() => assertNoProofDowngrade(undefined, 'well_known', false)).not.toThrow()
    expect(() => assertNoProofDowngrade(undefined, 'x402_pay_to', false)).not.toThrow()
  })
})


// ---------------------------------------------------------------------
// Handler level: creating a record and changing one are different acts
// ---------------------------------------------------------------------

/** The ATOMIC_STORE CAS shim the rate limiter and proof store need. */
function withLimiter<T extends Record<string, any>>(base: T): T {
  const states = new Map<string, { value: string | null; version: number }>()
  const stub = {
    fetch: async (request: Request) => {
      const body = await request.json() as any
      const state = states.get(body.key) ?? { value: null, version: 0 }
      if (new URL(request.url).pathname === '/read') return Response.json(state)
      if (body.expectedVersion !== state.version) return Response.json({ ok: false, ...state })
      state.value = body.op === 'delete' ? null : body.value
      state.version += 1
      states.set(body.key, state)
      return Response.json({ ok: true })
    },
  }
  return Object.assign(base, { ATOMIC_STORE: { idFromName: () => ({}), get: () => stub } })
}

function registrationBody(extra: Record<string, unknown> = {}) {
  return {
    id: 'agent402',
    name: 'Agent402',
    email: 'mike@agent402.tools',
    api_base_url: 'https://agent402.tools',
    payouts: [{ network: 'stellar:pubnet', pay_to: PROVIDER_ADDRESS, asset: 'USDC' }],
    routes: [{ operation: 'stablecoin-peg', method: 'GET', upstream_path: '/api/stablecoin-peg', price_usd: '0.003' }],
    ...extra,
  }
}

function registerRequest(body: unknown, authorization?: string) {
  return new Request('https://router.test/v1/providers/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.7',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  })
}

function stellar402() {
  return challenge402([
    { scheme: 'exact', network: 'stellar:pubnet', amount: '30000', asset: 'CCW6', payTo: PROVIDER_ADDRESS },
  ])
}

describe('POST /v1/providers/register with a non-signature proof', () => {
  beforeEach(() => { resetProviderCache() })

  it('creates a new record from a live 402 match', async () => {
    const e = withLimiter(env())
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => stellar402()) as unknown as typeof fetch)
    const response = await handleProviderRegister(
      registerRequest(registrationBody({ ownership_proof: { type: 'x402_pay_to' } })), e,
    )
    expect(response.status).toBe(201)
    const body = await response.json() as any
    expect(body.ownership_proof.type).toBe('x402_pay_to')
    expect(body.status).toBe('pending')
    expect(body.verification.ownership_proof).toBe('x402_pay_to')
  })

  it('refuses to CHANGE an existing record without that record\'s dashboard token', async () => {
    // The takeover this closes: fetching a public 402 proves nothing about
    // the caller, so without a credential anyone could re-point an existing
    // provider's routes and origin and mint themselves a fresh dashboard
    // token in the process.
    const e = withLimiter(env())
    const credential = await issueDashboardToken()
    const existing: ProviderRecord = {
      id: 'agent402', name: 'Agent402', email: 'mike@agent402.tools',
      apiBaseUrl: 'https://agent402.tools',
      payouts: [{ network: 'stellar:pubnet', payTo: PROVIDER_ADDRESS, asset: 'USDC' }],
      routes: [{ operation: 'stablecoin-peg', method: 'GET', upstreamPath: '/api/stablecoin-peg', priceUsd: '0.003' }],
      status: 'published',
      verification: { ownershipProof: 'x402_pay_to' },
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
      ownerKey: { network: 'stellar:pubnet', address: PROVIDER_ADDRESS, proof: 'x402_pay_to' },
      dashboardTokenHash: credential.hash,
    }
    await e.MPP_STORE.put('provider:agent402', JSON.stringify(existing))
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => stellar402()) as unknown as typeof fetch)

    const denied = await handleProviderRegister(
      registerRequest(registrationBody({ ownership_proof: { type: 'x402_pay_to' } })), e,
    )
    expect(denied.status).toBe(401)
    expect(await denied.json()).toMatchObject({ error: 'unauthorized' })
    // The stored record is untouched.
    expect(JSON.parse((await e.MPP_STORE.get('provider:agent402'))!).updatedAt)
      .toBe('2026-09-05T00:00:00.000Z')

    const authorised = await handleProviderRegister(
      registerRequest(
        registrationBody({ ownership_proof: { type: 'x402_pay_to' } }),
        `Bearer ${credential.token}`,
      ),
      e,
    )
    expect(authorised.status).toBe(201)
  })

  it('refuses a weak proof over a record that predates the proof marker', async () => {
    const e = withLimiter(env())
    const legacy: ProviderRecord = {
      id: 'agent402', name: 'Agent402', email: 'mike@agent402.tools',
      apiBaseUrl: 'https://agent402.tools',
      payouts: [{ network: 'stellar:pubnet', payTo: PROVIDER_ADDRESS, asset: 'USDC' }],
      routes: [{ operation: 'stablecoin-peg', method: 'GET', upstreamPath: '/api/stablecoin-peg', priceUsd: '0.003' }],
      status: 'published', verification: {},
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      // No `proof` marker: written before proofs were pluralised, so it was
      // established by a wallet signature.
      ownerKey: { network: 'stellar:pubnet', address: PROVIDER_ADDRESS },
    }
    await e.MPP_STORE.put('provider:agent402', JSON.stringify(legacy))
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => stellar402()) as unknown as typeof fetch)
    const response = await handleProviderRegister(
      registerRequest(registrationBody({ ownership_proof: { type: 'x402_pay_to' } })), e,
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'proof_downgrade' })
  })
})
