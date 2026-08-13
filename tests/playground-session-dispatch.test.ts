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


/**
 * A successful CHARGE-mode upstream: fires onCredentialSigned (a real credential
 * was signed) then returns a good completion. This is what a healthy paid call
 * looks like, and it is required now that commit is gated on paid === true.
 */
const paidCharge = async (_e: unknown, _u: unknown, _i: unknown, opts: any) => {
  opts?.onCredentialSigned?.()
  return completion()
}

/** A successful SESSION-mode upstream: signs a voucher, returns a completion. */
const paidSession = async (_e: unknown, _id: unknown, _u: unknown, _i: unknown, opts: any) => {
  opts?.onCredentialSigned?.()
  return { response: completion(), channelBefore: { cumulativeRaw: '0' } }
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
    payMerchant.mockImplementation(paidCharge)
    const route = resolvePlaygroundRoute('/v1/services/groq/chat', 'POST')
    expect(route.upstreamPaymentMethod).toBe('tempo.charge')

    await callUpstream(env, { route, body: { model: 'claude-haiku-4-5' }, budgetAtomic: ANY_BUDGET })

    expect(payMerchant).toHaveBeenCalledTimes(1)
    expect(payMerchantSession).not.toHaveBeenCalled()
  })

  it('routes a tempo.session route through payMerchantSession, keyed by route.id', async () => {
    const env = makeEnv()
    payMerchantSession.mockImplementation(paidSession)
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
    payMerchant.mockImplementation(paidCharge)
    const route = resolvePlaygroundRoute('/v1/services/anthropic/chat_completions', 'POST')
    expect(route.upstreamPaymentMethod).toBe('tempo.charge')

    await callUpstream(env, { route, body: { model: 'claude-opus-5' }, budgetAtomic: ANY_BUDGET })

    expect(payMerchant).toHaveBeenCalledTimes(1)
    expect(payMerchantSession).not.toHaveBeenCalled()
  })

  it('routes the openai chat route through the session seam too', async () => {
    const env = makeEnv()
    payMerchantSession.mockImplementation(paidSession)
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

  // NOTE (2026-08-13): the handler-level "release the reservation on
  // channel-not-installed" test was removed when gpt-4o-mini — the last
  // callable SESSION-mode playground model — was dropped. No allow-listed
  // model routes to the session seam anymore, so this path cannot be reached
  // through handlePlaygroundChat. The 503 → UpstreamError mapping it relied on
  // is still covered at the route level by the test above.

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
      chatRequest('claude-haiku-4-5', bearer, 'call-500'),
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
      chatRequest('claude-haiku-4-5', bearer, 'call-timeout'),
      env,
    )
    expect(response.status).toBe(502)
    expect((await response.json()).charged_usd).toBe('0.02')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('0.98').toString())
  })

  // NOTE (2026-08-13): two handler-level SESSION-seam settlement tests
  // (charge-once-signed / release-when-unsigned, previously driven through
  // gpt-4o-mini) were removed with that model. Settlement is keyed on the
  // call-local `paid` flag that BOTH seams fire via onCredentialSigned, so the
  // identical logic is fully covered on the charge seam by "CHARGES a paid
  // call whose merchant answered with a 5xx" and "RELEASES when createCredential
  // throws" above/below. The session seam's routing is covered at the route
  // level in the seam-selection block.

  it('does not echo the upstream error body back to the caller', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockResolvedValue(
      new Response('{"internal":"secret-upstream-detail"}', { status: 500 }),
    )

    const response = await handlePlaygroundChat(
      chatRequest('claude-haiku-4-5', bearer, 'call-leak'),
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
    payMerchant.mockImplementation(paidCharge)

    const response = await handlePlaygroundChat(
      chatRequest('claude-haiku-4-5', bearer, 'call-cheap'),
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
    payMerchant.mockImplementation(paidCharge)

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
    payMerchant.mockImplementation(paidCharge)

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
    payMerchant.mockImplementation(paidCharge)

    const request = new Request('https://apiserver.example/v1/playground/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
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
    payMerchant.mockImplementation(paidCharge)

    await handlePlaygroundChat(chatRequest('claude-haiku-4-5', bearer, 'call-retry'), env)
    expect(payMerchant).toHaveBeenCalledTimes(1)

    const retry = await handlePlaygroundChat(
      chatRequest('claude-haiku-4-5', bearer, 'call-retry'),
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
  it('makes the newest flagship Claude models (opus-5 / sonnet-5 / opus-4-8) callable', () => {
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']) {
      const model = findModel(id)!
      expect(model.available).toBe(true)
      expect(model.tier).toBe('flagship')
      expect(TIER_PRICE_USD[model.tier]).toBe('0.10')
    }
  })

  it('keeps claude-haiku-4-5 as the one callable cheap/fast model', () => {
    const cheap = PLAYGROUND_MODELS.filter(m => m.tier === 'cheap')
    expect(cheap.map(m => m.id)).toEqual(['claude-haiku-4-5'])
    expect(cheap[0].available).toBe(true)
    expect(TIER_PRICE_USD.cheap).toBe('0.02')
  })

  it('drops the old models (llama / deepseek / gpt-4o-mini)', () => {
    const ids = PLAYGROUND_MODELS.map(m => m.id)
    for (const old of ['llama-3.1-8b-instant', 'deepseek-v4-flash', 'gpt-4o-mini']) {
      expect(ids).not.toContain(old)
    }
  })

  it('lists no callable OpenAI model; the flagship slot stays pending upstream verification', () => {
    const openai = PLAYGROUND_MODELS.filter(m => m.provider === 'openai')
    // No OpenAI id is verified/listed by the upstream, so none is callable —
    // a guessed gpt-5.x id would 404 AFTER the router had already paid.
    expect(openai.filter(m => m.available)).toHaveLength(0)
    const flagship = openai.filter(m => m.tier === 'flagship')
    expect(flagship.every(m => !m.available)).toBe(true)
    expect(flagship[0].unavailableReason).toMatch(/pending upstream verification/i)
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
    const verified = new Set([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-haiku-4-5',
    ])
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
    payMerchant.mockImplementation(paidCharge)
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
      chatRequest('claude-haiku-4-5', bearer, 'call-overbudget'),
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
    payMerchant.mockImplementation(paidCharge)

    const response = await handlePlaygroundChat(
      chatRequest('claude-haiku-4-5', bearer, 'call-flat'),
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

    // Call A signs a credential then fails (must charge). Call B never signs
    // (must release). They run against the same route concurrently. The mock
    // branches on the request body's marker message — NOT on invocation order,
    // which races under Promise.all — so the outcome is deterministic and the
    // test actually isolates call-locality rather than scheduling luck.
    // (Charge seam via claude-haiku-4-5 — the call-local `paid` flag is settled
    // identically on both seams; the session seam has no callable model now.)
    payMerchant.mockImplementation(async (_e, _u, init, opts) => {
      const sentBody = String((init as any)?.body ?? '')
      if (sentBody.includes('SIGN_THEN_FAIL')) {
        opts?.onCredentialSigned?.()
        throw new Error('A: reset after credential')
      }
      throw new Error('B: refused before any credential')
    })

    const reqA = new Request('https://apiserver.example/v1/playground/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        call_id: 'concurrent-A',
        messages: [{ role: 'user', content: 'SIGN_THEN_FAIL' }],
      }),
    })
    const reqB = new Request('https://apiserver.example/v1/playground/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
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
      chatRequest('claude-haiku-4-5', bearer, 'initial-500'),
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
      chatRequest('claude-haiku-4-5', bearer, 'sign-threw'),
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
    payMerchant.mockImplementation(async (_e, _u, _i, opts) => {
      // Simulate the seam signing once, then a later challenge over budget.
      opts?.onCredentialSigned?.()
      throw new BudgetExceededError('https://anthropic.example', '9999999', '80000')
    })

    const response = await handlePlaygroundChat(
      chatRequest('claude-haiku-4-5', bearer, 'budget-after-sign'),
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
      chatRequest('claude-haiku-4-5', bearer, 'budget-no-sign'),
      env,
    )
    expect(response.status).toBe(502)
    expect((await response.json()).charged_usd).toBe('0.00')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('1').toString())
  })
})

