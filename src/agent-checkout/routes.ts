/**
 * Agent Checkout spend-request API (PR-5).
 *
 * Design (ainative): docs/design/20261111-agent-checkout-impl-04-spend-request-design.zh.md
 * sections 4 and 5; task pack docs/design/20261111-agent-checkout-impl-00-task-pack.zh.md PR-5.
 *
 * Every route answers 404 unless AC_REQUESTS_ENABLED is exactly 'true'. Behind
 * that, the Intents switch AC_REQUESTS_MODE (default off) refuses every RPC
 * with 'disabled' (503 AC_DISABLED here). Nothing on this surface moves money:
 * a per-payment request is paid by the user's own wallet through the existing
 * create-invoice flow, and balance approval (/v1/wallet/spend) is PR-10.
 *
 * Callers:
 *   chat-pay service  header X-Rozo-Service-Auth = AC_SERVICE_KEY, names the
 *                     owner (ownerAccountId) and answers for the owner's identity
 *   bound agent       Authorization: Bearer ac_live_<43> | ac_test_<43>; the owner
 *                     is resolved from the credential digest, never from the body
 *   unbound agent     only POST /bind-requests/claim with a bind code
 *
 * Routes:
 *   POST /v1/agent-checkout/owners                         service  ensure owner account
 *   POST /v1/agent-checkout/requests                       both     create (Idempotency-Key)
 *   GET  /v1/agent-checkout/requests?owner=…               service  list
 *   GET  /v1/agent-checkout/requests/{id}[?owner=…]        both     read
 *   POST /v1/agent-checkout/requests/{id}/present-card     service  one approval nonce / pay token
 *   POST /v1/agent-checkout/requests/{id}/refresh-quote    service  new quote, version +1
 *   POST /v1/agent-checkout/requests/{id}/switch-to-per-payment
 *   POST /v1/agent-checkout/requests/{id}/deny             service
 *   POST /v1/agent-checkout/requests/{id}/cancel           service
 *   POST /v1/agent-checkout/bind-requests                  service  issue a bind code
 *   POST /v1/agent-checkout/bind-requests/claim            public   bind code -> credential
 *   POST /v1/agent-checkout/bind-requests/{id}/decide      service  confirm | reject
 *   GET  /v1/agent-checkout/binding                        agent    own binding status
 *   POST /v1/agent-checkout/bindings/{id}/revoke           service
 *
 * Not found and not yours are the same 404; an unknown, revoked or pending
 * credential is the same 401. Error bodies never echo a credential, a bind
 * code, a pay token or a nonce.
 */

import type { Env } from '../index'
import { timingSafeEqualStr } from '../utils/timing-safe'
import { rateLimitOk } from '../routes/invoice-details'
import { clientIp } from '../routes/create-invoice-gate'
import { AcUnavailableError, acRpcClient, type AcResult, type AcRpc, type AcSpendRow } from './rpc'
import { buildSnapshot, canonicalJson, normalizeAcInvoice, sha256Hex, type AcSnapshot } from './invoice'

export const AC_PREFIX = '/v1/agent-checkout/'
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{8,128}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CREDENTIAL_RE = /^ac_(live|test)_[A-Za-z0-9_-]{43}$/
const BIND_CODE_RE = /^acbind_(live|test)_[A-Za-z0-9_-]{22}$/
const DIGEST_RE = /^[0-9a-f]{64}$/
const STATUSES = new Set([
  'created', 'pending_approval', 'approved', 'awaiting_payment', 'paying',
  'succeeded', 'denied', 'expired', 'canceled', 'failed', 'manual_review',
])

type Env_ = 'prod' | 'test'
type Principal =
  | { kind: 'service' }
  | { kind: 'agent'; environment: Env_; credentialDigest: string }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })
}

function err(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: { code, messageKey: `agent_checkout.${code.toLowerCase()}` }, ...extra })
}

export function acEnabled(env: Env): boolean {
  return env.AC_REQUESTS_ENABLED === 'true'
}

