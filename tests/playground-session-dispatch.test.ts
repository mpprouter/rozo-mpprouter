/**
 * Upstream dispatch: which payment seam a playground call uses, and what
 * happens to the caller's reservation when a session merchant has no channel.
 *
 * `src/mpp/tempo-client.ts` is mocked at the module boundary so the two seams
 * (`payMerchant` / `payMerchantSession`) are observable without any real
 * payment machinery. That is the point of these tests: the bug worth catching
 * is paying a session merchant through the charge seam (or vice versa), which
 * no amount of testing the seams themselves would reveal.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Real error class — the dispatcher branches on `instanceof`. */
class ChannelNotInstalledError extends Error {
  constructor(public readonly merchantId: string) {
    super(`No Tempo channel installed for merchant "${merchantId}". Run scripts/open-channel.ts to open one.`)
    this.name = 'ChannelNotInstalledError'
  }
}

const payMerchant = vi.fn()
const payMerchantSession = vi.fn()

/** Real error class — the dispatcher branches on `instanceof` for this too. */
class BudgetExceededError extends Error {
  constructor(
    public readonly merchantUrl: string,
    public readonly requestedRaw: string,
    public readonly maxRaw: string,
  ) {
    super(`Merchant asked for ${requestedRaw} but ceiling is ${maxRaw}.`)
    this.name = 'BudgetExceededError'
  }
}

vi.mock('../src/mpp/tempo-client', () => ({
  BudgetExceededError,
  ChannelNotInstalledError,
  payMerchant: (...args: unknown[]) => payMerchant(...args),
  payMerchantSession: (...args: unknown[]) => payMerchantSession(...args),
}))

const { callUpstream, resolvePlaygroundRoute, UpstreamError } = await import(
  '../src/playground/upstream'
)
const { handlePlaygroundChat, handlePlaygroundTxDecode } = await import(
  '../src/routes/playground'
)
const { PLAYGROUND_MODELS, TIER_PRICE_USD, findModel } = await import('../src/playground/models')
const { parseUsd } = await import('../src/playground/amount')
const { createIntent, openIntent, readAccount } = await import(
  '../src/playground/ledger-client'
)
const { mintSessionToken } = await import('../src/playground/session-token')
const { makePlaygroundLedgerMock } = await import('./helpers/playground-ledger-mock')
const { makeAtomicStoreMock } = await import('./helpers/atomic-store-mock')
import type { Env } from '../src/index'

const SECRET = 'playground-test-secret-not-a-real-key'
const ALICE = 'GA6SKSJLJ3E33KKDNB3UDBRIECIBQKGYLGXLCBTXNQ7WWJ27BMDUH6JW'
const ROUTER = 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV'

/**
 * Minimal KV mock. `getTempoChannel` reads channel state from MPP_STORE, and
 * the session failure path compares the cumulative watermark before and after
 * to decide whether a voucher was signed — so these tests need a real store.
 */
function makeKv(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    store: map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => void map.set(k, v),
    delete: async (k: string) => void map.delete(k),
  }
}

function makeEnv(kvSeed: Record<string, string> = {}): Env {
  return {
    PLAYGROUND_LEDGER: makePlaygroundLedgerMock(),
    PLAYGROUND_ENABLED: 'true',
    PLAYGROUND_SESSION_SECRET: SECRET,
    // Turnstile off by default in tests; the dedicated suite flips it on.
    PLAYGROUND_TURNSTILE_DISABLED: 'true',
    STELLAR_ROUTER_PUBLIC: ROUTER,
    MPP_STORE: makeKv(kvSeed),
  } as unknown as Env
}

/** A $1 ceiling — far above any real playground price, for seam-selection tests. */
const ANY_BUDGET = parseUsd('1')

