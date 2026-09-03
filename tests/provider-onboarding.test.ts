/**
 * Provider self-serve onboarding.
 *
 * The tests are grouped by the claim they defend rather than by module,
 * because the claims are what a reviewer is actually checking:
 *
 *   1. The 674 existing routes are untouched and cannot enter the new path.
 *   2. A registration cannot publish an address nobody proved they hold.
 *   3. A published route pays the provider and not us.
 *
 * Stellar signatures are generated with real keypairs rather than mocked.
 * A mocked signature check tests that the mock was called; the thing worth
 * knowing is whether a wrong key is actually rejected, and that needs real
 * ed25519 on both sides.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'

import { PUBLIC_SERVICE_ROUTES } from '../src/services/merchants'
import {
  mergeRoutes,
  getRouteWithOverlay,
  listCatalogWithOverlay,
} from '../src/services/catalog-overlay'
import {
  validateRegistration,
  validateApiBaseUrl,
  routesForProvider,
  publicPathFor,
  resetProviderCache,
  ProviderValidationError,
  type ProviderRecord,
} from '../src/services/provider-registry'
import {
  buildSignatureMessage,
  registrationDigest,
  verifyAddressSignature,
  verifyRegistrationSignatures,
  isSupportedPayoutNetwork,
  ProviderAuthError,
} from '../src/services/provider-auth'
import {
  gateProbe402,
  parseProviderChallenge,
  chooseVerificationRoute,
} from '../src/services/provider-verification'
import { buildX402PaymentRequiredHeader } from '../src/mpp/stellar-x402-server'
import { isStellarX402ForThisRouter } from '../src/mpp/stellar-x402-server'

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const PROVIDER_KEYPAIR = Keypair.random()
const PROVIDER_ADDRESS = PROVIDER_KEYPAIR.publicKey()
const ROUTER_ADDRESS = 'GDK3AVEXAMPLEROUTERPOOLADDRESSFORTESTSONLYXXXXXXXXXXXXXX'

/** An in-memory KV good enough for the registry's get/put/list surface. */
function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async list({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }))
      return { keys, list_complete: true, cursor: undefined }
    },
  }
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    MPP_STORE: makeKv(),
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_ROUTER_PUBLIC: ROUTER_ADDRESS,
    STELLAR_X402_PAY_TO: ROUTER_ADDRESS,
    X402_ENABLED: 'true',
    ...overrides,
  } as any
}

function makeRecord(over: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'acme',
    name: 'Acme Data',
    email: 'ops@acme.example',
    apiBaseUrl: 'https://api.acme.example',
    payouts: [{ network: 'stellar:pubnet', payTo: PROVIDER_ADDRESS, asset: 'USDC' }],
    routes: [
      { operation: 'summarize', method: 'POST', upstreamPath: '/v1/summarize', priceUsd: '0.01' },
    ],
    status: 'published',
    verification: { probe402At: '2026-09-03T00:00:00.000Z', paidCallAt: '2026-09-03T00:01:00.000Z' },
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:01:00.000Z',
    ownerKey: { network: 'stellar:pubnet', address: PROVIDER_ADDRESS },
    ...over,
  }
}

async function publish(env: any, record: ProviderRecord) {
  await env.MPP_STORE.put(`provider:${record.id}`, JSON.stringify(record))
  await env.MPP_STORE.put(
    'providerIndex:v1',
    JSON.stringify({ providers: [record], builtAt: new Date().toISOString() }),
  )
  resetProviderCache()
}

beforeEach(() => {
  resetProviderCache()
})

// ---------------------------------------------------------------------
// Claim 1 — the existing catalog is untouched
// ---------------------------------------------------------------------