/** Outcome -> HTTP. Unlisted outcomes are a contract drift: 502, never success. */
const OUTCOME_HTTP: Record<string, [number, string]> = {
  disabled: [503, 'AC_DISABLED'],
  config_missing: [503, 'AC_NOT_CONFIGURED'],
  retry: [503, 'RETRY_LATER'],
  unauthorized_principal: [401, 'UNAUTHORIZED'],
  owner_not_allowed: [403, 'OWNER_NOT_ALLOWED'],
  account_not_active: [403, 'ACCOUNT_NOT_ACTIVE'],
  invoice_unsupported: [400, 'INVOICE_UNSUPPORTED'],
  invoice_not_payable: [400, 'INVOICE_NOT_PAYABLE'],
  invoice_in_progress: [409, 'INVOICE_IN_PROGRESS'],
  context_required: [400, 'CONTEXT_REQUIRED'],
  line_items_mismatch: [400, 'LINE_ITEMS_MISMATCH'],
  environment_mismatch: [400, 'ENVIRONMENT_MISMATCH'],
  conflict: [409, 'IDEMPOTENCY_CONFLICT'],
  not_found: [404, 'NOT_FOUND'],
  state_changed: [409, 'STATE_CHANGED'],
  expired: [409, 'APPROVAL_EXPIRED'],
  already_paying: [409, 'ALREADY_PAYING'],
  not_cancelable: [409, 'NOT_CANCELABLE'],
  bad_request: [400, 'INVALID_INPUT'],
  bind_code_invalid: [400, 'BIND_CODE_INVALID'],
  bind_request_open: [409, 'BIND_REQUEST_OPEN'],
  binding_limit: [409, 'BINDING_LIMIT'],
  mismatch: [409, 'MISMATCH'],
}

function outcomeError(r: AcResult, view: 'owner' | 'agent', extra: Record<string, unknown> = {}): Response {
  const [status, code] = OUTCOME_HTTP[r.outcome] ?? [502, 'AC_UNEXPECTED']
  const body: Record<string, unknown> = { ...extra }
  if (r.request && (r.outcome === 'state_changed' || r.outcome === 'already_paying' || r.outcome === 'not_cancelable' || r.outcome === 'expired')) {
    body.request = toView(r.request, view)
  }
  return err(status, code, body)
}

// Fields an agent may see (mirrors ac__spend_json's agent view; the owner
// view adds owner_account_id, quote_id, snapshot_hash, execution ids, ...).
const AGENT_FIELDS = [
  'spend_request_id', 'display_ref', 'environment', 'status', 'status_version', 'status_reason',
  'provider', 'invoice_id', 'entry', 'requested_by_type', 'merchant_display', 'merchant_verified',
  'beneficiary_verified', 'invoice_amount', 'invoice_currency', 'fee_atomic', 'total_debit_atomic',
  'quote_version', 'quote_expires_at', 'approval_expires_at', 'funding_mode', 'context', 'line_items',
  'exception_flag', 'merchant_delivery_status', 'merchant_payment_status', 'created_at', 'updated_at',
] as const
const OWNER_EXTRA = [
  'owner_account_id', 'beneficiary_ref', 'quote_id', 'invoice_expires_at', 'debit_asset', 'debit_chain',
  'snapshot_hash', 'card_issued_version', 'approved_at', 'approved_via', 'rozo_payment_id', 'execution_id',
] as const
// Reason codes that never carry an amount (design 6.5); anything else is hidden from agents.
const AGENT_REASONS = new Set([
  'insufficient_balance', 'owner_canceled', 'agent_revoked', 'ops_canceled', 'quote_expired',
  'invoice_not_payable', 'invoice_rejected', 'line_items_mismatch', 'create_timeout',
  'invoice_settled_elsewhere', 'paused', 'payment_unknown',
])

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