function completion(text = 'hello from the model') {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function fund(env: Env, usd: string) {
  const now = Date.now()
  const intent = await createIntent(env, {
    intentId: `fund-${Math.random().toString(16).slice(2)}`,
    account: ALICE,
    amountAtomic: parseUsd(usd),
    memo: `pg-${Math.random().toString(16).slice(2, 22)}`,
    destination: ROUTER,
    now,
    expiresAt: now + 600_000,
  })
  if (!intent.ok) throw new Error(intent.code)
  await openIntent(env, {
    intentId: intent.value.intent_id,
    txHash: Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64),
    opIndex: 0,
    now,
    confirmedAt: now,
    sessionJti: 'j',
    sessionExp: Math.floor(now / 1000) + 3600,
  })
}

async function token(): Promise<string> {
  const { token } = await mintSessionToken(SECRET, {
    account: ALICE,
    jti: 'jti-dispatch',
    now: Date.now(),
    ttlSeconds: 3600,
  })
  return token
}

function chatRequest(model: string, bearer: string, callId?: string): Request {
  return new Request('https://apiserver.example/v1/playground/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      model,
      ...(callId ? { call_id: callId } : {}),
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
}

beforeEach(() => {
  payMerchant.mockReset()
  payMerchantSession.mockReset()
})

describe('seam selection', () => {
  it('routes a tempo.charge route through payMerchant', async () => {
    const env = makeEnv()
    payMerchant.mockResolvedValue(completion())
    const route = resolvePlaygroundRoute('/v1/services/groq/chat', 'POST')
    expect(route.upstreamPaymentMethod).toBe('tempo.charge')

    await callUpstream(env, { route, body: { model: 'llama-3.1-8b-instant' }, budgetAtomic: ANY_BUDGET })

    expect(payMerchant).toHaveBeenCalledTimes(1)
    expect(payMerchantSession).not.toHaveBeenCalled()
  })

  it('routes a tempo.session route through payMerchantSession, keyed by route.id', async () => {
    const env = makeEnv()
    payMerchantSession.mockResolvedValue({ response: completion(), channelBefore: { cumulativeRaw: '0' } })
    const route = resolvePlaygroundRoute('/v1/services/openai/chat', 'POST')
    expect(route.upstreamPaymentMethod).toBe('tempo.session')

    await callUpstream(env, { route, body: { model: 'gpt-4o-mini' }, budgetAtomic: ANY_BUDGET })

    expect(payMerchantSession).toHaveBeenCalledTimes(1)
    expect(payMerchant).not.toHaveBeenCalled()
    // The channel is keyed by merchant id — a wrong key silently misses the
    // channel and looks like "not installed".
    const [, merchantId, merchantUrl] = payMerchantSession.mock.calls[0]
    expect(merchantId).toBe(route.id)
    expect(merchantUrl).toContain(route.upstreamHost)
  })

  it('routes the anthropic chat_completions route through the CHARGE seam', async () => {
    // The overlay pins tempo.charge because production KV holds no channel
    // for this route, yet its 2026-08-09 paid verification succeeded. Sending
    // these models down the session path would 503 in production.
    const env = makeEnv()
    payMerchant.mockResolvedValue(completion())
    const route = resolvePlaygroundRoute('/v1/services/anthropic/chat_completions', 'POST')
    expect(route.upstreamPaymentMethod).toBe('tempo.charge')

    await callUpstream(env, { route, body: { model: 'claude-opus-5' }, budgetAtomic: ANY_BUDGET })

    expect(payMerchant).toHaveBeenCalledTimes(1)
    expect(payMerchantSession).not.toHaveBeenCalled()
  })

  it('routes the openai chat route through the session seam too', async () => {
    const env = makeEnv()
    payMerchantSession.mockResolvedValue({ response: completion(), channelBefore: { cumulativeRaw: '0' } })
    const route = resolvePlaygroundRoute('/v1/services/openai/chat', 'POST')
    expect(route.upstreamPaymentMethod).toBe('tempo.session')

    await callUpstream(env, { route, body: { model: 'gpt-4o-mini' }, budgetAtomic: ANY_BUDGET })

    expect(payMerchantSession).toHaveBeenCalledTimes(1)
    expect(payMerchantSession.mock.calls[0][1]).toBe('openai_chat')
  })

  it('never pays for a router-held-credential route', async () => {
    // Mercury is served with the router's own JWT — no Tempo payment at all.
    // ATOMIC_STORE backs the shared daily rate-limit counter that Mercury
    // calls consume — see consumeUpstreamRateLimit in upstream.ts.
    const env = {
      ...makeEnv(),
      ATOMIC_STORE: makeAtomicStoreMock(),
      MERCURYDATA_MAINNET_JWT: 'test-token',
    } as Env
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(completion())
    const route = resolvePlaygroundRoute('/v1/services/mercury/txs/by-hash', 'GET')

    await callUpstream(env, { route, query: { tx_hash: 'a'.repeat(64) }, budgetAtomic: ANY_BUDGET })

    expect(payMerchant).not.toHaveBeenCalled()
    expect(payMerchantSession).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('channel not installed', () => {
  it('maps ChannelNotInstalledError to a 503 UpstreamError', async () => {
    const env = makeEnv()
    payMerchantSession.mockRejectedValue(new ChannelNotInstalledError('openai_chat'))
    const route = resolvePlaygroundRoute('/v1/services/openai/chat', 'POST')

    await expect(
      callUpstream(env, { route, body: {}, budgetAtomic: ANY_BUDGET }),
    ).rejects.toMatchObject({
      code: 'session_channel_not_installed',
      status: 503,
    })
  })

  it('releases the reservation so an unprovisioned channel never bills the user', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchantSession.mockRejectedValue(new ChannelNotInstalledError('openai_chat'))

    const response = await handlePlaygroundChat(chatRequest('gpt-4o-mini', bearer, 'call-nochan'), env)

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error).toBe('session_channel_not_installed')
    expect(body.charged_usd).toBe('0.00')

    // The whole hold came back — the balance is untouched.
    const account = await readAccount(env, ALICE)
    expect(account.ok).toBe(true)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('1').toString())
    expect(account.value.calls[0].status).toBe('released')
    expect(account.value.calls[0].charged).toBe('0')
  })

  it('CHARGES a paid call whose merchant answered with a 5xx', async () => {
    // P0-3: reaching a response means the merchant answered our PAID retry.
    // The money left the router, so refunding the user here would hand out
    // free upstream calls to anyone who can make the response leg fail.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    // A 402→pay→retry that ends 5xx: the credential WAS signed, so the seam
    // fires onCredentialSigned before returning the failing response.
    payMerchant.mockImplementation(async (_e, _u, _i, opts) => {
      opts?.onCredentialSigned?.()
      return new Response('nope', { status: 500 })
    })

    const response = await handlePlaygroundChat(
      chatRequest('llama-3.1-8b-instant', bearer, 'call-500'),
      env,
    )
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.charged_usd).toBe('0.02')
    expect(body.support_note).toMatch(/paid but did not return/i)

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('0.98').toString())
    expect(account.value.calls[0].status).toBe('committed')
  })

  it('CHARGES an ambiguous charge-mode failure (lost response / timeout)', async () => {
    // We cannot prove the transfer did not happen, so we must not refund.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    // Credential signed, then the connection died before the response — the
    // "money may have moved" case, which must charge.
    payMerchant.mockImplementation(async (_e, _u, _i, opts) => {
      opts?.onCredentialSigned?.()
      throw new Error('network timeout after dispatch')
    })

    const response = await handlePlaygroundChat(
      chatRequest('llama-3.1-8b-instant', bearer, 'call-timeout'),
      env,
    )
    expect(response.status).toBe(502)
    expect((await response.json()).charged_usd).toBe('0.02')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('0.98').toString())
  })

  it('CHARGES a session failure once the voucher has been signed', async () => {
    // The signal is call-local: onCredentialSigned fires the moment the
    // voucher is signed, before the merchant's final response. A failure after
    // that must charge — the money committed.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchantSession.mockImplementation(async (_e, _id, _u, _i, opts) => {
      opts?.onCredentialSigned?.()
      throw new Error('merchant connection reset after voucher')
    })

    const response = await handlePlaygroundChat(
      chatRequest('gpt-4o-mini', bearer, 'call-voucher-signed'),
      env,
    )
    expect(response.status).toBe(502)
    expect((await response.json()).charged_usd).toBe('0.02')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('0.98').toString())
  })

  it('RELEASES a session failure when no voucher was ever signed', async () => {
    // onCredentialSigned never fires (e.g. an initial non-402 error), so
    // nothing was paid — the user keeps their full credit.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchantSession.mockRejectedValue(new Error('merchant refused the connection'))

    const response = await handlePlaygroundChat(
      chatRequest('gpt-4o-mini', bearer, 'call-no-voucher'),
      env,
    )
    expect(response.status).toBe(502)
    expect((await response.json()).charged_usd).toBe('0.00')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('1').toString())
    expect(account.value.calls[0].status).toBe('released')
  })

  it('does not echo the upstream error body back to the caller', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockResolvedValue(
      new Response('{"internal":"secret-upstream-detail"}', { status: 500 }),
    )

    const response = await handlePlaygroundChat(
      chatRequest('llama-3.1-8b-instant', bearer, 'call-leak'),
      env,
    )
    expect(await response.text()).not.toContain('secret-upstream-detail')
  })
})

