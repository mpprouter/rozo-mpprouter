/**
 * Regression tests for the payment verification gap.
 *
 * History: a prior version of src/routes/proxy.ts accepted any
 * `Authorization: Payment ...` header and called payMerchant()
 * without verifying the Stellar credential. These tests lock in
 * that behavior is now:
 *   1. No credential → mppx 402 with WWW-Authenticate, payMerchant NOT called.
 *   2. Forged credential → mppx 402, payMerchant NOT called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Load secrets from .dev.vars (Wrangler's local secrets file, gitignored).
 * We never hardcode key material in test files.
 */
function loadDevVars(): Record<string, string> {
  const path = resolve(__dirname, '..', '.dev.vars')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(
      `Could not read .dev.vars at ${path}. ` +
        `Copy .dev.vars.example (or ask the operator) and populate: ` +
        `STELLAR_ROUTER_PUBLIC, STELLAR_GAS_SECRET, STELLAR_GAS_PUBLIC, ` +
        `TEMPO_ROUTER_PRIVATE_KEY, TEMPO_ROUTER_ADDRESS, MPP_SECRET_KEY.`,
    )
  }
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
  if (!v) {
    throw new Error(`Missing ${name} in .dev.vars`)
  }
  return v
}

// Mock the tempo client so we can assert payMerchant is never called on
// the unauthorized paths. The real implementation depends on viem and
// would actually spend funds if invoked. Use vi.hoisted so the spy
// survives the top-of-file hoist that vi.mock applies.
const { payMerchantSpy } = vi.hoisted(() => ({
  payMerchantSpy: vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
}))
vi.mock('../src/mpp/tempo-client', () => ({
  payMerchant: payMerchantSpy,
}))

import { handleProxy } from '../src/routes/proxy'
import type { Env } from '../src/index'

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
    // Unused by the proxy but required by the KV type.
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace

  const vars = loadDevVars()

  return {
    MPP_STORE,
    STELLAR_ROUTER_PUBLIC: requireVar(vars, 'STELLAR_ROUTER_PUBLIC'),
    STELLAR_GAS_SECRET: requireVar(vars, 'STELLAR_GAS_SECRET'),
    STELLAR_GAS_PUBLIC: requireVar(vars, 'STELLAR_GAS_PUBLIC'),
    STELLAR_NETWORK: vars.STELLAR_NETWORK ?? 'stellar:testnet',
    STELLAR_RPC_URL: vars.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
    TEMPO_ROUTER_PRIVATE_KEY: requireVar(vars, 'TEMPO_ROUTER_PRIVATE_KEY'),
    TEMPO_ROUTER_ADDRESS: requireVar(vars, 'TEMPO_ROUTER_ADDRESS'),
    TEMPO_RPC_URL: vars.TEMPO_RPC_URL ?? 'https://rpc.tempo.xyz',
    MPP_SECRET_KEY: requireVar(vars, 'MPP_SECRET_KEY'),
    OPTIMISTIC_THRESHOLD: vars.OPTIMISTIC_THRESHOLD ?? '0.05',
    RATE_LIMIT_MAX: vars.RATE_LIMIT_MAX ?? '10',
  }
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
}

/**
 * Build a fake merchant 402 with a Tempo-format WWW-Authenticate header.
 * The router only parses { amount, currency, recipient } out of the base64
 * request blob; everything else is cosmetic.
 */
function makeTempoChallengeResponse(amount: string): Response {
  const request = {
    amount,
    currency: '0xdeadbeef',
    recipient: '0x1234567890123456789012345678901234567890',
  }
  const requestB64 = btoa(JSON.stringify(request))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const wwwAuth = [
    'Payment id="test-challenge-id"',
    'realm="parallelmpp.dev"',
    'method="tempo"',
    'intent="charge"',
    `request="${requestB64}"`,
  ].join(', ')
  return new Response('{"error":"payment required"}', {
    status: 402,
    headers: {
      'WWW-Authenticate': wwwAuth,
      'Content-Type': 'application/json',
    },
  })
}