export function toView(row: AcSpendRow, view: 'owner' | 'agent'): Record<string, unknown> {
  const keys: readonly string[] = view === 'agent' ? AGENT_FIELDS : [...AGENT_FIELDS, ...OWNER_EXTRA]
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (row[k] === undefined || row[k] === null) continue
    if (view === 'agent' && k === 'status_reason' && !AGENT_REASONS.has(String(row[k]))) continue
    out[camel(k)] = row[k]
  }
  return out
}

async function authenticate(request: Request, env: Env): Promise<Principal | Response> {
  const service = request.headers.get('x-rozo-service-auth')
  if (service !== null) {
    return timingSafeEqualStr(service, env.AC_SERVICE_KEY) ? { kind: 'service' } : err(401, 'UNAUTHORIZED')
  }
  const auth = request.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(\S+)$/i.exec(auth)
  const cred = m ? m[1] : ''
  const cm = CREDENTIAL_RE.exec(cred)
  if (!cm) return err(401, 'UNAUTHORIZED')
  return { kind: 'agent', environment: cm[1] === 'test' ? 'test' : 'prod', credentialDigest: await sha256Hex(cred) }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json()
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function ownerId(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null
}

function statusVersion(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v)
  if (typeof v === 'string' && /^[0-9]{1,9}$/.test(v)) return v
  return null
}

function serviceEnvironment(v: unknown, env: Env): Env_ | null {
  const e = v === undefined || v === null ? env.AC_ENVIRONMENT ?? 'prod' : v
  return e === 'prod' || e === 'test' ? e : null
}

/** Fixed-window limit from config; unset or invalid = refuse (design 5.2). */
async function limited(env: Env, raw: string | undefined, bucket: string): Promise<Response | null> {
  const n = Number(raw)
  if (!raw || !Number.isSafeInteger(n) || n <= 0) return err(503, 'AC_NOT_CONFIGURED')
  const r = await rateLimitOk(env, `ac:${bucket}`, n, 3600)
  if (r.ok) return null
  return json(429, { error: { code: 'RATE_LIMITED', messageKey: 'agent_checkout.rate_limited' } }, { 'Retry-After': String(r.retryAfterS) })
}