describe('tier pricing through the full call path', () => {
  it('charges the cheap tier price for a cheap model', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockResolvedValue(completion())

    const response = await handlePlaygroundChat(
      chatRequest('llama-3.1-8b-instant', bearer, 'call-cheap'),
      env,
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.charged_usd).toBe('0.02')
    expect(body.balance_usd).toBe('0.98')
    expect(body.message).toBe('hello from the model')
  })

  it('charges the flagship tier price for a flagship model', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockResolvedValue(completion())

    const response = await handlePlaygroundChat(
      chatRequest('claude-opus-5', bearer, 'call-flagship'),
      env,
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.charged_usd).toBe('0.10')
    expect(body.balance_usd).toBe('0.90')
    expect(body.model).toBe('claude-opus-5')
  })

  it('prices anthropic haiku at the cheap tier despite sharing the flagship route', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockResolvedValue(completion())

    const response = await handlePlaygroundChat(
      chatRequest('claude-haiku-4-5', bearer, 'call-haiku'),
      env,
    )
    expect((await response.json()).charged_usd).toBe('0.02')
  })

  it('forces max_tokens and passes through only role/content', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockResolvedValue(completion())

    const request = new Request('https://apiserver.example/v1/playground/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        // Every one of these must be dropped: they are the fields that turn a
        // flat-priced demo call into an unbounded bill.
        max_tokens: 100000,
        stream: true,
        tools: [{ type: 'function' }],
        n: 50,
        messages: [{ role: 'user', content: 'hi', extra: 'dropped' }],
      }),
    })
    await handlePlaygroundChat(request, env)

    const sent = JSON.parse(payMerchant.mock.calls[0][2].body)
    expect(sent.max_tokens).toBe(800)
    expect(sent.stream).toBe(false)
    expect(sent.tools).toBeUndefined()
    expect(sent.n).toBeUndefined()
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('a retried call_id returns the recorded outcome without a second upstream call', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockResolvedValue(completion())

    await handlePlaygroundChat(chatRequest('llama-3.1-8b-instant', bearer, 'call-retry'), env)
    expect(payMerchant).toHaveBeenCalledTimes(1)

    const retry = await handlePlaygroundChat(
      chatRequest('llama-3.1-8b-instant', bearer, 'call-retry'),
      env,
    )
    const body = await retry.json()
    expect(body.replayed).toBe(true)
    expect(body.charged_usd).toBe('0.02')
    expect(body.balance_usd).toBe('0.98')
    // The upstream was NOT called a second time.
    expect(payMerchant).toHaveBeenCalledTimes(1)
  })
})

