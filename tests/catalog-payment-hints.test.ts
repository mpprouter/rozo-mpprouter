import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { listPublicCatalog, PUBLIC_SERVICE_ROUTES } from '../src/services/merchants'
import { handleProxy } from '../src/routes/proxy'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

function loadDevVars(): Record<string, string> | null {
  const path = resolve(__dirname, '..', '.dev.vars')
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function requireVar(vars: Record<string, string>, name: string): string {
  const v = vars[name]
  if (!v) throw new Error(`Missing ${name} in .dev.vars`)
  return v
}

function makeEnv(): Env {
  const kv = new Map<string, string>()
  const MPP_STORE = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => {
      kv.set(key, value)
    },
    delete: async (key: string) => {
      kv.delete(key)
    },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace

  const vars = loadDevVars()
  if (!vars) throw new Error('.dev.vars missing — suite is skipped in CI')
  return {
    MPP_STORE,
    // P1-3: in-process DO mock so doAtomicParams() works in tests without CF runtime.
    ATOMIC_STORE: makeAtomicStoreMock(),
    STELLAR_ROUTER_PUBLIC: requireVar(vars, 'STELLAR_ROUTER_PUBLIC'),
    STELLAR_GAS_SECRET: requireVar(vars, 'STELLAR_GAS_SECRET'),
    STELLAR_GAS_PUBLIC: requireVar(vars, 'STELLAR_GAS_PUBLIC'),
    STELLAR_NETWORK: vars.STELLAR_NETWORK ?? 'stellar:pubnet',
    STELLAR_RPC_URL: vars.STELLAR_RPC_URL ?? 'https://soroban-rpc.mainnet.stellar.gateway.fm',
    TEMPO_ROUTER_PRIVATE_KEY: requireVar(vars, 'TEMPO_ROUTER_PRIVATE_KEY'),
    TEMPO_ROUTER_ADDRESS: requireVar(vars, 'TEMPO_ROUTER_ADDRESS'),
    TEMPO_RPC_URL: vars.TEMPO_RPC_URL ?? 'https://rpc.tempo.xyz',
    MPP_SECRET_KEY: requireVar(vars, 'MPP_SECRET_KEY'),
    OPTIMISTIC_THRESHOLD: vars.OPTIMISTIC_THRESHOLD ?? '0.05',
    RATE_LIMIT_MAX: vars.RATE_LIMIT_MAX ?? '10',
    XLM_USD_RATE: vars.XLM_USD_RATE ?? '0.1533',
    X402_ENABLED: vars.X402_ENABLED ?? 'true',
    STELLAR_X402_PAY_TO: vars.STELLAR_X402_PAY_TO ?? requireVar(vars, 'STELLAR_ROUTER_PUBLIC'),
    STELLAR_X402_FACILITATOR_SECRET: vars.STELLAR_X402_FACILITATOR_SECRET ?? requireVar(vars, 'STELLAR_GAS_SECRET'),
    PAYINVOICE_ADMIN_SECRET: vars.PAYINVOICE_ADMIN_SECRET ?? 'test',
  }
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
}

function decodeRequestFromWwwAuthenticate(www: string): any {
  const m = /request="([^"]+)"/.exec(www)
  if (!m) throw new Error('request field not found in WWW-Authenticate')
  const b64u = m[1]
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  return JSON.parse(Buffer.from(`${b64}${pad}`, 'base64').toString('utf8'))
}