function randomB64Url(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const LINE_AMOUNT_RE = /^[0-9]{1,18}(\.[0-9]{1,18})?$/

/** Same shape ac__snapshot_check accepts, checked before anything is stored. */
function lineItemsValid(v: unknown): boolean {
  if (v === null) return true
  if (!Array.isArray(v) || v.length > 50) return false
  return v.every((it) => it !== null && typeof it === 'object' && !Array.isArray(it)
    && typeof (it as Record<string, unknown>).amount === 'string'
    && LINE_AMOUNT_RE.test((it as Record<string, unknown>).amount as string))
}

/** Snapshot -> present/refresh RPC args. */
function snapshotArgs(s: AcSnapshot): Record<string, unknown> {
  return {
    merchant_display: s.merchant_display,
    merchant_verified: s.merchant_verified,
    beneficiary_ref: s.beneficiary_ref,
    beneficiary_verified: s.beneficiary_verified,
    invoice_amount: s.invoice_amount,
    invoice_currency: s.invoice_currency,
    fee_atomic: s.fee_atomic,
    total_debit_atomic: s.total_debit_atomic,
    quote_id: s.quote_id,
    quote_expires_at: s.quote_expires_at,
    invoice_expires_at: s.invoice_expires_at,
    funding_mode: s.funding_mode,
    line_items: s.line_items,
    snapshot_hash: s.snapshot_hash,
  }
}

// ── create ───────────────────────────────────────────────────────────────────

async function createRequest(request: Request, env: Env, rpc: AcRpc, p: Principal): Promise<Response> {
  const key = request.headers.get('idempotency-key') ?? ''
  if (!IDEMPOTENCY_RE.test(key)) return err(400, 'INVALID_INPUT', { field: 'Idempotency-Key' })
  const body = await readBody(request)
  if (!body) return err(400, 'INVALID_INPUT')

  const norm = normalizeAcInvoice(body, Date.now(), false)
  if (!norm.ok) return err(400, norm.code)
  const invoice = norm.invoice

  const pref = body.fundingPreference ?? 'auto'
  if (pref !== 'auto' && pref !== 'per_payment') return err(400, 'INVALID_INPUT', { field: 'fundingPreference' })
  const fundingMode: 'balance' | 'per_payment' =
    pref === 'auto' && invoice.provider !== 'bitrefill_invoice' ? 'balance' : 'per_payment'
  const context = typeof body.context === 'string' ? body.context.trim() : ''
  if (context.length > 2000) return err(400, 'INVALID_INPUT', { field: 'context' })
  const lineItems = body.lineItems === undefined ? null : body.lineItems
  if (!lineItemsValid(lineItems)) return err(400, 'INVALID_INPUT', { field: 'lineItems' })

  let environment: Env_
  let entry: string
  let principalArgs: Record<string, unknown>
  let bucket: string
  if (p.kind === 'agent') {
    if (!context) return err(400, 'CONTEXT_REQUIRED')
    const e = body.entry ?? 'cli'
    if (e !== 'cli' && e !== 'mcp') return err(400, 'INVALID_INPUT', { field: 'entry' })
    entry = e
    environment = p.environment
    principalArgs = { requested_by_type: 'agent', credential_digest: p.credentialDigest }
    bucket = `create:agent:${p.credentialDigest.slice(0, 32)}`
  } else {
    const owner = ownerId(body.ownerAccountId)
    if (!owner) return err(400, 'INVALID_INPUT', { field: 'ownerAccountId' })
    const e = body.entry ?? 'discord'
    if (e !== 'discord' && e !== 'web') return err(400, 'INVALID_INPUT', { field: 'entry' })
    const envName = serviceEnvironment(body.environment, env)
    if (!envName) return err(400, 'INVALID_INPUT', { field: 'environment' })
    entry = e
    environment = envName
    principalArgs = { requested_by_type: 'owner', owner_account_id: owner }
    bucket = `create:owner:${owner}`
  }
  const limit = await limited(env, env.AC_CREATE_LIMIT_PER_HOUR, bucket)
  if (limit) return limit

  // The raw link is not part of the hash: two spellings of one invoice are one request.
  const requestHash = await sha256Hex(canonicalJson({
    provider: invoice.provider,
    invoice_id: invoice.invoiceId,
    bitrefill: invoice.bitrefill ?? null,
    funding_preference: pref,
    context: context || null,
    line_items: lineItems,
    entry,
  }))
  const view = p.kind === 'agent' ? 'agent' : 'owner'

  const created = await rpc('ac_spend_create', {
    ...principalArgs,
    environment,
    idempotency_key: key,
    request_hash: requestHash,
    provider: invoice.provider,
    invoice_id: invoice.invoiceId,
    entry,
    context: context || null,
    line_items: lineItems,
  })
  if (created.outcome === 'invoice_in_progress') {
    // Same owner: the RPC names the open request. Another owner: nothing.
    const extra: Record<string, unknown> = {}
    if (typeof created.spend_request_id === 'string') extra.spendRequestId = created.spend_request_id
    if (typeof created.display_ref === 'string') extra.displayRef = created.display_ref
    return outcomeError(created, view, extra)
  }
  if ((created.outcome !== 'created' && created.outcome !== 'replay') || !created.request) {
    return outcomeError(created, view)
  }
  const replay = created.outcome === 'replay'
  let row = created.request
  // A request left in `created` (first quote failed, or a crash) is presented
  // on the same-key retry, so the retry is how a caller finishes it.
  if (row.status === 'created') {
    // Time-dependent checks run only when a snapshot is actually taken.
    const fresh = normalizeAcInvoice(body, Date.now(), true)
    const snap = fresh.ok
      ? await buildSnapshot(env, invoice, fundingMode, lineItems)
      : ({ ok: false, failure: { kind: 'reject', reason: 'invoice_not_payable', code: fresh.code } } as const)
    let presentArgs: Record<string, unknown>
    if (snap.ok) {
      presentArgs = { decision: 'present', invoice_environment: environment, ...snapshotArgs(snap.snapshot) }
    } else if (snap.failure.kind === 'reject') {
      presentArgs = { decision: 'reject', reason: snap.failure.reason }
    } else {
      return json(202, { replay, request: toView(row, view), quoteError: snap.failure.code })
    }
    const presented = await rpc('ac_spend_present', {
      spend_request_id: row.spend_request_id,
      status_version: row.status_version,
      ...presentArgs,
    })
    if (presented.request) row = presented.request
    if (presented.outcome !== 'pending_approval' && presented.outcome !== 'canceled'
        && presented.outcome !== 'line_items_mismatch' && presented.outcome !== 'invoice_not_payable'
        && presented.outcome !== 'environment_mismatch' && presented.outcome !== 'state_changed') {
      return outcomeError(presented, view)
    }
    if (presented.outcome === 'state_changed' && !presented.request) return outcomeError(presented, view)
  }
  return json(replay ? 200 : 201, { replay, request: toView(row, view) })
}

// ── read ─────────────────────────────────────────────────────────────────────

async function getRequest(url: URL, rpc: AcRpc, p: Principal, id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return err(404, 'NOT_FOUND')
  let args: Record<string, unknown>
  if (p.kind === 'agent') {
    args = { spend_request_id: id, credential_digest: p.credentialDigest }
  } else {
    const owner = ownerId(url.searchParams.get('owner'))
    if (!owner) return err(404, 'NOT_FOUND')
    args = { spend_request_id: id, owner_account_id: owner }
  }
  const r = await rpc('ac_spend_get', args)
  if (r.outcome !== 'ok' || !r.request) return r.outcome === 'disabled' ? outcomeError(r, 'agent') : err(404, 'NOT_FOUND')
  // The agent credential's environment must match the request's.
  if (p.kind === 'agent' && r.request.environment !== p.environment) return err(404, 'NOT_FOUND')
  return json(200, { request: toView(r.request, p.kind === 'agent' ? 'agent' : 'owner') })
}

async function listRequests(url: URL, rpc: AcRpc): Promise<Response> {
  const owner = ownerId(url.searchParams.get('owner'))
  if (!owner) return err(404, 'NOT_FOUND')
  const args: Record<string, unknown> = { owner_account_id: owner }
  const statusIn = url.searchParams.get('statusIn')
  if (statusIn) {
    const list = statusIn.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length === 0 || list.length > 11 || !list.every((s) => STATUSES.has(s))) return err(400, 'INVALID_INPUT', { field: 'statusIn' })
    args.status_in = list
  }
  const before = url.searchParams.get('cursor')
  if (before) {
    if (!Number.isFinite(Date.parse(before))) return err(400, 'INVALID_INPUT', { field: 'cursor' })
    args.before = before
  }
  const limit = url.searchParams.get('limit')
  if (limit) {
    if (!/^[0-9]{1,3}$/.test(limit)) return err(400, 'INVALID_INPUT', { field: 'limit' })
    args.limit = limit
  }
  const r = await rpc('ac_spend_list', args)
  if (r.outcome !== 'ok') return r.outcome === 'disabled' ? outcomeError(r, 'owner') : err(404, 'NOT_FOUND')
  const rows = (r.requests ?? []).map((row) => toView(row, 'owner'))
  const last = r.requests && r.requests.length > 0 ? r.requests[r.requests.length - 1].created_at : undefined
  return json(200, { requests: rows, ...(last ? { nextCursor: last } : {}) })
}