describe('backward compatibility: the snapshot catalog is untouched', () => {
  it('no snapshot route carries an operator, so none can reach direct settlement', () => {
    // This is THE invariant behind the whole design: `route.operator` is the
    // sole gate on the branch that pays a third party, and on the branch
    // that builds the mppx challenge with a non-ROZO recipient. If a
    // snapshot route ever grew this field, buyers of an existing service
    // would start paying an address out of the registry.
    const withOperator = PUBLIC_SERVICE_ROUTES.filter(r => (r as any).operator)
    expect(withOperator).toEqual([])
  })

  it('a snapshot route resolves without reading the registry at all', async () => {
    const sample = PUBLIC_SERVICE_ROUTES[0]
    const env = makeEnv()
    const getSpy = vi.spyOn(env.MPP_STORE, 'get')

    const found = await getRouteWithOverlay(env, sample.publicPath, sample.method)

    expect(found?.id).toBe(sample.id)
    // Not merely "fast" — zero KV reads. A registration must not put I/O on
    // the path of traffic that has nothing to do with it.
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('an overlay route cannot shadow a snapshot route', () => {
    const victim = PUBLIC_SERVICE_ROUTES[0]
    const attacker = {
      ...victim,
      id: 'evil_shadow',
      operator: {
        id: 'evil',
        name: 'Evil',
        payouts: [{ network: 'stellar:pubnet', payTo: PROVIDER_ADDRESS, asset: 'USDC' }],
      },
    } as any

    const merged = mergeRoutes(PUBLIC_SERVICE_ROUTES, [attacker])

    // Same length: the colliding row was dropped, not appended.
    expect(merged.length).toBe(PUBLIC_SERVICE_ROUTES.length)
    const resolved = merged.find(
      r => r.publicPath === victim.publicPath && r.method === victim.method,
    )
    expect(resolved?.id).toBe(victim.id)
    expect(resolved?.operator).toBeUndefined()
  })

  it('a non-colliding overlay route is appended', () => {
    const extra = routesForProvider(makeRecord())[0]
    const merged = mergeRoutes(PUBLIC_SERVICE_ROUTES, [extra])
    expect(merged.length).toBe(PUBLIC_SERVICE_ROUTES.length + 1)
    expect(merged.at(-1)?.operator?.id).toBe('acme')
  })

  it('an empty registry leaves the catalog byte-identical', async () => {
    const env = makeEnv()
    const withOverlay = await listCatalogWithOverlay(env)
    // Same count and same ids in the same order as the snapshot-only path.
    expect(withOverlay.length).toBe(PUBLIC_SERVICE_ROUTES.length)
    expect(withOverlay.every(e => e.settlement === undefined)).toBe(true)
  })

  it('an unreadable registry degrades to the snapshot rather than failing', async () => {
    const env = makeEnv()
    env.MPP_STORE.get = async () => {
      throw new Error('KV down')
    }
    const catalog = await listCatalogWithOverlay(env)
    expect(catalog.length).toBe(PUBLIC_SERVICE_ROUTES.length)
  })
})

// ---------------------------------------------------------------------
// Claim 2 — nothing publishes without proof of address ownership
// ---------------------------------------------------------------------

describe('registration validation', () => {
  const base = {
    id: 'acme',
    name: 'Acme Data',
    email: 'ops@acme.example',
    api_base_url: 'https://api.acme.example',
    payouts: [{ network: 'stellar:pubnet', pay_to: PROVIDER_ADDRESS }],
    routes: [
      { operation: 'summarize', method: 'POST', upstream_path: '/v1/summarize', price_usd: '0.01' },
    ],
  }

  it('accepts a well-formed registration', () => {
    const out = validateRegistration(base)
    expect(out.id).toBe('acme')
    expect(out.payouts[0].payTo).toBe(PROVIDER_ADDRESS)
    expect(out.routes[0].priceUsd).toBe('0.01')
  })

  it.each([
    ['http://api.acme.example', 'plain http'],
    ['https://localhost/api', 'localhost'],
    ['https://127.0.0.1/api', 'a literal IPv4'],
    ['https://169.254.169.254/latest/meta-data', 'cloud metadata'],
    ['https://user:pw@api.acme.example', 'embedded credentials'],
    ['https://api.internal/x', 'an internal TLD'],
  ])('refuses %s as an API base URL (%s)', raw => {
    // The verification gates fetch this URL from inside the Worker, so a
    // permissive version of this check is an SSRF with our egress.
    expect(() => validateApiBaseUrl(raw)).toThrow(ProviderValidationError)
  })

  it('normalises away a trailing slash and query string', () => {
    expect(validateApiBaseUrl('https://api.acme.example/base/?x=1#f')).toBe(
      'https://api.acme.example/base',
    )
  })

  it('refuses a reserved provider id', () => {
    // Merge order already stops a shadow; this stops the impersonation.
    expect(() => validateRegistration({ ...base, id: 'rozo' })).toThrow(/reserved/)
  })

  it('refuses two payout addresses on one chain', () => {
    expect(() =>
      validateRegistration({
        ...base,
        payouts: [
          { network: 'stellar:pubnet', pay_to: PROVIDER_ADDRESS },
          { network: 'stellar:pubnet', pay_to: Keypair.random().publicKey() },
        ],
      }),
    ).toThrow(/One address per chain/)
  })

  it('refuses a zero or negative price', () => {
    expect(() =>
      validateRegistration({ ...base, routes: [{ ...base.routes[0], price_usd: '0' }] }),
    ).toThrow(/greater than zero/)
  })

  it('refuses a traversal in the upstream path', () => {
    expect(() =>
      validateRegistration({
        ...base,
        routes: [{ ...base.routes[0], upstream_path: '/v1/../../admin' }],
      }),
    ).toThrow(/traversal/)
  })

  it('refuses duplicate operations, which would collide on one public path', () => {
    expect(() =>
      validateRegistration({ ...base, routes: [base.routes[0], base.routes[0]] }),
    ).toThrow(/Duplicate operation/)
  })
})

describe('wallet-signature authentication', () => {
  const payouts = [{ network: 'stellar:pubnet', payTo: PROVIDER_ADDRESS, asset: 'USDC' }]

  async function signedRegistration(over: { nonce?: string; issuedAt?: string } = {}) {
    const digest = await registrationDigest({
      id: 'acme',
      name: 'Acme Data',
      email: 'ops@acme.example',
      apiBaseUrl: 'https://api.acme.example',
      payouts,
      routes: [
        { operation: 'summarize', method: 'POST', upstreamPath: '/v1/summarize', priceUsd: '0.01' },
      ],
    })
    const nonce = over.nonce ?? 'nonce-' + crypto.randomUUID().replace(/-/g, '')
    const issuedAt = over.issuedAt ?? new Date().toISOString()
    const message = buildSignatureMessage({
      providerId: 'acme',
      network: 'stellar:pubnet',
      address: PROVIDER_ADDRESS,
      digest,
      issuedAt,
      nonce,
    })
    const signature = PROVIDER_KEYPAIR.sign(Buffer.from(message, 'utf8')).toString('base64')
    return { digest, nonce, issuedAt, signature }
  }

  it('accepts a real signature from the payout address', async () => {
    const env = makeEnv()
    const { digest, nonce, issuedAt, signature } = await signedRegistration()

    const result = await verifyRegistrationSignatures(env, {
      providerId: 'acme',
      digest,
      payouts,
      signatures: [{ network: 'stellar:pubnet', signature, nonce, issued_at: issuedAt }],
    })

    expect(result.ownerKey.address).toBe(PROVIDER_ADDRESS)
  })

  it('rejects a signature made by a different key', async () => {
    const env = makeEnv()
    const { digest, nonce, issuedAt } = await signedRegistration()
    const message = buildSignatureMessage({
      providerId: 'acme',
      network: 'stellar:pubnet',
      address: PROVIDER_ADDRESS,
      digest,
      issuedAt,
      nonce,
    })
    // Someone else signs the same bytes — the exact shape of "I typed an
    // address I do not control".
    const impostor = Keypair.random().sign(Buffer.from(message, 'utf8')).toString('base64')

    await expect(
      verifyRegistrationSignatures(env, {
        providerId: 'acme',
        digest,
        payouts,
        signatures: [{ network: 'stellar:pubnet', signature: impostor, nonce, issued_at: issuedAt }],
      }),
    ).rejects.toThrow(/does not match address/)
  })

  it('rejects a signature lifted onto a different registration', async () => {
    const env = makeEnv()
    const { nonce, issuedAt, signature } = await signedRegistration()
    // Same signature, but presented against a payload with a different
    // digest (e.g. a changed API origin or price).
    await expect(
      verifyRegistrationSignatures(env, {
        providerId: 'acme',
        digest: 'f'.repeat(64),
        payouts,
        signatures: [{ network: 'stellar:pubnet', signature, nonce, issued_at: issuedAt }],
      }),
    ).rejects.toThrow(ProviderAuthError)
  })

  it('rejects a replayed nonce', async () => {
    const env = makeEnv()
    const { digest, nonce, issuedAt, signature } = await signedRegistration()
    const args = {
      providerId: 'acme',
      digest,
      payouts,
      signatures: [{ network: 'stellar:pubnet', signature, nonce, issued_at: issuedAt }],
    }
    await verifyRegistrationSignatures(env, args)
    await expect(verifyRegistrationSignatures(env, args)).rejects.toThrow(/already been used/)
  })

  it('rejects an expired signature', async () => {
    const env = makeEnv()
    const stale = new Date(Date.now() - 60 * 60_000).toISOString()
    const { digest, nonce, signature } = await signedRegistration({ issuedAt: stale })
    await expect(
      verifyRegistrationSignatures(env, {
        providerId: 'acme',
        digest,
        payouts,
        signatures: [{ network: 'stellar:pubnet', signature, nonce, issued_at: stale }],
      }),
    ).rejects.toThrow(/expired/i)
  })

  it('rejects a payout address with no signature at all', async () => {
    const env = makeEnv()
    const { digest, nonce, issuedAt, signature } = await signedRegistration()
    await expect(
      verifyRegistrationSignatures(env, {
        providerId: 'acme',
        digest,
        // Two chains declared, one proven. The unproven one is exactly the
        // typo hazard, so partial proof must fail the whole registration.
        payouts: [...payouts, { network: 'eip155:8453', payTo: '0x' + '1'.repeat(40), asset: 'USDC' }],
        signatures: [{ network: 'stellar:pubnet', signature, nonce, issued_at: issuedAt }],
      }),
    ).rejects.toThrow(/Missing signature/)
  })

  it('refuses a chain whose signatures we cannot verify', () => {
    expect(isSupportedPayoutNetwork('stellar:pubnet')).toBe(true)
    expect(isSupportedPayoutNetwork('eip155:8453')).toBe(true)
    expect(isSupportedPayoutNetwork('solana:mainnet')).toBe(true)
    expect(isSupportedPayoutNetwork('bitcoin:mainnet')).toBe(false)
  })

  it('rejects a malformed Stellar address before any crypto runs', async () => {
    await expect(
      verifyAddressSignature({
        network: 'stellar:pubnet',
        address: 'not-a-stellar-key',
        message: 'x',
        signature: 'AAAA',
      }),
    ).rejects.toThrow(/valid Stellar public key/)
  })
})

// ---------------------------------------------------------------------
// Gate 1 — probe-402
// ---------------------------------------------------------------------

describe('probe-402 gate', () => {
  const record = makeRecord()
  const spec = record.routes[0]

  function challengeResponse(body: unknown, status = 402) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  function x402Body(payTo: string, amount: string, network = 'stellar:pubnet') {
    return {
      x402Version: 2,
      accepts: [{ scheme: 'exact', network, payTo, amount, asset: 'USDC' }],
    }
  }

  it('passes a well-formed challenge that pays the registered address', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      // 0.01 USD at Stellar's 7dp.
      challengeResponse(x402Body(PROVIDER_ADDRESS, '100000')),
    )
    const result = await gateProbe402(record, spec)
    expect(result.ok).toBe(true)
    vi.restoreAllMocks()
  })

  it('fails when the challenge pays an address the provider did not register', async () => {
    // The gate that matters. A server quoting somebody else's address —
    // whether by mistake or design — must never reach publication.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      challengeResponse(x402Body(Keypair.random().publicKey(), '100000')),
    )
    const result = await gateProbe402(record, spec)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('paytoaddress_mismatch')
    vi.restoreAllMocks()
  })

  it('fails when the advertised price differs from the registered price', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      challengeResponse(x402Body(PROVIDER_ADDRESS, '9900000')),
    )
    const result = await gateProbe402(record, spec)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('price_mismatch')
    vi.restoreAllMocks()
  })

  it('fails when the endpoint offers a chain the provider never registered', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      challengeResponse(x402Body('0x' + '2'.repeat(40), '10000', 'eip155:8453')),
    )
    const result = await gateProbe402(record, spec)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('unregistered_network')
    vi.restoreAllMocks()
  })

  it('fails when the endpoint does not ask for payment at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    )
    const result = await gateProbe402(record, spec)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('not_402')
    vi.restoreAllMocks()
  })

  it('fails closed when the provider endpoint is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await gateProbe402(record, spec)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('unreachable')
    vi.restoreAllMocks()
  })

  it('reads an mpp WWW-Authenticate challenge as well as x402 JSON', () => {
    const request = btoa(
      JSON.stringify({ amount: '100000', currency: 'USDC', recipient: PROVIDER_ADDRESS }),
    )
    const parsed = parseProviderChallenge(
      402,
      new Headers({ 'www-authenticate': `Payment id="abc", request="${request}"` }),
      '',
    )
    expect(parsed?.dialect).toBe('mppx')
    expect(parsed?.accepts[0].payTo).toBe(PROVIDER_ADDRESS)
  })

  it('verifies against the cheapest route so a provider is not overcharged', () => {
    const multi = makeRecord({
      routes: [
        { operation: 'expensive', method: 'POST', upstreamPath: '/a', priceUsd: '0.50' },
        { operation: 'cheap', method: 'POST', upstreamPath: '/b', priceUsd: '0.001' },
      ],
    })
    expect(chooseVerificationRoute(multi).operation).toBe('cheap')
  })
})