describe('model catalog after the session-seam promotion', () => {
  it('makes the flagship Claude models callable', () => {
    for (const id of ['claude-opus-5', 'claude-sonnet-5']) {
      const model = findModel(id)!
      expect(model.available).toBe(true)
      expect(model.tier).toBe('flagship')
      expect(TIER_PRICE_USD[model.tier]).toBe('0.10')
    }
  })

  it('pins gpt-4o-mini as the only callable OpenAI model, in the cheap tier', () => {
    const openai = PLAYGROUND_MODELS.filter(m => m.provider === 'openai')
    const callable = openai.filter(m => m.available)
    expect(callable.map(m => m.id)).toEqual(['gpt-4o-mini'])
    expect(callable[0].tier).toBe('cheap')
    // The flagship OpenAI slot stays unavailable: no verified id exists.
    const flagship = openai.filter(m => m.tier === 'flagship')
    expect(flagship.every(m => !m.available)).toBe(true)
    expect(flagship[0].unavailableReason).toMatch(/no flagship openai model/i)
  })

  it('keeps every callable model on a seam that can actually pay in production', () => {
    // A model whose route resolves to tempo.session needs a channel in KV.
    // As of 2026-08-13 production has channels for openai_chat,
    // anthropic_messages, openrouter_chat, gemini_generate, dune_execute and
    // tempo_rpc — notably NOT anthropic_chat_completions, which is why that
    // route is pinned to tempo.charge in the overlay.
    const CHANNELS = new Set([
      'openai_chat',
      'anthropic_messages',
      'openrouter_chat',
      'gemini_generate',
      'dune_execute',
      'tempo_rpc',
    ])
    for (const model of PLAYGROUND_MODELS.filter(m => m.available)) {
      const route = resolvePlaygroundRoute(model.routePublicPath, model.routeMethod)
      if (route.upstreamPaymentMethod === 'tempo.session') {
        expect(CHANNELS.has(route.id)).toBe(true)
      }
    }
  })

  it('pins anthropic chat_completions to charge, matching the missing prod channel', () => {
    const route = resolvePlaygroundRoute('/v1/services/anthropic/chat_completions', 'POST')
    expect(route.upstreamPaymentMethod).toBe('tempo.charge')
    expect(route.verifiedMode).toBe('charge')
  })

  it('carries no unverified Claude model ids', () => {
    // Retired/invented ids 404 at the merchant AFTER the router has paid.
    const verified = new Set(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'])
    for (const m of PLAYGROUND_MODELS) {
      if (m.provider === 'anthropic') expect(verified.has(m.id)).toBe(true)
    }
  })
})

describe('upstream budget ceiling (P0-2)', () => {
  it('refuses to call a paid route with no budget set', async () => {
    // A missing ceiling is a programming error, and defaulting to "unlimited"
    // is exactly the failure the ceiling exists to prevent.
    const env = makeEnv()
    const route = resolvePlaygroundRoute('/v1/services/groq/chat', 'POST')
    await expect(callUpstream(env, { route, body: {} })).rejects.toMatchObject({
      code: 'budget_not_set',
      paymentEvidence: 'no',
    })
    expect(payMerchant).not.toHaveBeenCalled()
  })

  it('passes the ceiling to payMerchant as USDC-6 base units', async () => {
    const env = makeEnv()
    payMerchant.mockResolvedValue(completion())
    const route = resolvePlaygroundRoute('/v1/services/groq/chat', 'POST')

    await callUpstream(env, { route, body: {}, budgetAtomic: parseUsd('0.02') })

    // $0.02 = 200000 atomic (7dp) = 20000 base units (6dp).
    expect(payMerchant.mock.calls[0][3]).toMatchObject({ maxAmountRaw: '20000' })
  })

  it('passes the ceiling to payMerchantSession too', async () => {
    const env = makeEnv()
    payMerchantSession.mockResolvedValue({
      response: completion(),
      channelBefore: { cumulativeRaw: '0' },
    })
    const route = resolvePlaygroundRoute('/v1/services/openai/chat', 'POST')

    await callUpstream(env, { route, body: {}, budgetAtomic: parseUsd('0.08') })

    expect(payMerchantSession.mock.calls[0][4]).toMatchObject({ maxAmountRaw: '80000' })
  })

  it('releases the hold when the merchant asks for more than budget', async () => {
    // Refused inside onChallenge, before signing — provably unpaid.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockRejectedValue(
      new BudgetExceededError('https://groq.example', '5000000', '20000'),
    )

    const response = await handlePlaygroundChat(
      chatRequest('llama-3.1-8b-instant', bearer, 'call-overbudget'),
      env,
    )
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error).toBe('upstream_over_budget')
    expect(body.charged_usd).toBe('0.00')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('1').toString())
  })

  it('never charges the user more than the flat tier price even if upstream costs more', async () => {
    // The user price and the router's exposure are independent constants.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockResolvedValue(completion())

    const response = await handlePlaygroundChat(
      chatRequest('llama-3.1-8b-instant', bearer, 'call-flat'),
      env,
    )
    expect((await response.json()).charged_usd).toBe(TIER_PRICE_USD.cheap)
  })
})