// ── owner actions (service only) ────────────────────────────────────────────

async function ownerAction(request: Request, env: Env, rpc: AcRpc, id: string, action: string): Promise<Response> {
  if (!UUID_RE.test(id)) return err(404, 'NOT_FOUND')
  const body = await readBody(request)
  if (!body) return err(400, 'INVALID_INPUT')
  const owner = ownerId(body.ownerAccountId)
  const version = statusVersion(body.statusVersion)
  if (!owner || version === null) return err(400, 'INVALID_INPUT')
  const base = { spend_request_id: id, owner_account_id: owner, status_version: version }

  if (action === 'present-card') {
    const r = await rpc('ac_spend_issue_card', base)
    if (r.outcome === 'already_issued') return json(200, { alreadyIssued: true })
    if (r.outcome !== 'issued') return outcomeError(r, 'owner')
    return json(200, {
      fundingMode: r.funding_mode,
      statusVersion: r.status_version,
      ...(r.funding_mode === 'balance' ? { approvalNonce: r.approval_nonce } : { payToken: r.pay_token }),
    })
  }
  if (action === 'deny') {
    const r = await rpc('ac_spend_deny', base)
    return r.outcome === 'denied' && r.request ? json(200, { request: toView(r.request, 'owner') }) : outcomeError(r, 'owner')
  }
  if (action === 'cancel') {
    const r = await rpc('ac_spend_cancel', { ...base, reason: 'owner_canceled' })
    return r.outcome === 'canceled' && r.request
      ? json(200, { released: r.released === true, request: toView(r.request, 'owner') })
      : outcomeError(r, 'owner')
  }
  // refresh-quote / switch-to-per-payment: re-read the invoice, new snapshot.
  const current = await rpc('ac_spend_get', { spend_request_id: id, owner_account_id: owner })
  if (current.outcome !== 'ok' || !current.request) return current.outcome === 'disabled' ? outcomeError(current, 'owner') : err(404, 'NOT_FOUND')
  const row = current.request
  if (row.status !== 'pending_approval' || String(row.status_version) !== version) {
    return outcomeError({ outcome: 'state_changed', request: row }, 'owner')
  }
  const norm = normalizeAcInvoice(
    row.provider === 'bitrefill_invoice'
      ? { provider: 'bitrefill', bitrefill: {
          invoiceId: row.invoice_id,
          address: row.beneficiary_ref,
          amount: row.invoice_amount,
          expiresAt: row.invoice_expires_at,
        } }
      : { invoice: row.invoice_id },
  )
  if (!norm.ok) return err(409, 'INVOICE_NOT_PAYABLE')
  const mode: 'balance' | 'per_payment' =
    action === 'switch-to-per-payment' || row.provider === 'bitrefill_invoice' ? 'per_payment'
      : (row.funding_mode as 'balance' | 'per_payment') ?? 'per_payment'
  const snap = await buildSnapshot(env, norm.invoice, mode, row.line_items ?? null)
  if (!snap.ok) {
    return snap.failure.kind === 'transient' ? err(503, snap.failure.code) : err(409, 'INVOICE_NOT_PAYABLE')
  }
  const r = await rpc('ac_spend_refresh', { ...base, invoice_environment: row.environment, ...snapshotArgs(snap.snapshot) })
  return r.outcome === 'pending_approval' && r.request ? json(200, { request: toView(r.request, 'owner') }) : outcomeError(r, 'owner')
}

