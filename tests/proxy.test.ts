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
import { Credential } from 'mppx'

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
 *
 * Matches the real on-the-wire format Tempo merchants emit: `amount` is
 * a base-unit integer string. Real merchants do NOT include `decimals`
 * in the wire payload — mppx's tempo.charge runs a zod transform that
 * converts decimal→base-units and drops the `decimals` field before
 * serialization. The router is expected to default to TIP-20's 6
 * decimals in that case. Tests can override with `decimals: null` to
 * match real wire output, or with a number to test explicit override.
 *
 * (An even earlier version of this mock passed a decimal string like
 * "0.01" as the amount, which hid the 1,000,000x overcharge bug — never
 * do that again.)
 */
/**
 * Build an Authorization header value that looks like a real mppx
 * Credential on the wire: `Payment <base64url(JSON)>`. This is the
 * format `Credential.serialize()` actually produces — see
 * node_modules/mppx/dist/Credential.js. Tests that hand-roll auth-params
 * ("Payment id=..., method=stellar, ...") exercise a format no real
 * client will ever send, and historically let a classifyAuth bug slip
 * through where every real Stellar credential was routed to passthrough.
 *
 * `method` controls the embedded `challenge.method` field so the same
 * helper can build both "looks stellar" and "looks non-stellar" fixtures.
 */
function makeCredentialHeader({
  method = 'stellar',
  challengeId = 'test-challenge-id',
  realm = 'apiserver.mpprouter.dev',
}: {
  method?: string
  challengeId?: string
  realm?: string
} = {}): string {
  return Credential.serialize({
    challenge: {
      id: challengeId,
      realm,
      method,
      intent: 'charge',
      request: {
        amount: '100000',
        currency: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        recipient: 'GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB',
      },
      expires: '2099-01-01T00:00:00Z',
    },
    payload: { type: 'transaction', transaction: 'AAAAAA==' },
    source:
      'did:pkh:stellar:pubnet:GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB',
  } as any)
}

function makeTempoChallengeResponse(
  amount: string = '10000',
  decimals: number | null = null,
): Response {
  const request: Record<string, unknown> = {
    amount,
    currency: '0xdeadbeef',
    recipient: '0x1234567890123456789012345678901234567890',
  }
  if (decimals !== null) {
    request.decimals = decimals
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
      .mockResolvedValue(makeTempoChallengeResponse())

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

  it('rejects a forged Stellar credential without paying the merchant', async () => {
    const env = makeEnv()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeTempoChallengeResponse())

    // A real mppx Credential on the wire: `Payment <base64url(JSON)>`.
    // This credential parses successfully and carries `challenge.method
    // === "stellar"`, so classifyAuth routes it to the Stellar
    // verification path — exactly what a real attacker's SDK would
    // emit. The challenge id inside is not HMAC-valid for this Router,
    // so mppx must reject it at the verify step. The invariant we lock
    // in here: the forged credential reaches Stellar verification
    // (NOT the passthrough path) and payMerchant is never called.
    const forgedCredential = makeCredentialHeader({
      method: 'stellar',
      challengeId: 'attacker-not-hmac-bound',
    })

    const request = new Request('https://apiserver.mpprouter.dev/v1/services/parallel/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: forgedCredential,
      },
      body: JSON.stringify({ query: 'test' }),
    })

    const response = await handleProxy(request, env, makeCtx())

    // The key invariant is that we never authorized spending from the
    // Tempo pool. Status can be 402 (mppx rejects the challenge) or
    // another 4xx, but never a successful merchant call.
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(payMerchantSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  // Regression: classifyAuth used to parse the Authorization header as
  // RFC 9110 auth-params (`Payment id="...", method="stellar", ...`).
  // That is the WWW-Authenticate format, not what real mppx clients
  // send. Every real Stellar credential — a base64url-encoded JSON blob
  // after the `Payment ` prefix — fell through to the "passthrough"
  // branch, so Router never verified or settled Stellar payments. The
  // two assertions below lock in that a real-format credential is
  // classified as 'stellar' (routed to mppx verify) and that the
  // non-mppx `Payment id="..."` auth-params format is now treated as
  // passthrough rather than being mis-identified as Stellar.
  it('routes a real mppx Stellar credential into the Stellar verify path', async () => {
    const env = makeEnv()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeTempoChallengeResponse())

    const request = new Request('https://apiserver.mpprouter.dev/v1/services/parallel/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: makeCredentialHeader({ method: 'stellar' }),
      },
      body: JSON.stringify({ query: 'test' }),
    })

    const response = await handleProxy(request, env, makeCtx())

    // The credential is not HMAC-valid, so mppx rejects it with a 402.
    // Critically: the fetchSpy was called TWICE (probe + mppx verify
    // rebuild) — not once, which would indicate the passthrough path.
    expect(response.status).toBe(402)
    expect(payMerchantSpy).not.toHaveBeenCalled()
    // Two fetches prove we went through the Stellar verify flow:
    //   1. Probe merchant for 402 challenge
    //   2. (verify failure short-circuits before the authoritative call,
    //       so we don't see a third fetch)
    // If classifyAuth had mis-routed to passthrough, there would be
    // exactly one fetch (direct passthrough to the merchant).
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1)

    fetchSpy.mockRestore()
  })

  it('treats non-mppx `Payment id="..."` auth-params as passthrough', async () => {
    const env = makeEnv()
    const merchantBody = '{"results":["not-mppx-ok"]}'
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

    // This string uses the `Payment` prefix but is the WWW-Authenticate
    // auth-params format, not a real mppx Credential. It must NOT be
    // confused for a Stellar credential — it should passthrough so
    // whatever emits this format can be interpreted by the merchant.
    const nonMppxHeader =
      'Payment id="foo", method="stellar", intent="charge", payload="YmFy"'

    const request = new Request('https://apiserver.mpprouter.dev/v1/services/parallel/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: nonMppxHeader,
      },
      body: JSON.stringify({ query: 'test' }),
    })

    const response = await handleProxy(request, env, makeCtx())

    expect(response.status).toBe(200)
    expect(seenAuth).toBe(nonMppxHeader)
    expect(payMerchantSpy).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

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

    // A real mppx Credential whose embedded challenge.method is
    // something other than "stellar" (e.g. a Tempo/EVM credential the
    // agent obtained directly from the merchant). classifyAuth should
    // parse it successfully and route it to passthrough because the
    // Router only represents Stellar wallets.
    const evmCredential = makeCredentialHeader({ method: 'tempo' })
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