describe('router-held-credential routes never charge the user on failure', () => {
  it('releases the hold when Mercury fails — no payment is ever made there', async () => {
    const env = {
      ...makeEnv(),
      ATOMIC_STORE: makeAtomicStoreMock(),
      MERCURYDATA_MAINNET_JWT: 'test-token',
    } as Env
    await fund(env, '1')
    const bearer = await token()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('upstream down', { status: 503 }))

    const request = new Request('https://apiserver.example/v1/playground/tx-decode', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ call_id: 'call-mercury', tx_hash: 'a'.repeat(64) }),
    })
    const response = await handlePlaygroundTxDecode(request, env)
    expect(response.status).toBe(502)
    expect((await response.json()).charged_usd).toBe('0.00')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('1').toString())
    fetchSpy.mockRestore()
  })
})

describe('payment evidence is call-local, not route-wide (P0-3 hardening)', () => {
  it('concurrent same-route calls do not cross-charge on one failing', async () => {
    // The old watermark inference was route-wide: a concurrent call advancing
    // the channel cumulative could make an UNPAID sibling look paid. With a
    // call-local signing flag, each call's outcome depends only on whether ITS
    // OWN credential was signed.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()

    // Call A signs a voucher then fails (must charge). Call B never signs
    // (must release). They run against the same route concurrently. The mock
    // branches on the request body's marker message — NOT on invocation order,
    // which races under Promise.all — so the outcome is deterministic and the
    // test actually isolates call-locality rather than scheduling luck.
    payMerchantSession.mockImplementation(async (_e, _id, _u, init, opts) => {
      const sentBody = String((init as any)?.body ?? '')
      if (sentBody.includes('SIGN_THEN_FAIL')) {
        opts?.onCredentialSigned?.()
        throw new Error('A: reset after voucher')
      }
      throw new Error('B: refused before any voucher')
    })

    const reqA = new Request('https://apiserver.example/v1/playground/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        call_id: 'concurrent-A',
        messages: [{ role: 'user', content: 'SIGN_THEN_FAIL' }],
      }),
    })
    const reqB = new Request('https://apiserver.example/v1/playground/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        call_id: 'concurrent-B',
        messages: [{ role: 'user', content: 'REFUSE_BEFORE_SIGN' }],
      }),
    })
    const [ra, rb] = await Promise.all([
      handlePlaygroundChat(reqA, env),
      handlePlaygroundChat(reqB, env),
    ])
    const [ba, bb] = [await ra.json(), await rb.json()]

    // A signed → charged; B never signed → refunded. No cross-contamination.
    expect(ba.charged_usd).toBe('0.02')
    expect(bb.charged_usd).toBe('0.00')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    const callA = account.value.calls.find(c => c.call_id === 'concurrent-A')!
    const callB = account.value.calls.find(c => c.call_id === 'concurrent-B')!
    expect(callA.status).toBe('committed')
    expect(callB.status).toBe('released')
    // Exactly one $0.02 charge landed.
    expect(account.value.balance).toBe(parseUsd('0.98').toString())
  })

  it('an initial non-402 500 releases (no credential ever signed)', async () => {
    // mppx returns the merchant's 500 without ever raising a 402, so
    // onChallenge — and onCredentialSigned — never fire.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockResolvedValue(new Response('down', { status: 500 }))

    const response = await handlePlaygroundChat(
      chatRequest('llama-3.1-8b-instant', bearer, 'initial-500'),
      env,
    )
    expect(response.status).toBe(502)
    expect((await response.json()).charged_usd).toBe('0.00')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('1').toString())
    expect(account.value.calls[0].status).toBe('released')
  })
})