// ── owners and bindings ─────────────────────────────────────────────────────

async function ensureOwner(request: Request, env: Env, rpc: AcRpc): Promise<Response> {
  const body = await readBody(request)
  if (!body) return err(400, 'INVALID_INPUT')
  const digest = typeof body.ownerRefDigest === 'string' ? body.ownerRefDigest : ''
  const environment = serviceEnvironment(body.environment, env)
  if (!DIGEST_RE.test(digest) || !environment) return err(400, 'INVALID_INPUT')
  const r = await rpc('ac_owner_ensure', { owner_type: 'discord_user', owner_ref_digest: digest, environment })
  if (r.outcome !== 'created' && r.outcome !== 'exists') return outcomeError(r, 'owner')
  return json(r.outcome === 'created' ? 201 : 200, {
    ownerAccountId: r.owner_account_id,
    status: r.status,
    allowlisted: r.allowlisted,
  })
}

async function createBindRequest(request: Request, env: Env, rpc: AcRpc): Promise<Response> {
  const body = await readBody(request)
  const owner = ownerId(body?.ownerAccountId)
  if (!owner) return err(400, 'INVALID_INPUT')
  const environment = serviceEnvironment(body?.environment, env)
  if (!environment) return err(400, 'INVALID_INPUT', { field: 'environment' })
  // The code carries its environment so claim can mint a matching credential.
  // The owner's stored environment wins; claim re-checks it (see below).
  const code = `acbind_${environment === 'test' ? 'test' : 'live'}_${randomB64Url(16)}`
  const r = await rpc('ac_bind_request_create', { owner_account_id: owner, bind_code_digest: await sha256Hex(code) })
  if (r.outcome !== 'issued') return outcomeError(r, 'owner')
  return json(201, { bindRequestId: r.bind_request_id, bindCode: code, codeExpiresAt: r.code_expires_at })
}