describe('handleProxy payment verification', () => {
  beforeEach(() => {
    payMerchantSpy.mockClear()
  })

  it('returns 402 and does not pay merchant when no credential is presented', async () => {
    const env = makeEnv()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeTempoChallengeResponse('0.01'))

    const request = new Request('https://apiserver.mpprouter.dev/v1/services/parallel/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    })

    const response = await handleProxy(request, env, makeCtx())

    expect(response.status).toBe(402)
    expect(response.headers.get('www-authenticate')).toMatch(/method="stellar"/)
    expect(payMerchantSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it('rejects a forged "Authorization: Payment" header without paying the merchant', async () => {
    const env = makeEnv()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeTempoChallengeResponse('0.01'))

    const request = new Request('https://apiserver.mpprouter.dev/v1/services/parallel/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A fake credential with arbitrary bytes. Prior to the fix this
        // went unverified and caused payMerchant to be called.
        Authorization:
          'Payment id="attacker", method="stellar", intent="charge", payload="ZmFrZQ=="',
      },
      body: JSON.stringify({ query: 'test' }),
    })

    const response = await handleProxy(request, env, makeCtx())

    // Either a 402 (mppx rejects the challenge) or some 4xx — the key
    // invariant is that we never authorized spending from the Tempo pool.
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(payMerchantSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it('passes merchant responses through when the upstream does not require payment', async () => {
    const env = makeEnv()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"results":[]}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    const request = new Request('https://apiserver.mpprouter.dev/v1/services/parallel/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    })

    const response = await handleProxy(request, env, makeCtx())

    expect(response.status).toBe(200)
    expect(payMerchantSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  // ── Wallet-type gate: non-Stellar credentials are forwarded as-is ──
  //
  // The router only funds merchant calls for Stellar agents it has
  // verified via mppx. Any other credential must be transparently
  // passed through so the merchant can decide how to handle it. This
  // eliminates the class of attacks where a non-Stellar header could
  // cause the router to spend from its Tempo pool.

  it('passes through a Bearer token without touching the Tempo pool', async () => {
    const env = makeEnv()
    const merchantBody = '{"results":["bearer-ok"]}'
    let seenAuth: string | null = null
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        const headers = new Headers((init as RequestInit | undefined)?.headers)
        seenAuth = headers.get('authorization')
        return new Response(merchantBody, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      })

    const request = new Request('https://apiserver.mpprouter.dev/v1/services/parallel/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer agent-owned-token-xyz',
      },
      body: JSON.stringify({ query: 'test' }),
    })

    const response = await handleProxy(request, env, makeCtx())

    // Merchant response is returned verbatim.
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(merchantBody)
    // Authorization header reached the merchant unchanged.
    expect(seenAuth).toBe('Bearer agent-owned-token-xyz')
    // Router never paid from its Tempo pool.
    expect(payMerchantSpy).not.toHaveBeenCalled()
    // And the probe/Stellar flow was short-circuited — only one outbound
    // fetch, not the usual two (probe + authoritative).
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    fetchSpy.mockRestore()
  })

  it('passes through a non-Stellar Payment credential (e.g. EVM x402)', async () => {
    const env = makeEnv()
    const merchantBody = '{"results":["evm-ok"]}'
    let seenAuth: string | null = null
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        const headers = new Headers((init as RequestInit | undefined)?.headers)
        seenAuth = headers.get('authorization')
        return new Response(merchantBody, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      })

    const evmCredential =
      'Payment id="evm-challenge", method="tempo", intent="charge", payload="c29tZS14NDAy"'
    const request = new Request('https://apiserver.mpprouter.dev/v1/services/parallel/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: evmCredential,
      },
      body: JSON.stringify({ query: 'test' }),
    })

    const response = await handleProxy(request, env, makeCtx())

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(merchantBody)
    expect(seenAuth).toBe(evmCredential)
    expect(payMerchantSpy).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    fetchSpy.mockRestore()
  })
})
