/**
 * Playground HTTP surface: the kill switch, session auth, request validation,
 * and the insufficient-balance path — plus the deterministic Blend aggregator.
 *
 * Handlers are called directly with a hand-built `Env` (house convention: a
 * partial object cast `as unknown as Env`), so no Worker runtime is needed.
 * The ledger is the real Durable Object over in-memory storage.
 *
 * Upstream merchants are never reached in these tests: every case here either
 * fails before the upstream call or is refused at the ledger. The upstream
 * seam itself is exercised by the live smoketest, not by mocking mppx.
 */

import { describe, expect, it } from 'vitest'
import type { Env } from '../src/index'
import {
  handlePlaygroundBlendActivity,
  handlePlaygroundChat,
  handlePlaygroundConfig,
  handlePlaygroundIntent,
  handlePlaygroundOpen,
  handlePlaygroundSession,
  handlePlaygroundTxDecode,
} from '../src/routes/playground'
import { parseUsd } from '../src/playground/amount'
import { createIntent, openIntent } from '../src/playground/ledger-client'
import { mintSessionToken } from '../src/playground/session-token'
import { makePlaygroundLedgerMock } from './helpers/playground-ledger-mock'
import {
  BLEND_MAIN_POOL_CONTRACT_ID,
  aggregateBlendEvents,
  classify,
  describeAggregate,
  eventName,
  extractEvents,
} from '../src/playground/blend'

const SECRET = 'playground-test-secret-not-a-real-key'
const ROUTER = 'GTESTROUTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const ALICE = 'GTESTALICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    PLAYGROUND_LEDGER: makePlaygroundLedgerMock(),
    PLAYGROUND_ENABLED: 'true',
    PLAYGROUND_SESSION_SECRET: SECRET,
    STELLAR_ROUTER_PUBLIC: ROUTER,
    ...overrides,
  } as unknown as Env
}

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`https://apiserver.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function get(path: string, token?: string): Request {
  return new Request(`https://apiserver.example${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

async function sessionFor(env: Env, account = ALICE): Promise<string> {
  const { token } = await mintSessionToken(SECRET, {
    account,
    jti: 'jti-route-test',
    now: Date.now(),
    ttlSeconds: 3600,
  })
  return token
}

/** Credit an account directly through the ledger, bypassing Horizon. */
async function fund(env: Env, usd: string, account = ALICE) {
  const now = Date.now()
  const intent = await createIntent(env, {
    intentId: `fund-${Math.random().toString(16).slice(2)}`,
    account,
    amountAtomic: parseUsd(usd),
    memo: `pg-${Math.random().toString(16).slice(2, 22)}`,
    now,
    expiresAt: now + 600_000,
  })
  if (!intent.ok) throw new Error(intent.code)
  await openIntent(env, {
    intentId: intent.value.intent_id,
    txHash: Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64),
    opIndex: 0,
    now,
    sessionJti: 'j',
    sessionExp: Math.floor(now / 1000) + 3600,
  })
}

describe('kill switch', () => {
  it('404s every playground route when PLAYGROUND_ENABLED is not exactly "true"', async () => {
    for (const value of [undefined, 'false', 'TRUE', '1', 'yes']) {
      const env = makeEnv({ PLAYGROUND_ENABLED: value })
      const token = await sessionFor(env)
      const responses = await Promise.all([
        handlePlaygroundIntent(post('/v1/playground/session/intent', { account: ALICE }), env),
        handlePlaygroundOpen(post('/v1/playground/session/open', {}), env),
        handlePlaygroundSession(get('/v1/playground/session', token), env),
        handlePlaygroundChat(post('/v1/playground/chat', {}, token), env),
        handlePlaygroundBlendActivity(post('/v1/playground/blend-activity', {}, token), env),
        handlePlaygroundTxDecode(post('/v1/playground/tx-decode', {}, token), env),
      ])
      for (const r of responses) expect(r.status).toBe(404)
    }
  })

  it('still serves config, reporting the disabled state honestly', async () => {
    const response = handlePlaygroundConfig(makeEnv({ PLAYGROUND_ENABLED: 'false' }))
    expect(response.status).toBe(200)
    expect((await response.json()).enabled).toBe(false)
  })
})