async function claimBindRequest(request: Request, env: Env, rpc: AcRpc): Promise<Response> {
  const limit = await limited(env, env.AC_CLAIM_IP_LIMIT_PER_HOUR, `claim:ip:${clientIp(request)}`)
  if (limit) return limit
  const body = await readBody(request)
  const code = typeof body?.bindCode === 'string' ? body.bindCode.trim() : ''
  const name = typeof body?.displayName === 'string' ? body.displayName.trim() : ''
  const cm = BIND_CODE_RE.exec(code)
  if (!cm) return err(400, 'BIND_CODE_INVALID')
  if (name.length < 1 || name.length > 64) return err(400, 'INVALID_INPUT', { field: 'displayName' })
  const credential = `ac_${cm[1]}_${randomB64Url(32)}`
  const credentialDigest = await sha256Hex(credential)
  const fingerprint = `ac_${credentialDigest.slice(0, 12)}`
  const r = await rpc('ac_bind_request_claim', {
    bind_code_digest: await sha256Hex(code),
    credential_digest: credentialDigest,
    credential_fingerprint: fingerprint,
    agent_display_name: name,
  })
  if (r.outcome !== 'claimed') return outcomeError(r, 'agent')
  // The bind request lives in its owner's environment. If the code's prefix
  // named the other one, this credential could never resolve: do not hand it
  // out (the claimed request simply expires unconfirmed).
  const check = await rpc('ac_principal_resolve', {
    credential_digest: credentialDigest,
    environment: cm[1] === 'test' ? 'test' : 'prod',
  })
  if (check.outcome !== 'pending_confirm') return err(400, 'BIND_CODE_INVALID')
  // owner_account_id is deliberately not returned to the agent.
  return json(201, {
    bindRequestId: r.bind_request_id,
    credential,
    fingerprint,
    status: 'claimed',
    confirmExpiresAt: r.confirm_expires_at,
  })
}

async function decideBindRequest(request: Request, rpc: AcRpc, id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return err(404, 'NOT_FOUND')
  const body = await readBody(request)
  const owner = ownerId(body?.ownerAccountId)
  const decision = body?.decision
  if (!owner || (decision !== 'confirm' && decision !== 'reject')) return err(400, 'INVALID_INPUT')
  const r = await rpc('ac_bind_request_decide', { bind_request_id: id, owner_account_id: owner, decision })
  if (r.outcome === 'confirmed') return json(200, { status: 'confirmed', bindingId: r.binding_id })
  if (r.outcome === 'rejected') return json(200, { status: 'rejected' })
  return outcomeError(r, 'owner')
}

async function bindingStatus(rpc: AcRpc, p: Principal & { kind: 'agent' }): Promise<Response> {
  const r = await rpc('ac_principal_resolve', { credential_digest: p.credentialDigest, environment: p.environment })
  if (r.outcome === 'disabled') return outcomeError(r, 'agent')
  if (r.outcome === 'active') return json(200, { status: 'active', fingerprint: r.fingerprint })
  if (r.outcome === 'pending_confirm') return json(200, { status: 'pending_confirm', fingerprint: r.fingerprint })
  if (r.outcome === 'revoked') return json(200, { status: 'revoked', fingerprint: r.fingerprint })
  if (r.outcome === 'rejected') return json(200, { status: 'rejected' })
  return err(401, 'UNAUTHORIZED')
}

