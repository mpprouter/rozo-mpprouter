import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/index'
import { handleAgentCheckout, toView } from '../src/agent-checkout/routes'
import { linkArgsFromResponse, withAgentCheckoutLink } from '../src/agent-checkout/link-order'
import { normalizeAcInvoice, sha256Hex } from '../src/agent-checkout/invoice'
import type { AcResult, AcRpc, AcSpendRow } from '../src/agent-checkout/rpc'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

// ── a small in-memory stand-in for the PR-4 RPCs (only what PR-5 calls) ─────

const OPEN = new Set(['created', 'pending_approval', 'approved', 'awaiting_payment', 'paying', 'manual_review'])

function fakeDb() {
  const owners = new Map<string, { env: string; allowlisted: boolean }>()
  const bindings = new Map<string, { id: string; owner: string; env: string; status: string }>() // by credential digest
  const bindReqs = new Map<string, { id: string; owner: string; status: string; cred?: string }>() // by code digest
  const rows = new Map<string, AcSpendRow & { requester_key: string; idempotency_key: string; request_hash: string }>()
  const calls: Array<{ fn: string; args: any }> = []
  let seq = 0
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

  const rpc: AcRpc = async (fn, args: any): Promise<AcResult> => {
    calls.push({ fn, args })
    switch (fn) {
      case 'ac_spend_create': {
        let owner: string | undefined
        let requester = 'owner'
        if (args.requested_by_type === 'owner') owner = args.owner_account_id
        else {
          const b = bindings.get(args.credential_digest)
          if (!b || b.status !== 'active' || b.env !== args.environment) return { outcome: 'unauthorized_principal' }
          owner = b.owner
          requester = b.id
        }
        if (!owner || !owners.has(owner)) return { outcome: 'unauthorized_principal' }
        for (const r of rows.values()) {
          if (r.owner_account_id === owner && r.requester_key === requester && r.idempotency_key === args.idempotency_key) {
            return r.request_hash === args.request_hash ? { outcome: 'replay', request: { ...r } } : { outcome: 'conflict' }
          }
        }
        for (const r of rows.values()) {
          if (r.environment === args.environment && r.provider === args.provider && r.invoice_id === args.invoice_id && OPEN.has(r.status)) {
            return r.owner_account_id === owner
              ? { outcome: 'invoice_in_progress', spend_request_id: r.spend_request_id, display_ref: r.display_ref }
              : { outcome: 'invoice_in_progress' }
          }
        }
        const id = uuid()
        const row = {
          spend_request_id: id, display_ref: `REF${seq}`.padEnd(10, '0'), environment: args.environment,
          status: 'created', status_version: 0, provider: args.provider, invoice_id: args.invoice_id,
          entry: args.entry, requested_by_type: args.requested_by_type, owner_account_id: owner,
          requester_key: requester, idempotency_key: args.idempotency_key, request_hash: args.request_hash,
          context: args.context ?? undefined, quote_version: 0,
        } as any
        rows.set(id, row)
        return { outcome: 'created', request: { ...row } }
      }
      case 'ac_spend_present': {
        const r = rows.get(args.spend_request_id)!
        if (r.status !== 'created' || String(r.status_version) !== String(args.status_version)) return { outcome: 'state_changed', request: { ...r } }
        if (args.decision === 'reject') {
          Object.assign(r, { status: 'canceled', status_reason: args.reason, status_version: r.status_version + 1 })
          return { outcome: 'canceled', request: { ...r } }
        }
        Object.assign(r, {
          status: 'pending_approval', status_version: r.status_version + 1, quote_version: (r.quote_version ?? 0) + 1,
          invoice_amount: args.invoice_amount, fee_atomic: args.fee_atomic ?? undefined,
          total_debit_atomic: args.total_debit_atomic ?? undefined, quote_id: args.quote_id ?? undefined,
          quote_expires_at: args.quote_expires_at ?? undefined, funding_mode: 'per_payment',
          merchant_display: args.merchant_display, merchant_verified: args.merchant_verified,
          beneficiary_verified: args.beneficiary_verified, beneficiary_ref: args.beneficiary_ref ?? undefined,
          snapshot_hash: args.snapshot_hash, merchant_delivery_status: 'pending',
        })
        return { outcome: 'pending_approval', request: { ...r } }
      }
      case 'ac_spend_get': {
        const r = rows.get(args.spend_request_id)
        if (!r) return { outcome: 'not_found' }
        if (args.credential_digest) {
          const b = bindings.get(args.credential_digest)
          if (!b || b.status !== 'active' || r.requester_key !== b.id) return { outcome: 'not_found' }
          return { outcome: 'ok', request: { ...r } }
        }
        return r.owner_account_id === args.owner_account_id ? { outcome: 'ok', request: { ...r } } : { outcome: 'not_found' }
      }
      case 'ac_spend_issue_card':
        return { outcome: 'issued', funding_mode: 'per_payment', pay_token: 'a'.repeat(64), status_version: 1 }
      case 'ac_principal_resolve': {
        const b = bindings.get(args.credential_digest)
        if (b) return { outcome: b.status === 'active' ? 'active' : 'revoked', fingerprint: 'ac_x' }
        for (const br of bindReqs.values()) {
          if (br.cred === args.credential_digest && br.status === 'claimed' && owners.get(br.owner)?.env === args.environment) {
            return { outcome: 'pending_confirm', fingerprint: 'ac_x' }
          }
        }
        return { outcome: 'unknown' }
      }
      case 'ac_bind_request_create': {
        const id = uuid()
        bindReqs.set(args.bind_code_digest, { id, owner: args.owner_account_id, status: 'issued' })
        return { outcome: 'issued', bind_request_id: id, code_expires_at: '2999-01-01T00:00:00Z' }
      }
      case 'ac_bind_request_claim': {
        const br = bindReqs.get(args.bind_code_digest)
        if (!br || br.status !== 'issued') return { outcome: 'bind_code_invalid' }
        br.status = 'claimed'
        br.cred = args.credential_digest
        return { outcome: 'claimed', bind_request_id: br.id, owner_account_id: br.owner, confirm_expires_at: '2999-01-01T00:00:00Z' }
      }
      case 'ac_spend_link_order':
        return { outcome: 'linked' }
      default:
        return { outcome: 'disabled' }
    }
  }
  return { rpc, owners, bindings, rows, calls }
}

