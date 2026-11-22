/**
 * Checkout intake stop (`admin stop checkout-intake`): no NEW merchant-invoice
 * order while paused; delivery and the delivery switch are independent.
 *
 * Design: ainative docs/design/20261122-stop-new-openrouter-orders-switch.zh.md
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECKOUT_CONTROL_KEY,
  CHECKOUT_INTAKE_KEY,
  readCheckoutControl,
  readCheckoutIntake,
  resumeCheckoutIntake,
  stopCheckout,
  stopCheckoutIntake,
} from '../src/routes/checkout-control'
import { handleCheckoutControl } from '../src/routes/checkout-control-admin'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import { casRead, casUpdate } from '../src/routes/stripe-atomic'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

const CONTROL_SECRET = 'test-control-secret'
const REQ = { reason: 'coinbase incident drill', actor: 'test', requestId: 'req-1' }

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
  }
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    MPP_STORE: makeKv(),
    ATOMIC_STORE: makeAtomicStoreMock(),
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-rozo-key',
    CHECKOUT_CONTROL_SECRET: CONTROL_SECRET,
    ...overrides,
  } as unknown as Env
}

function adminRequest(body?: unknown, secret = CONTROL_SECRET): Request {
  return new Request('https://apiserver.mpprouter.dev/admin/checkout-control', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-admin-secret': secret, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function createRequest(body: Record<string, unknown>): Request {
  return new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/create-invoice', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
    body: JSON.stringify(body),
  })
}

/** Every upstream call is counted and fails; a paused create must make none. */
function stubUpstream() {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input instanceof Request ? input.url : input))
      return new Response('upstream down', { status: 502 })
    }),
  )
  return urls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('intake switch semantics', () => {
  it('absent key accepts orders, stop pauses, a second stop keeps the first who/why', async () => {
    const env = makeEnv()
    expect((await readCheckoutIntake(env)).paused).toBe(false)
    expect((await stopCheckoutIntake(env, REQ)).changed).toBe(true)
    const r1 = await readCheckoutIntake(env)
    expect(r1.paused).toBe(true)
    expect(r1.state?.reason).toBe('coinbase incident drill')
    expect((await stopCheckoutIntake(env, { ...REQ, reason: 'other', requestId: 'req-2' })).changed).toBe(false)
    const r2 = await readCheckoutIntake(env)
    expect(r2.version).toBeGreaterThan(r1.version)
    expect(r2.state?.reason).toBe('coinbase incident drill')
  })

  it('a repeated stop while paused invalidates a resume prepared before it', async () => {
    const env = makeEnv()
    await stopCheckoutIntake(env, REQ)
    const seen = await readCheckoutIntake(env)
    await stopCheckoutIntake(env, { ...REQ, reason: 'still bad', requestId: 'req-3' })
    expect((await resumeCheckoutIntake(env, { ...REQ, requestId: 'r' }, seen.version)).ok).toBe(false)
    expect((await readCheckoutIntake(env)).paused).toBe(true)
  })

  it('fails closed on a corrupt value and on an unreadable store', async () => {
    const env = makeEnv()
    await casUpdate(env, CHECKOUT_INTAKE_KEY, () => ({ op: 'set', value: 'not json', result: true }))
    const corrupt = await readCheckoutIntake(env)
    expect(corrupt.paused).toBe(true)
    expect(corrupt.error).toMatch(/unparseable/)
    const broken = makeEnv({
      ATOMIC_STORE: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }) },
    })
    expect((await readCheckoutIntake(broken)).paused).toBe(true)
  })

  it('resume is conditional on the version read: a stop in between wins', async () => {
    const env = makeEnv()
    await stopCheckoutIntake(env, REQ)
    const seen = await readCheckoutIntake(env)
    expect((await resumeCheckoutIntake(env, { ...REQ, requestId: 'r1' }, seen.version)).ok).toBe(true)
    await stopCheckoutIntake(env, { ...REQ, requestId: 's2', reason: 'again' })
    const stale = await resumeCheckoutIntake(env, { ...REQ, requestId: 'r-stale' }, seen.version)
    expect(stale.ok).toBe(false)
    expect((await readCheckoutIntake(env)).paused).toBe(true)
  })

  it('intake and delivery are independent keys', async () => {
    const env = makeEnv()
    await stopCheckoutIntake(env, REQ)
    expect((await readCheckoutControl(env)).paused).toBe(false)
    expect((await casRead(env, CHECKOUT_CONTROL_KEY)).value).toBeNull()
    const env2 = makeEnv()
    await stopCheckout(env2, REQ)
    expect((await readCheckoutIntake(env2)).paused).toBe(false)
  })
})