describe('GET /v1/playground/config', () => {
  it('advertises models, chips and deposit options as the single source', async () => {
    const body = await handlePlaygroundConfig(makeEnv()).json()
    expect(body.enabled).toBe(true)
    expect(body.blend_pool_contract_id).toBe(BLEND_MAIN_POOL_CONTRACT_ID)
    expect(body.deposit_options.map((d: any) => d.amount_usd)).toEqual(['0.1', '1'])
    expect(body.refundable).toBe(false)

    const available = body.models.filter((m: any) => m.available)
    expect(available.length).toBeGreaterThan(0)
    // Unavailable models are advertised WITH a reason, not hidden.
    for (const m of body.models.filter((x: any) => !x.available)) {
      expect(typeof m.unavailable_reason).toBe('string')
      expect(m.unavailable_reason.length).toBeGreaterThan(0)
    }
    expect(body.chips.map((c: any) => c.id).sort()).toEqual([
      'blend-activity',
      'chat',
      'tx-decode',
    ])
  })
})

describe('POST /v1/playground/session/intent', () => {
  it('quotes a deposit against the configured router account', async () => {
    const env = makeEnv()
    const response = await handlePlaygroundIntent(
      post('/v1/playground/session/intent', { account: ALICE, amount_usd: '1' }),
      env,
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.destination).toBe(ROUTER)
    expect(body.amount_usdc).toBe('1.00')
    expect(body.memo_type).toBe('text')
    // MEMO_TEXT holds 28 bytes; the nonce must fit with room to spare.
    expect(new TextEncoder().encode(body.memo).length).toBeLessThanOrEqual(28)
    expect(body.memo).toMatch(/^pg-[0-9a-f]{20}$/)
    expect(body.asset_issuer).toMatch(/^GA5ZSEJ/)
  })

  it('rejects a non-Stellar account', async () => {
    const env = makeEnv()
    for (const account of ['', 'not-an-address', '0x1234', 'M' + 'A'.repeat(55)]) {
      const r = await handlePlaygroundIntent(
        post('/v1/playground/session/intent', { account }),
        env,
      )
      expect(r.status).toBe(400)
      expect((await r.json()).error).toBe('invalid_account')
    }
  })

  it('rejects an amount that is not one of the offered options', async () => {
    const env = makeEnv()
    const r = await handlePlaygroundIntent(
      post('/v1/playground/session/intent', { account: ALICE, amount_usd: '500' }),
      env,
    )
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('invalid_amount')
  })

  it('refuses to quote when no receiving account is configured', async () => {
    // Quoting a wrong destination would send a real user's funds nowhere.
    const env = makeEnv({ STELLAR_ROUTER_PUBLIC: undefined })
    const r = await handlePlaygroundIntent(
      post('/v1/playground/session/intent', { account: ALICE }),
      env,
    )
    expect(r.status).toBe(503)
    expect((await r.json()).error).toBe('not_configured')
  })

  it('surfaces the global cap refusal as a 403', async () => {
    const env = makeEnv({ PLAYGROUND_GLOBAL_CAP_USD: '0.1' })
    const r = await handlePlaygroundIntent(
      post('/v1/playground/session/intent', { account: ALICE, amount_usd: '1' }),
      env,
    )
    expect(r.status).toBe(403)
    expect((await r.json()).error).toBe('global_cap_exceeded')
  })
})

describe('POST /v1/playground/session/open', () => {
  it('rejects a malformed tx_hash before touching the ledger', async () => {
    const env = makeEnv()
    const r = await handlePlaygroundOpen(
      post('/v1/playground/session/open', { intent_id: 'x', tx_hash: 'nope' }),
      env,
    )
    expect(r.status).toBe(400)
  })

  it('404s an unknown intent', async () => {
    const env = makeEnv()
    const r = await handlePlaygroundOpen(
      post('/v1/playground/session/open', {
        intent_id: 'does-not-exist',
        tx_hash: 'a'.repeat(64),
      }),
      env,
    )
    expect(r.status).toBe(404)
    expect((await r.json()).error).toBe('intent_not_found')
  })
})