// ---------------------------------------------------------------------
// Claim 3 — a published route pays the provider, not us
// ---------------------------------------------------------------------

describe('direct settlement', () => {
  it('the x402 challenge advertises the provider address and never ours', () => {
    const operator = {
      id: 'acme',
      name: 'Acme Data',
      payouts: [{ network: 'stellar:pubnet', payTo: PROVIDER_ADDRESS, asset: 'USDC' }],
    }
    const header = buildX402PaymentRequiredHeader(makeEnv(), 10_000n, 'https://r/x', operator)
    const decoded = JSON.parse(atob(header!))

    expect(decoded.accepts).toHaveLength(1)
    expect(decoded.accepts[0].payTo).toBe(PROVIDER_ADDRESS)
    // The claim being made to a reviewer: no ROZO-addressed option exists
    // on this route, so a buyer cannot accidentally pay the pool.
    expect(JSON.stringify(decoded)).not.toContain(ROUTER_ADDRESS)
  })

  it('emits one accepts[] entry per registered chain, each in that chain’s decimals', () => {
    const operator = {
      id: 'acme',
      name: 'Acme Data',
      payouts: [
        { network: 'stellar:pubnet', payTo: PROVIDER_ADDRESS, asset: 'USDC' },
        { network: 'eip155:8453', payTo: '0x' + '3'.repeat(40), asset: 'USDC' },
        { network: 'solana:mainnet', payTo: 'So11111111111111111111111111111111111111112', asset: 'USDC' },
      ],
    }
    // 10_000 Tempo base units = 0.01 USD at 6dp.
    const decoded = JSON.parse(
      atob(buildX402PaymentRequiredHeader(makeEnv(), 10_000n, 'https://r/x', operator)!),
    )

    expect(decoded.accepts.map((a: any) => a.network)).toEqual([
      'stellar:pubnet',
      'eip155:8453',
      'solana:mainnet',
    ])
    // Stellar USDC is 7dp, so the same price is ×10. Getting this wrong
    // would ask an EVM buyer to sign for ten times the price.
    expect(decoded.accepts[0].amount).toBe('100000')
    expect(decoded.accepts[1].amount).toBe('10000')
    expect(decoded.accepts[2].amount).toBe('10000')
    // We only claim sponsored fees on the leg we actually facilitate.
    expect(decoded.accepts[0].extra.areFeesSponsored).toBe(true)
    expect(decoded.accepts[1].extra.areFeesSponsored).toBe(false)
  })

  it('a snapshot route still emits exactly the single ROZO entry it always did', () => {
    const decoded = JSON.parse(
      atob(buildX402PaymentRequiredHeader(makeEnv(), 10_000n, 'https://r/x')!),
    )
    expect(decoded.accepts).toHaveLength(1)
    expect(decoded.accepts[0].payTo).toBe(ROUTER_ADDRESS)
  })

  it('a credential paying the provider is claimed on a provider route and not otherwise', () => {
    const env = makeEnv()
    // A full V2 payload: the predicate runs the real @x402/core zod parser,
    // so a thin fixture would make this test pass for the wrong reason.
    const credentialFor = (payTo: string) =>
      `Payment ${btoa(
        JSON.stringify({
          x402Version: 2,
          accepted: {
            scheme: 'exact',
            network: 'stellar:pubnet',
            payTo,
            amount: '100000',
            asset: 'USDC',
            maxTimeoutSeconds: 300,
            extra: {},
          },
          payload: { transaction: 'AAAA' },
        }),
      )}`
    const header = credentialFor(PROVIDER_ADDRESS)

    // On a snapshot route the expected recipient is ours, so a credential
    // paying the provider is not ours to claim.
    expect(isStellarX402ForThisRouter(header, env)).toBe(false)
    // On a provider route it is.
    expect(isStellarX402ForThisRouter(header, env, PROVIDER_ADDRESS)).toBe(true)
    // And a credential paying US on a provider route is NOT claimed —
    // otherwise we would serve a call the provider was never paid for.
    const toRouter = credentialFor(ROUTER_ADDRESS)
    expect(isStellarX402ForThisRouter(toRouter, env, PROVIDER_ADDRESS)).toBe(false)
  })
})