describe('create-invoice while intake is paused', () => {
  const bodies: Array<[string, Record<string, unknown>]> = [
    ['Coinbase payment link', { url: 'https://payments.coinbase.com/payment-links/pl_intakeStop01' }],
    ['Coinbase payment session', { url: 'https://payments.coinbase.com/payment-sessions/paymentSession_0b8f7a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b' }],
    ['Stripe Crypto', { url: 'https://crypto.stripe.com/pay/CDMTestBlob_ABC123xyz' }],
    ['internal rozotest id', { payment_id: 'rozotest_10_abc_sig' }],
  ]
  for (const [label, body] of bodies) {
    it(`${label}: 503 CHECKOUT_INTAKE_PAUSED with no upstream call`, async () => {
      const env = makeEnv()
      await stopCheckoutIntake(env, REQ)
      const urls = stubUpstream()
      const res = await handleCreateInvoice(createRequest(body), env)
      expect(res.status).toBe(503)
      expect(res.headers.get('Retry-After')).toBe('300')
      const json: any = await res.json()
      expect(json.code).toBe('CHECKOUT_INTAKE_PAUSED')
      expect(json.retryable).toBe(true)
      expect(json.error).toMatch(/temporarily paused/)
      expect(urls).toEqual([])
    })
  }

  it('Bitrefill is not stopped by the intake switch (reaches its own branch)', async () => {
    const env = makeEnv()
    await stopCheckoutIntake(env, REQ)
    stubUpstream()
    const res = await handleCreateInvoice(createRequest({ provider: 'bitrefill', invoice_id: 'x' }), env)
    const json: any = await res.json().catch(() => ({}))
    expect(json.code).not.toBe('CHECKOUT_INTAKE_PAUSED')
  })

  it('the delivery stop alone, or a resumed intake, lets a create go upstream', async () => {
    const env = makeEnv()
    await stopCheckout(env, REQ)
    let urls = stubUpstream()
    let res = await handleCreateInvoice(createRequest(bodies[0][1]), env)
    expect(((await res.json()) as any).code).not.toBe('CHECKOUT_INTAKE_PAUSED')
    expect(urls.length).toBeGreaterThan(0)

    await stopCheckoutIntake(env, REQ)
    const seen = await readCheckoutIntake(env)
    await resumeCheckoutIntake(env, { ...REQ, requestId: 'r1' }, seen.version)
    vi.unstubAllGlobals()
    urls = stubUpstream()
    res = await handleCreateInvoice(createRequest(bodies[0][1]), env)
    expect(((await res.json()) as any).code).not.toBe('CHECKOUT_INTAKE_PAUSED')
    expect(urls.length).toBeGreaterThan(0)
  })
})

describe('admin endpoint: stop_intake / resume_intake', () => {
  it('GET shows intake; stop_intake verifies; resume_intake needs the version and leaves delivery alone', async () => {
    const env = makeEnv()
    const st0: any = await (await handleCheckoutControl(adminRequest(), env)).json()
    expect(st0.intake.paused).toBe(false)

    const stop: any = await (
      await handleCheckoutControl(adminRequest({ action: 'stop_intake', reason: 'drill', actor: 't', request_id: 'a1' }), env)
    ).json()
    expect(stop.verified).toBe(true)
    expect(stop.changed).toBe(true)
    const st1: any = await (await handleCheckoutControl(adminRequest(), env)).json()
    expect(st1.intake.paused).toBe(true)
    expect(st1.checkout.paused).toBe(false)

    const noVersion = await handleCheckoutControl(adminRequest({ action: 'resume_intake', reason: 'x', actor: 't', request_id: 'a2' }), env)
    expect(noVersion.status).toBe(400)
    const stale = await handleCheckoutControl(
      adminRequest({ action: 'resume_intake', reason: 'x', actor: 't', request_id: 'a3', expected_version: st1.intake.version + 5 }),
      env,
    )
    expect(stale.status).toBe(409)
    const ok: any = await (
      await handleCheckoutControl(
        adminRequest({ action: 'resume_intake', reason: 'over', actor: 't', request_id: 'a4', expected_version: st1.intake.version }),
        env,
      )
    ).json()
    expect(ok.verified).toBe(true)
    expect((await readCheckoutIntake(env)).paused).toBe(false)
  })

  it('rejects a wrong secret', async () => {
    const env = makeEnv()
    const res = await handleCheckoutControl(adminRequest({ action: 'stop_intake', reason: 'x', actor: 't', request_id: 'b' }, 'nope'), env)
    expect(res.status).toBe(401)
    expect((await readCheckoutIntake(env)).paused).toBe(false)
  })
})