describe.skipIf(!loadDevVars())('catalog payment_hints metadata', () => {
  it('keeps existing catalog fields and adds optional payment_hints on a verified route', () => {
    const env = makeEnv()
    const items = listPublicCatalog(env)
    // Pick a known operator-verified route. After the 2026-06-22 opt-IN
    // flip, items[0] (snapshot order) is typically an UNVERIFIED route
    // with no stellar block / payment_hints, so assert against a stable
    // verified route instead.
    const item = items.find(i => i.id === 'parallel_search')!
    expect(item).toBeDefined()

    expect(item.id).toBeTypeOf('string')
    expect(item.public_path).toMatch(/^\/v1\/services\//)
    expect(item.method).toBe('POST')
    expect(item.payment_method).toBe('stellar')
    expect(item.methods.tempo.intents).toEqual(['charge'])
    expect(item.methods.stellar).toBeDefined()
    expect(item.payment_status).toBe('verified')
    expect(item.payment_enabled).toBe(true)
    expect(item.payment_status_note).toBeUndefined()
    expect(item.payment_hints).toBeDefined()
  })

  it('includes payment_hints for fixed-price stellar charge routes', () => {
    const env = makeEnv()
    const items = listPublicCatalog(env)
    const fixed = items.find(i => i.methods.stellar && i.price.match(/^\$[0-9.]+\/request$/))
    expect(fixed).toBeDefined()
    expect(fixed!.payment_hints).toBeDefined()
    expect(fixed!.payment_hints!.intent).toBe('charge')
    expect(fixed!.payment_hints!.amount_usdc).toMatch(/^\d+\.\d{7}$/)
    expect(fixed!.payment_hints!.recommended_wallet_preflight).toEqual([
      'account_exists',
      'classic_usdc_trustline',
      'usdc_balance_gte_amount',
      'xlm_reserve_ok',
    ])
  })

  it('omits amount_usdc for dynamic/unknown priced routes', () => {
    const inserted = {
      id: '__test_dynamic_price__',
      service: 'test',
      operation: 'op',
      name: 'Dynamic price route',
      categories: ['test'],
      description: 'dynamic',
      method: 'POST',
      price: 'unknown',
      paymentMethod: 'stellar' as const,
      upstreamPaymentMethod: 'tempo.charge' as const,
      network: 'stellar-mainnet' as const,
      asset: 'USDC' as const,
      publicPath: '/v1/services/test/dynamic',
      upstreamHost: 'example.com',
      upstreamPath: '/v1/do',
      verifiedMode: 'charge' as const,
    }
    PUBLIC_SERVICE_ROUTES.push(inserted as any)
    try {
      const env = makeEnv()
      const item = listPublicCatalog(env).find(i => i.id === inserted.id)
      expect(item).toBeDefined()
      expect(item!.payment_hints).toBeDefined()
      expect(item!.payment_hints!.amount_usdc).toBeUndefined()
    } finally {
      PUBLIC_SERVICE_ROUTES.pop()
    }
  })

  it('does not expose charge hints for a route without stellar intents', () => {
    const inserted = {
      id: '__test_session_only__',
      service: 'test',
      operation: 'op',
      name: 'Session only',
      categories: ['test'],
      description: 'test',
      method: 'POST',
      price: '$0.001/request',
      paymentMethod: 'stellar' as const,
      upstreamPaymentMethod: 'tempo.session' as const,
      network: 'stellar-mainnet' as const,
      asset: 'USDC' as const,
      publicPath: '/v1/services/test/session-only',
      upstreamHost: 'example.com',
      upstreamPath: '/v1/do',
      verifiedMode: false as const,
    }
    PUBLIC_SERVICE_ROUTES.push(inserted as any)
    try {
      const env = makeEnv()
      const item = listPublicCatalog(env).find(i => i.id === inserted.id)
      expect(item).toBeDefined()
      expect(item!.methods.stellar).toBeUndefined()
      expect(item!.payment_hints).toBeUndefined()
    } finally {
      PUBLIC_SERVICE_ROUTES.pop()
    }
  })

  it('matches pay_to and asset_sac from live 402 challenge on a fixed route', async () => {
    const env = makeEnv()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"payment required"}', {
        status: 402,
        headers: {
          'WWW-Authenticate': [
            'Payment id="test-challenge-id"',
            'realm="parallelmpp.dev"',
            'method="tempo"',
            'intent="charge"',
            `request="${Buffer.from(
              JSON.stringify({
                amount: '10000',
                currency: '0xdeadbeef',
                recipient: '0x1234567890123456789012345678901234567890',
              }),
            )
              .toString('base64')
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=+$/, '')}"`,
          ].join(', '),
          'Content-Type': 'application/json',
        },
      }),
    )

    const req = new Request('https://apiserver.mpprouter.dev/v1/services/parallel/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    })
    const res = await handleProxy(req, env, makeCtx())
    expect(res.status).toBe(402)
    const www = res.headers.get('www-authenticate') ?? ''
    const request = decodeRequestFromWwwAuthenticate(www)

    const catalog = listPublicCatalog(env)
    const parallel = catalog.find(i => i.id === 'parallel_search')
    expect(parallel).toBeDefined()
    expect(parallel!.payment_hints).toBeDefined()
    expect(parallel!.payment_hints!.pay_to).toBe(request.recipient)
    expect(parallel!.payment_hints!.asset_sac).toBe(request.currency)

    fetchSpy.mockRestore()
  })
})