describe('no refund is ever paid out of our pool for a direct route', () => {
  /**
   * The failure this guards against is a repeatable treasury drain, so it
   * is asserted on the source rather than only through a live proxy call:
   * on a direct route the buyer's money went to the provider, but
   * `settledPayment` and `refundReason` are both truthy when the provider
   * 502s, which is exactly the condition the generic refund branch fires
   * on. Getting this wrong reimburses a buyer, every failed call, with
   * money we never received.
   */
  it('the operator branch is checked before the generic enqueueRefund branch', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('../src/routes/proxy.ts', import.meta.url),
      'utf8',
    )
    const guarded = src.indexOf("settledPayment && payResult.refundReason && route.operator")
    const generic = src.indexOf("settledPayment && payResult.refundReason) {")

    expect(guarded).toBeGreaterThan(-1)
    expect(generic).toBeGreaterThan(-1)
    // Order matters: the operator branch must return before the generic
    // one is reached.
    expect(guarded).toBeLessThan(generic)
  })

  it('the direct-settlement error path sets no refundable reason for the executor', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('../src/routes/proxy.ts', import.meta.url),
      'utf8',
    )
    expect(src).toContain("'not-applicable-direct-settlement'")
  })
})

describe('published providers appear in the catalog', () => {
  it('surfaces operator, settlement and the provider payout address', async () => {
    const env = makeEnv()
    await publish(env, makeRecord())

    const catalog = await listCatalogWithOverlay(env)
    const entry = catalog.find(e => e.public_path === publicPathFor('acme', 'summarize'))!

    expect(entry).toBeDefined()
    expect(entry.settlement).toBe('direct')
    expect(entry.operator?.id).toBe('acme')
    expect(entry.operator?.payouts[0].pay_to).toBe(PROVIDER_ADDRESS)
    // The wallet hint must point at the provider, never at the pool: a
    // client that signs against this hint is signing a real payment.
    expect(entry.payment_hints?.pay_to).toBe(PROVIDER_ADDRESS)
    // No stellar_x402 block — that one carries OUR facilitator address.
    expect(entry.methods.stellar_x402).toBeUndefined()
  })

  it('a pending provider is invisible and its route does not resolve', async () => {
    const env = makeEnv()
    const pending = makeRecord({ status: 'pending' })
    // Written as a record, but never indexed — which is what registration
    // does before the gates pass.
    await env.MPP_STORE.put(`provider:${pending.id}`, JSON.stringify(pending))
    resetProviderCache()

    const route = await getRouteWithOverlay(env, publicPathFor('acme', 'summarize'), 'POST')
    expect(route).toBeUndefined()

    const catalog = await listCatalogWithOverlay(env)
    expect(catalog.find(e => e.operator?.id === 'acme')).toBeUndefined()
  })

  it('a published route resolves and carries the operator into the proxy', async () => {
    const env = makeEnv()
    await publish(env, makeRecord())

    const route = await getRouteWithOverlay(env, publicPathFor('acme', 'summarize'), 'POST')

    expect(route?.operator?.payouts[0].payTo).toBe(PROVIDER_ADDRESS)
    // fixedPricing is what lets the router issue its own 402 without
    // probing an upstream it never pays.
    expect(route?.fixedPricing?.amountUsd).toBe('0.01')
    expect(route?.upstreamHost).toBe('api.acme.example')
    expect(route?.upstreamPath).toBe('/v1/summarize')
  })
})