async function revokeBinding(request: Request, rpc: AcRpc, id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return err(404, 'NOT_FOUND')
  const body = await readBody(request)
  const owner = ownerId(body?.ownerAccountId)
  if (!owner) return err(400, 'INVALID_INPUT')
  const r = await rpc('ac_binding_revoke', { binding_id: id, owner_account_id: owner, revoked_by: 'owner' })
  if (r.outcome === 'revoked' || r.outcome === 'already_revoked') {
    return json(200, {
      status: 'revoked',
      alreadyRevoked: r.outcome === 'already_revoked',
      canceledRequests: r.canceled_requests ?? [],
      releasedReservations: r.released_reservations ?? [],
    })
  }
  return outcomeError(r, 'owner')
}

// ── dispatch ────────────────────────────────────────────────────────────────

/** Returns null when the path is not an Agent Checkout route. */
export async function handleAgentCheckout(request: Request, env: Env, rpcOverride?: AcRpc): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(AC_PREFIX)) return null
  if (!acEnabled(env)) return err(404, 'NOT_FOUND')
  const rpc = rpcOverride ?? acRpcClient(env)
  if (!rpc) return err(503, 'AC_NOT_CONFIGURED')

  const parts = url.pathname.slice(AC_PREFIX.length).split('/').filter(Boolean)
  const method = request.method
  try {
    // The only unauthenticated route: a bind code is the credential.
    if (method === 'POST' && parts.length === 2 && parts[0] === 'bind-requests' && parts[1] === 'claim') {
      return await claimBindRequest(request, env, rpc)
    }
    const p = await authenticate(request, env)
    if (p instanceof Response) return p
    const service = p.kind === 'service'

    if (parts[0] === 'requests') {
      if (parts.length === 1 && method === 'POST') return await createRequest(request, env, rpc, p)
      if (parts.length === 1 && method === 'GET') return service ? await listRequests(url, rpc) : err(404, 'NOT_FOUND')
      if (parts.length === 2 && method === 'GET') return await getRequest(url, rpc, p, parts[1])
      if (parts.length === 3 && method === 'POST'
          && ['present-card', 'refresh-quote', 'switch-to-per-payment', 'deny', 'cancel'].includes(parts[2])) {
        return service ? await ownerAction(request, env, rpc, parts[1], parts[2]) : err(404, 'NOT_FOUND')
      }
    }
    if (parts[0] === 'owners' && parts.length === 1 && method === 'POST') {
      return service ? await ensureOwner(request, env, rpc) : err(404, 'NOT_FOUND')
    }
    if (parts[0] === 'bind-requests') {
      if (parts.length === 1 && method === 'POST') return service ? await createBindRequest(request, env, rpc) : err(404, 'NOT_FOUND')
      if (parts.length === 3 && parts[2] === 'decide' && method === 'POST') {
        return service ? await decideBindRequest(request, rpc, parts[1]) : err(404, 'NOT_FOUND')
      }
    }
    if (parts[0] === 'binding' && parts.length === 1 && method === 'GET') {
      return p.kind === 'agent' ? await bindingStatus(rpc, p) : err(404, 'NOT_FOUND')
    }
    if (parts[0] === 'bindings' && parts.length === 3 && parts[2] === 'revoke' && method === 'POST') {
      return service ? await revokeBinding(request, rpc, parts[1]) : err(404, 'NOT_FOUND')
    }
    return err(404, 'NOT_FOUND')
  } catch (e) {
    if (e instanceof AcUnavailableError) {
      console.warn(`[agent-checkout] ${e.message}`)
      return err(503, 'AC_UNAVAILABLE')
    }
    throw e
  }
}