describe('the ONLY commit predicate is paid === true', () => {
  it('initial non-402 2xx with paid===false → RELEASED, user not charged', async () => {
    // Merchant served a usable 2xx body but never issued a 402, so no
    // credential was signed. The router paid nothing; the user must not be
    // charged even though the body looks fine.
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    payMerchant.mockResolvedValue(completion('a real-looking answer')) // no onCredentialSigned

    const response = await handlePlaygroundChat(
      chatRequest('claude-haiku-4-5', bearer, 'unpaid-2xx'),
      env,
    )
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error).toBe('upstream_unpaid')
    expect(body.charged_usd).toBe('0.00')

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('1').toString())
    expect(account.value.calls[0].status).toBe('released')
  })

  it('paid===true + empty body → COMMITTED (we paid; user gets error + charge + support_note)', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const bearer = await token()
    // Signs a credential, then returns an EMPTY completion.
    payMerchant.mockImplementation(async (_e: unknown, _u: unknown, _i: unknown, opts: any) => {
      opts?.onCredentialSigned?.()
      return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const response = await handlePlaygroundChat(
      chatRequest('claude-haiku-4-5', bearer, 'paid-empty'),
      env,
    )
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error).toBe('upstream_empty')
    expect(body.charged_usd).toBe('0.02')
    expect(body.support_note).toMatch(/paid but did not return/i)

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('0.98').toString())
    expect(account.value.calls[0].status).toBe('committed')
  })

  it('Mercury (router-held credential) commits on a 2xx and releases on a 5xx', async () => {
    // Mercury never signs a Tempo credential; paid = response.ok. A success is
    // billable, a failure is our quota loss, never the user's.
    const okEnv = { ...makeEnv(), ATOMIC_STORE: makeAtomicStoreMock(), MERCURYDATA_MAINNET_JWT: 't' } as Env
    await fund(okEnv, '1')
    const okToken = await token()
    const okSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ events: [] }), { status: 200 }))
    const okResp = await handlePlaygroundTxDecode(
      new Request('https://x/v1/playground/tx-decode', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${okToken}` },
        body: JSON.stringify({ call_id: 'mercury-ok', tx_hash: 'a'.repeat(64) }),
      }),
      okEnv,
    )
    expect(okResp.status).toBe(200)
    expect((await okResp.json()).charged_usd).toBe('0.005')
    okSpy.mockRestore()

    const badEnv = { ...makeEnv(), ATOMIC_STORE: makeAtomicStoreMock(), MERCURYDATA_MAINNET_JWT: 't' } as Env
    await fund(badEnv, '1')
    const badToken = await token()
    const badSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }))
    const badResp = await handlePlaygroundTxDecode(
      new Request('https://x/v1/playground/tx-decode', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${badToken}` },
        body: JSON.stringify({ call_id: 'mercury-bad', tx_hash: 'a'.repeat(64) }),
      }),
      badEnv,
    )
    expect(badResp.status).toBe(502)
    expect((await badResp.json()).charged_usd).toBe('0.00')
    const acct = await readAccount(badEnv, ALICE)
    if (!acct.ok) return
    expect(acct.value.balance).toBe(parseUsd('1').toString())
    badSpy.mockRestore()
  })
})