// ── env, fetch mock (agentapi quote) ────────────────────────────────────────

function makeEnv(extra: Record<string, string> = {}): Env {
  const store = new Map<string, string>()
  return {
    AC_REQUESTS_ENABLED: 'true',
    AC_SERVICE_KEY: 'svc-key-123456',
    AC_CREATE_LIMIT_PER_HOUR: '100',
    AC_CLAIM_IP_LIMIT_PER_HOUR: '100',
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    CHECKOUT_WEB_FEE_BPS: '100',
    ATOMIC_STORE: makeAtomicStoreMock(),
    MPP_STORE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
    ...extra,
  } as unknown as Env
}

const SESSION = 'paymentSession_4c1d16aa-0000-4000-8000-0000000041ee'
const SESSION_URL = `https://payments.coinbase.com/payment-sessions/${SESSION}`
let quoteStatus = 200
let quoteCalls = 0

beforeEach(() => {
  quoteStatus = 200
  quoteCalls = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u === 'https://agentapi.rozo.ai/quote-invoice') {
      quoteCalls++
      if (quoteStatus !== 200) return new Response('{"error":"x"}', { status: quoteStatus })
      return new Response(JSON.stringify({ linkId: SESSION, merchant: 'OpenRouter', invoice: { amount: '10.50', currency: 'USD' } }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
})
afterEach(() => vi.restoreAllMocks())

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222'
const AGENT_CRED = `ac_live_${'A'.repeat(43)}`

async function setup() {
  const db = fakeDb()
  db.owners.set(OWNER, { env: 'prod', allowlisted: true })
  db.owners.set(OTHER_OWNER, { env: 'prod', allowlisted: true })
  db.bindings.set(await sha256Hex(AGENT_CRED), { id: 'b-1', owner: OWNER, env: 'prod', status: 'active' })
  return db
}

function call(env: Env, rpc: AcRpc, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  return handleAgentCheckout(
    new Request(`https://mpp.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env,
    rpc,
  ) as Promise<Response>
}
const svc = (key = 'k-00000001') => ({ 'x-rozo-service-auth': 'svc-key-123456', 'idempotency-key': key })
const agent = (key = 'k-00000001', cred = AGENT_CRED) => ({ authorization: `Bearer ${cred}`, 'idempotency-key': key })

// ── tests ───────────────────────────────────────────────────────────────────

describe('agent checkout switch and auth', () => {
  it('404s every route while AC_REQUESTS_ENABLED is not true, without touching the RPC', async () => {
    const db = await setup()
    const res = await call(makeEnv({ AC_REQUESTS_ENABLED: 'false' }), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: {}, headers: agent() })
    expect(res.status).toBe(404)
    expect(db.calls).toHaveLength(0)
  })

  it('does not claim paths outside its prefix', async () => {
    const db = await setup()
    expect(await handleAgentCheckout(new Request('https://mpp.test/v1/x402/keys'), makeEnv(), db.rpc)).toBeNull()
  })

  it('answers 503 when the RPC is not configured', async () => {
    const res = await handleAgentCheckout(new Request('https://mpp.test/v1/agent-checkout/binding'), makeEnv())
    expect(res!.status).toBe(503)
  })

  it('refuses a wrong service key and a malformed credential with the same 401', async () => {
    const db = await setup()
    const a = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL }, headers: { 'x-rozo-service-auth': 'nope', 'idempotency-key': 'k-00000001' } })
    const b = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL }, headers: { authorization: 'Bearer ak_123', 'idempotency-key': 'k-00000001' } })
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(await a.json()).toEqual(await b.json())
    expect(db.calls).toHaveLength(0)
  })

  it('an unbound agent credential is refused and learns nothing', async () => {
    const db = await setup()
    const res = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', {
      body: { invoice: SESSION_URL, context: 'top up' },
      headers: agent('k-00000001', `ac_live_${'B'.repeat(43)}`),
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ error: { code: 'UNAUTHORIZED', messageKey: 'agent_checkout.unauthorized' } })
  })

  it('agents cannot use owner-only routes', async () => {
    const db = await setup()
    const id = '33333333-3333-4333-8333-333333333333'
    for (const p of [`/v1/agent-checkout/requests/${id}/present-card`, `/v1/agent-checkout/requests/${id}/cancel`, '/v1/agent-checkout/owners', '/v1/agent-checkout/bind-requests']) {
      const res = await call(makeEnv(), db.rpc, 'POST', p, { body: { ownerAccountId: OWNER, statusVersion: 1 }, headers: agent() })
      expect(res.status).toBe(404)
    }
    expect(db.calls).toHaveLength(0)
  })
})

describe('create spend request', () => {
  it('builds the snapshot from the router quote: total = invoice + 1% fee, quote id and expiry', async () => {
    const db = await setup()
    const res = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', {
      body: { invoice: SESSION_URL, context: 'OpenRouter top-up for the eval run', amount: '0.01', merchant: 'Evil' },
      headers: agent(),
    })
    expect(res.status).toBe(201)
    const present = db.calls.find((c) => c.fn === 'ac_spend_present')!.args
    expect(present.invoice_amount).toBe('10.5')
    expect(present.fee_atomic).toBe('110000')
    expect(present.total_debit_atomic).toBe('10610000')
    expect(present.merchant_display).toBe('OpenRouter')
    expect(present.merchant_verified).toBe(true)
    expect(present.quote_id).toMatch(/^q_[0-9a-f]{32}$/)
    expect(Date.parse(present.quote_expires_at)).toBeGreaterThan(Date.now())
    expect(present.snapshot_hash).toMatch(/^[0-9a-f]{64}$/)
    const create = db.calls.find((c) => c.fn === 'ac_spend_create')!.args
    expect(create.invoice_id).toBe(SESSION)
    expect(create.provider).toBe('coinbase_payment_session')
    expect(JSON.stringify(create)).not.toContain('payments.coinbase.com')
    const body = await res.json()
    expect(body.request.status).toBe('pending_approval')
    // agent view: no owner id, quote id, snapshot hash or beneficiary
    expect(body.request.ownerAccountId).toBeUndefined()
    expect(body.request.quoteId).toBeUndefined()
    expect(body.request.snapshotHash).toBeUndefined()
  })

  it('same key and same body returns the same request; same key, different body is 409', async () => {
    const db = await setup()
    const first = await (await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, context: 'c' }, headers: agent() })).json()
    const again = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION, context: 'c' }, headers: agent() })
    expect(again.status).toBe(200)
    const againBody = await again.json()
    expect(againBody.replay).toBe(true)
    expect(againBody.request.spendRequestId).toBe(first.request.spendRequestId)
    const diff = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, context: 'other' }, headers: agent() })
    expect(diff.status).toBe(409)
    expect((await diff.json()).error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('one open request per invoice across entries; another owner learns nothing', async () => {
    const db = await setup()
    const first = await (await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, context: 'c' }, headers: agent() })).json()
    const sameOwner = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, ownerAccountId: OWNER }, headers: svc('k-00000002') })
    expect(sameOwner.status).toBe(409)
    const so = await sameOwner.json()
    expect(so.error.code).toBe('INVOICE_IN_PROGRESS')
    expect(so.spendRequestId).toBe(first.request.spendRequestId)
    const other = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, ownerAccountId: OTHER_OWNER }, headers: svc('k-00000003') })
    expect(other.status).toBe(409)
    const ob = await other.json()
    expect(ob).toEqual({ error: { code: 'INVOICE_IN_PROGRESS', messageKey: 'agent_checkout.invoice_in_progress' } })
  })

  it('a transient quote failure leaves the request created (202); the same-key retry presents it', async () => {
    const db = await setup()
    quoteStatus = 503
    const first = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, context: 'c' }, headers: agent() })
    expect(first.status).toBe(202)
    const fb = await first.json()
    expect(fb.request.status).toBe('created')
    expect(fb.quoteError).toBe('QUOTE_UNAVAILABLE')
    quoteStatus = 200
    const retry = await (await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, context: 'c' }, headers: agent() })).json()
    expect(retry.replay).toBe(true)
    expect(retry.request.status).toBe('pending_approval')
    expect(retry.request.spendRequestId).toBe(fb.request.spendRequestId)
  })

  it('a used or expired invoice cancels the request (invoice_not_payable)', async () => {
    const db = await setup()
    quoteStatus = 410
    const res = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, context: 'c' }, headers: agent() })
    const body = await res.json()
    expect(body.request.status).toBe('canceled')
    expect(body.request.statusReason).toBe('invoice_not_payable')
  })

  it('agents must say why (context) and only use cli or mcp entries', async () => {
    const db = await setup()
    const noCtx = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL }, headers: agent() })
    expect((await noCtx.json()).error.code).toBe('CONTEXT_REQUIRED')
    const discord = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, context: 'c', entry: 'discord' }, headers: agent() })
    expect(discord.status).toBe(400)
  })

  it('requires an Idempotency-Key and a configured create limit', async () => {
    const db = await setup()
    const noKey = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, context: 'c' }, headers: { authorization: `Bearer ${AGENT_CRED}` } })
    expect(noKey.status).toBe(400)
    const noLimit = await call(makeEnv({ AC_CREATE_LIMIT_PER_HOUR: '' }), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, context: 'c' }, headers: agent() })
    expect(noLimit.status).toBe(503)
    expect(db.calls.filter((c) => c.fn === 'ac_spend_create')).toHaveLength(0)
  })

  it('Bitrefill is always per payment, unverified, and has no separate fee (R4, R5)', async () => {
    const db = await setup()
    const res = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', {
      body: {
        provider: 'bitrefill',
        bitrefill: { invoiceId: 'EC9482DE-1111-4111-8111-34A72B96B321', address: '0x1111111111111111111111111111111111111111', amount: '5.25', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
        fundingPreference: 'auto',
        context: 'gift card',
      },
      headers: agent(),
    })
    expect(res.status).toBe(201)
    const present = db.calls.find((c) => c.fn === 'ac_spend_present')!.args
    expect(present.funding_mode).toBe('per_payment')
    expect(present.merchant_verified).toBe(false)
    expect(present.beneficiary_verified).toBe(false)
    expect(present.fee_atomic).toBeNull()
    expect(present.total_debit_atomic).toBeNull()
    expect(db.calls.find((c) => c.fn === 'ac_spend_create')!.args.invoice_id).toBe('ec9482de-1111-4111-8111-34a72b96b321')
    expect(quoteCalls).toBe(0)
  })
})

describe('read', () => {
  it('an agent reads only requests its binding created, in the agent view', async () => {
    const db = await setup()
    const own = await (await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, ownerAccountId: OWNER }, headers: svc() })).json()
    const res = await call(makeEnv(), db.rpc, 'GET', `/v1/agent-checkout/requests/${own.request.spendRequestId}`, { headers: agent() })
    expect(res.status).toBe(404)
    const ownerRead = await call(makeEnv(), db.rpc, 'GET', `/v1/agent-checkout/requests/${own.request.spendRequestId}?owner=${OTHER_OWNER}`, { headers: svc() })
    expect(ownerRead.status).toBe(404)
    const ok = await call(makeEnv(), db.rpc, 'GET', `/v1/agent-checkout/requests/${own.request.spendRequestId}?owner=${OWNER}`, { headers: svc() })
    expect(ok.status).toBe(200)
    expect((await ok.json()).request.ownerAccountId).toBe(OWNER)
  })

  it('toView hides amount-bearing reason codes and owner fields from agents', () => {
    const row = { spend_request_id: 'x', status: 'manual_review', status_reason: 'ops_resolved', owner_account_id: 'o', quote_id: 'q', snapshot_hash: 'h' } as any
    expect(toView(row, 'agent')).toEqual({ spendRequestId: 'x', status: 'manual_review' })
  })
})

describe('owner actions', () => {
  it('present-card hands the pay token to the service only', async () => {
    const db = await setup()
    const id = '33333333-3333-4333-8333-333333333333'
    const res = await call(makeEnv(), db.rpc, 'POST', `/v1/agent-checkout/requests/${id}/present-card`, { body: { ownerAccountId: OWNER, statusVersion: 1 }, headers: svc() })
    expect(await res.json()).toEqual({ fundingMode: 'per_payment', statusVersion: 1, payToken: 'a'.repeat(64) })
  })
})

describe('binding', () => {
  it('bind code carries its environment; claim mints a matching credential and never returns the owner', async () => {
    const db = await setup()
    const issued = await (await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/bind-requests', { body: { ownerAccountId: OWNER }, headers: svc() })).json()
    expect(issued.bindCode).toMatch(/^acbind_live_[A-Za-z0-9_-]{22}$/)
    const createArgs = db.calls.find((c) => c.fn === 'ac_bind_request_create')!.args
    expect(createArgs.bind_code_digest).toBe(await sha256Hex(issued.bindCode))
    expect(JSON.stringify(createArgs)).not.toContain(issued.bindCode)
    const claim = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/bind-requests/claim', { body: { bindCode: issued.bindCode, displayName: 'my laptop' } })
    expect(claim.status).toBe(201)
    const cb = await claim.json()
    expect(cb.credential).toMatch(/^ac_live_[A-Za-z0-9_-]{43}$/)
    expect(cb.ownerAccountId).toBeUndefined()
    expect(JSON.stringify(cb)).not.toContain(OWNER)
    const claimArgs = db.calls.find((c) => c.fn === 'ac_bind_request_claim')!.args
    expect(claimArgs.credential_digest).toBe(await sha256Hex(cb.credential))
    expect(JSON.stringify(claimArgs)).not.toContain(cb.credential)
    const again = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/bind-requests/claim', { body: { bindCode: issued.bindCode, displayName: 'x' } })
    expect((await again.json()).error.code).toBe('BIND_CODE_INVALID')
  })

  it('claim refuses a malformed code before any RPC and needs a configured IP limit', async () => {
    const db = await setup()
    const bad = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/bind-requests/claim', { body: { bindCode: 'hello', displayName: 'x' } })
    expect((await bad.json()).error.code).toBe('BIND_CODE_INVALID')
    const noLimit = await call(makeEnv({ AC_CLAIM_IP_LIMIT_PER_HOUR: '' }), db.rpc, 'POST', '/v1/agent-checkout/bind-requests/claim', { body: { bindCode: `acbind_live_${'a'.repeat(22)}`, displayName: 'x' } })
    expect(noLimit.status).toBe(503)
    expect(db.calls).toHaveLength(0)
  })

  it('GET binding reports the credential status only', async () => {
    const db = await setup()
    const res = await call(makeEnv(), db.rpc, 'GET', '/v1/agent-checkout/binding', { headers: agent() })
    expect(await res.json()).toEqual({ status: 'active', fingerprint: 'ac_x' })
  })
})

describe('normalizeAcInvoice', () => {
  it('accepts Coinbase spellings and refuses other hosts', () => {
    expect(normalizeAcInvoice({ invoice: SESSION })).toMatchObject({ ok: true, invoice: { provider: 'coinbase_payment_session', invoiceId: SESSION } })
    expect(normalizeAcInvoice({ invoice: 'https://payments.coinbase.com/payment-links/pl_abc123' })).toMatchObject({ ok: true, invoice: { provider: 'coinbase_payment_link', invoiceId: 'pl_abc123' } })
    expect(normalizeAcInvoice({ invoice: 'https://payments.coinbase.com.evil.com/payment-links/pl_abc' }).ok).toBe(false)
    expect(normalizeAcInvoice({ invoice: 'https://crypto.stripe.com/pay/abc' }).ok).toBe(false)
  })
})

describe('per-payment link from create-invoice (T6)', () => {
  const okBody = { ok: true, linkId: SESSION, original: '10.50', rozoPaymentId: 'rp-1' }
  const handler = (status = 200, body: unknown = okBody) => async () => new Response(JSON.stringify(body), { status })
  const req = (body: unknown) => new Request('https://mpp.test/v1/services/rozo-agent-api/create-invoice', { method: 'POST', body: JSON.stringify(body) })

  it('links only when a pay token is sent and the switch is on; the response is unchanged', async () => {
    const db = await setup()
    const res = await withAgentCheckoutLink(req({ url: SESSION_URL, acPayToken: 'b'.repeat(64) }), makeEnv(), undefined, handler(), db.rpc)
    expect(await res.json()).toEqual(okBody)
    expect(db.calls).toEqual([{ fn: 'ac_spend_link_order', args: {
      pay_token: 'b'.repeat(64), environment: 'prod', provider: 'coinbase_payment_session', invoice_id: SESSION, rozo_payment_id: 'rp-1', invoice_amount: '10.50',
    } }])
  })

  it('does nothing without a token, with the switch off, or on a failed create', async () => {
    const db = await setup()
    await withAgentCheckoutLink(req({ url: SESSION_URL }), makeEnv(), undefined, handler(), db.rpc)
    await withAgentCheckoutLink(req({ url: SESSION_URL, acPayToken: 'b'.repeat(64) }), makeEnv({ AC_REQUESTS_ENABLED: '' }), undefined, handler(), db.rpc)
    await withAgentCheckoutLink(req({ url: SESSION_URL, acPayToken: 'b'.repeat(64) }), makeEnv(), undefined, handler(409), db.rpc)
    expect(db.calls).toHaveLength(0)
  })

  it('a link failure never changes the create response', async () => {
    const boom: AcRpc = async () => { throw new Error('down') }
    const res = await withAgentCheckoutLink(req({ url: SESSION_URL, acPayToken: 'b'.repeat(64) }), makeEnv(), undefined, handler(), boom)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(okBody)
  })

  it('maps Bitrefill responses', () => {
    expect(linkArgsFromResponse({ invoiceId: 'EC9482DE-1111-4111-8111-34A72B96B321', rozoPaymentId: 'r', destination: { amount: '5.25' } }, 't', 'prod'))
      .toMatchObject({ provider: 'bitrefill_invoice', invoice_id: 'ec9482de-1111-4111-8111-34a72b96b321', invoice_amount: '5.25' })
    expect(linkArgsFromResponse({ linkId: 'other', original: '1', rozoPaymentId: 'r' }, 't', 'prod')).toBeNull()
  })
})

describe('review fixes', () => {
  it('malformed lineItems are refused before any request is stored', async () => {
    const db = await setup()
    for (const lineItems of [[null], [{ name: 'x' }], Array.from({ length: 51 }, () => ({ amount: '1' }))]) {
      const res = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { invoice: SESSION_URL, context: 'c', lineItems }, headers: agent() })
      expect(res.status).toBe(400)
    }
    expect(db.calls.filter((c) => c.fn === 'ac_spend_create')).toHaveLength(0)
  })

  it('a same-key retry of a Bitrefill request replays even when the invoice is about to expire', async () => {
    const db = await setup()
    const br = { invoiceId: 'ec9482de-1111-4111-8111-34a72b96b321', address: '0x1111111111111111111111111111111111111111', amount: '5.25', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }
    const first = await (await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { provider: 'bitrefill', bitrefill: br, context: 'g' }, headers: agent() })).json()
    vi.useFakeTimers({ now: Date.now() + 28 * 60_000, toFake: ['Date'] })
    try {
      const again = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', { body: { provider: 'bitrefill', bitrefill: br, context: 'g' }, headers: agent() })
      expect(again.status).toBe(200)
      expect((await again.json()).request.spendRequestId).toBe(first.request.spendRequestId)
      // A new request for an expiring invoice is canceled, not left open.
      const fresh = await (await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/requests', {
        body: { provider: 'bitrefill', bitrefill: { ...br, invoiceId: 'ec9482de-2222-4222-8222-34a72b96b321' }, context: 'g' },
        headers: agent('k-00000009'),
      })).json()
      expect(fresh.request.status).toBe('canceled')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a bind code whose prefix disagrees with the owner environment never yields a credential', async () => {
    const db = await setup()
    const issued = await (await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/bind-requests', { body: { ownerAccountId: OWNER, environment: 'test' }, headers: svc() })).json()
    expect(issued.bindCode).toMatch(/^acbind_test_/)
    const claim = await call(makeEnv(), db.rpc, 'POST', '/v1/agent-checkout/bind-requests/claim', { body: { bindCode: issued.bindCode, displayName: 'x' } })
    expect(claim.status).toBe(400)
    const body = await claim.json()
    expect(body.error.code).toBe('BIND_CODE_INVALID')
    expect(body.credential).toBeUndefined()
  })
})