describe('session auth', () => {
  it('401s without a bearer token', async () => {
    const env = makeEnv()
    const r = await handlePlaygroundSession(get('/v1/playground/session'), env)
    expect(r.status).toBe(401)
    expect((await r.json()).error).toBe('missing_session')
  })

  it('401s a tampered token', async () => {
    const env = makeEnv()
    const token = await sessionFor(env)
    const [payload, mac] = token.split('.')
    const r = await handlePlaygroundSession(
      get('/v1/playground/session', `${payload}.${mac.slice(0, -2)}XY`),
      env,
    )
    expect(r.status).toBe(401)
    expect((await r.json()).error).toBe('session_bad_signature')
  })

  it('401s an expired token', async () => {
    const env = makeEnv()
    const { token } = await mintSessionToken(SECRET, {
      account: ALICE,
      jti: 'j',
      now: Date.now() - 10_000,
      ttlSeconds: 1,
    })
    const r = await handlePlaygroundSession(get('/v1/playground/session', token), env)
    expect(r.status).toBe(401)
    expect((await r.json()).error).toBe('session_expired')
  })

  it('503s rather than authenticating anyone when the secret is unset', async () => {
    // Must be a structurally valid token: a malformed one is rejected on shape
    // before the secret is ever consulted, which would test nothing.
    const token = await sessionFor(makeEnv())
    const env = makeEnv({ PLAYGROUND_SESSION_SECRET: undefined })
    const r = await handlePlaygroundSession(get('/v1/playground/session', token), env)
    expect(r.status).toBe(503)
    expect((await r.json()).error).toBe('not_configured')
  })

  it('returns a masked account and the call history', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const token = await sessionFor(env)
    const r = await handlePlaygroundSession(get('/v1/playground/session', token), env)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.account_masked).toBe(`${ALICE.slice(0, 6)}...${ALICE.slice(-4)}`)
    // The full address must never appear in a response body.
    expect(JSON.stringify(body)).not.toContain(ALICE)
    expect(body.balance_usd).toBe('1.00')
    expect(body.calls).toEqual([])
  })
})

describe('POST /v1/playground/chat', () => {
  it('rejects a model that is not on the allow-list, before reserving anything', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const token = await sessionFor(env)
    const r = await handlePlaygroundChat(
      post('/v1/playground/chat', { model: 'gpt-4-turbo', messages: [{ role: 'user', content: 'hi' }] }, token),
      env,
    )
    expect(r.status).toBe(400)
    const body = await r.json()
    expect(body.error).toBe('model_not_allowed')
    expect(body.allowed_models).toContain('llama-3.1-8b-instant')

    // Nothing was charged or held.
    const session = await (await handlePlaygroundSession(get('/v1/playground/session', token), env)).json()
    expect(session.balance_usd).toBe('1.00')
  })

  it('rejects a session-mode flagship model with the unavailable reason', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const token = await sessionFor(env)
    const r = await handlePlaygroundChat(
      post('/v1/playground/chat', { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }, token),
      env,
    )
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('model_unavailable')
  })

  it('rejects malformed message arrays', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const token = await sessionFor(env)
    const cases: unknown[] = [
      undefined,
      [],
      'hello',
      [{ role: 'root', content: 'x' }],
      [{ role: 'user' }],
      [{ role: 'user', content: 42 }],
      new Array(50).fill({ role: 'user', content: 'x' }),
      [{ role: 'user', content: 'x'.repeat(9000) }],
    ]
    for (const messages of cases) {
      const r = await handlePlaygroundChat(
        post('/v1/playground/chat', { model: 'llama-3.1-8b-instant', messages }, token),
        env,
      )
      expect(r.status).toBe(400)
      expect((await r.json()).error).toBe('invalid_request')
    }
  })

  it('402s with the remaining balance when the session cannot cover the call', async () => {
    const env = makeEnv()
    await fund(env, '0.1')
    const token = await sessionFor(env)
    // Drain to below the $0.02 cheap-tier price using tx-decode ($0.005)…
    // simpler: fund a fresh account with nothing at all.
    const empty = makeEnv()
    const emptyToken = await sessionFor(empty)
    const r = await handlePlaygroundChat(
      post(
        '/v1/playground/chat',
        { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'hi' }] },
        emptyToken,
      ),
      empty,
    )
    expect(r.status).toBe(402)
    const body = await r.json()
    expect(body.error).toBe('insufficient_balance')
    expect(body.balance_remaining).toBe('0.00')
    expect(body.price_usd).toBe('0.02')
  })

  it('rejects a caller-supplied call_id that is not an opaque id', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const token = await sessionFor(env)
    const r = await handlePlaygroundChat(
      post(
        '/v1/playground/chat',
        { call_id: '../../etc/passwd', model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'hi' }] },
        token,
      ),
      env,
    )
    expect(r.status).toBe(400)
  })
})