describe('paid flag is the single source of truth (settlement precision)', () => {
  it('RELEASES when createCredential throws — nothing was ever signed', async () => {
    // The callback fires only AFTER createCredential returns. A throw inside it
    // leaves paid=false, so the user is refunded. This models the seam's real
    // ordering; the mock does NOT call onCredentialSigned.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockImplementation(async () => {
      // createCredential threw inside onChallenge → no signal, then reject.
      throw new Error('createCredential failed to sign')
    })

    const response = await handlePlaygroundChat(
      chatRequest('llama-3.1-8b-instant', bearer, 'sign-threw'),
      env,
    )
    expect(response.status).toBe(502)
    expect((await response.json()).charged_usd).toBe('0.00')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('1').toString())
    expect(account.value.calls[0].status).toBe('released')
  })

  it('COMMITS a budget-exceeded failure when an EARLIER challenge already signed', async () => {
    // A first challenge signs (onCredentialSigned fires), a second challenge
    // then exceeds budget and throws BudgetExceededError. Because settlement is
    // keyed on the paid flag — not the exception type — this must COMMIT, not
    // release: money already moved on the first voucher.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchantSession.mockImplementation(async (_e, _id, _u, _i, opts) => {
      // Simulate the seam signing once, then a later challenge over budget.
      opts?.onCredentialSigned?.()
      throw new BudgetExceededError('https://openai.example', '9999999', '80000')
    })

    const response = await handlePlaygroundChat(
      chatRequest('gpt-4o-mini', bearer, 'budget-after-sign'),
      env,
    )
    expect(response.status).toBe(502)
    expect((await response.json()).error).toBe('upstream_over_budget')
    // Charged, because a credential was signed before the budget breach.
    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('0.98').toString())
    expect(account.value.calls.find(c => c.call_id === 'budget-after-sign')!.status).toBe(
      'committed',
    )
  })

  it('still RELEASES a budget-exceeded failure when NOTHING was signed first', async () => {
    // The common case: budget exceeded on the very first challenge, no
    // signature. paid=false → release.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockRejectedValue(
      new BudgetExceededError('https://groq.example', '9999999', '20000'),
    )

    const response = await handlePlaygroundChat(
      chatRequest('llama-3.1-8b-instant', bearer, 'budget-no-sign'),
      env,
    )
    expect(response.status).toBe(502)
    expect((await response.json()).charged_usd).toBe('0.00')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('1').toString())
  })
})