describe('POST /v1/playground/tx-decode', () => {
  it('rejects a malformed tx_hash', async () => {
    const env = makeEnv()
    await fund(env, '1')
    const token = await sessionFor(env)
    const r = await handlePlaygroundTxDecode(
      post('/v1/playground/tx-decode', { tx_hash: 'zz' }, token),
      env,
    )
    expect(r.status).toBe(400)
  })

  it('402s an unfunded session', async () => {
    const env = makeEnv()
    const token = await sessionFor(env)
    const r = await handlePlaygroundTxDecode(
      post('/v1/playground/tx-decode', { tx_hash: 'a'.repeat(64) }, token),
      env,
    )
    expect(r.status).toBe(402)
  })
})

describe('Blend aggregation', () => {
  it('unwraps every envelope shape the indexer might use', () => {
    const events = [{ topics: ['supply'] }]
    expect(extractEvents(events)).toHaveLength(1)
    expect(extractEvents({ data: events })).toHaveLength(1)
    expect(extractEvents({ events })).toHaveLength(1)
    expect(extractEvents({ _embedded: { records: events } })).toHaveLength(1)
    // An unrecognised shape yields zero events, not a crash.
    expect(extractEvents({ unexpected: true })).toHaveLength(0)
    expect(extractEvents(null)).toHaveLength(0)
  })

  it('classifies known Blend events into reported actions', () => {
    expect(classify(eventName({ topics: ['supply'] }))).toBe('deposit')
    expect(classify(eventName({ topics: ['supply_collateral'] }))).toBe('deposit')
    expect(classify(eventName({ topics: ['withdraw'] }))).toBe('withdraw')
    expect(classify(eventName({ topics: ['borrow'] }))).toBe('borrow')
    expect(classify(eventName({ topics: ['repay'] }))).toBe('repay')
    expect(classify(eventName({ topics: ['something_else'] }))).toBe('other')
  })

  it('counts and sums deterministically, and reconciles to the event count', () => {
    const events = [
      { topics: ['supply'], data: { amount: '100', from: 'GA' }, ledger: 50 },
      { topics: ['supply'], data: { amount: '250', from: 'GA' }, ledger: 52 },
      { topics: ['borrow'], data: { amount: '75', from: 'GB' }, ledger: 51 },
      { topics: ['mystery'], data: {}, ledger: 49 },
    ]
    const agg = aggregateBlendEvents(events, BLEND_MAIN_POOL_CONTRACT_ID)

    expect(agg.events_examined).toBe(4)
    expect(agg.ledger_range).toEqual({ first: 49, last: 52 })
    // Every event lands in exactly one bucket — totals always reconcile.
    expect(agg.rows.reduce((n, r) => n + r.count, 0)).toBe(4)

    const deposits = agg.rows.find(r => r.action === 'deposit')!
    expect(deposits.count).toBe(2)
    expect(deposits.total_amount).toBe('350')
    expect(deposits.unique_participants).toBe(1)

    const borrows = agg.rows.find(r => r.action === 'borrow')!
    expect(borrows.count).toBe(1)
    expect(borrows.total_amount).toBe('75')

    expect(agg.rows.find(r => r.action === 'other')!.count).toBe(1)
  })

  it('reports how many events actually carried a parseable amount', () => {
    const agg = aggregateBlendEvents(
      [
        { topics: ['supply'], data: { amount: '100' } },
        { topics: ['supply'], data: { amount: 'not-a-number' } },
      ],
      'C',
    )
    const deposits = agg.rows.find(r => r.action === 'deposit')!
    expect(deposits.count).toBe(2)
    expect(deposits.amount_samples).toBe(1)
    expect(deposits.total_amount).toBe('100')
  })

  it('produces a truthful sentence with no events at all', () => {
    const agg = aggregateBlendEvents([], 'C')
    expect(describeAggregate(agg)).toMatch(/No recent Blend pool events/)
  })
})
