/**
 * x402 payer routes (design: ainative todos/20261010-x402-payer-skill-design.zh.md 5.1 to 5.4).
 *
 *   POST /v1/x402/keys     create an agent key (ak_...), shown once
 *   GET  /v1/x402/balance  balance, limits, today's spend
 *   POST /v1/x402/topup    open a payment-api top-up order (stablecoins, any
 *                          supported chain); the balance is credited in the
 *                          Intents DB when the order is paid
 *   POST /v1/x402/sign     sign one x402 `exact` requirement from the balance
 *
 * The switch is app_config.X402_PAYER in the Intents DB (off | shadow | on,
 * default off). Every ledger RPC reads it, so a flip applies on the next call:
 *   off     every route answers 503 X402_PAYER_DISABLED
 *   shadow  /sign validates, checks limits and records a would_sign row, then
 *           answers 503 X402_PAYER_SHADOW without a signature; /topup is
 *           refused (no real money in while signing is off)
 *   on      /sign returns the PAYMENT-SIGNATURE value
 *
 * Idempotency (5.2): the caller sends idempotencyKey. It is bound to the
 * sha256 of the immutable requirement fields. The credential, the debit and
 * the nonce row are written in ONE ledger transaction (x402_payment_commit).
 * Same key + same hash returns the stored credential; same key + different
 * hash is 409. We sign before committing: a signature whose commit loses (race
 * or refusal) is discarded and never leaves this Worker.
 *
 * Rozo never sees the agent's request body or API keys: /sign takes only the
 * 402 `accepts` data.
 */

import type { TransactionSigner } from '@solana/kit'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import { resolveSource } from '../routes/create-invoice'
import { FUNDER_WALLET } from '../routes/webhook'
import { clientIp } from '../routes/create-invoice-gate'
import { randomEvmNonce, remoteSignEvmExact, remoteSignerFromEnv, type RemoteSignerConfig } from './evm'
import { LedgerUnavailableError, supabaseLedger, type LedgerEnv, type LedgerPayment, type LedgerResult, type X402Ledger } from './ledger'
import {
  BASE_MAINNET_CAIP2,
  IDEMPOTENCY_KEY_RE,
  atomicToUsd,
  requirementHash,
  selectRequirement,
  sha256Hex,
  type ValidatedRequirement,
} from './requirements'
import { SvmSignError, randomSvmNonce, signSolanaExact, svmSignerFromSecret, x402SvmPayloadBuilder, type SolanaPayloadBuilder } from './svm'

export const X402_TOPUP_APP_ID = 'merchant_x402_topup'
export const X402_TOPUP_MERCHANT_HANDLE = 'x402_topup'
export const TOPUP_MIN_USD = 5
export const TOPUP_MAX_USD = 500
export const KEY_CREATE_LIMIT_PER_HOUR = 10

const ROZO_INTENTS_URL = 'https://intentapiv4.rozo.ai/functions/v1/payment-api/'
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const AGENT_KEY_RE = /^ak_[A-Za-z0-9_-]{43}$/

export interface X402PayerEnv extends LedgerEnv {
  MPP_STORE: KVNamespace
  /** Remote Base signer (pay-invoice side). Default https://agentapi.rozo.ai/sign-x402. */
  X402_SIGN_SERVICE_URL?: string
  /** Bearer secret shared with the signing service. Unset = Base signing off. */
  X402_SIGN_SHARED_SECRET?: string
  /** Solana funder keypair (base58 64 bytes or JSON array). */
  X402_SOLANA_FUNDER_SECRET_KEY?: string
  /** Public address the Solana secret must derive to. */
  X402_SOLANA_FUNDER_ADDRESS?: string
  /** Optional Solana RPC for mint + blockhash (default: public mainnet). */
  X402_SOLANA_RPC_URL?: string
  /** Intents API key bound to app merchant_x402_topup. */
  ROZO_X402_TOPUP_API_KEY?: string
  /** Base USDC receiver for top-ups (default: the shared funder). */
  X402_TOPUP_RECEIVER?: string
}

export interface X402PayerDeps {
  ledger: X402Ledger | null
  /** Remote Base signer, or null when not configured. */
  evmRemote: RemoteSignerConfig | null
  svmSigner: () => Promise<TransactionSigner | null>
  svmBuild: SolanaPayloadBuilder
  fetchImpl: typeof fetch
  nowSeconds: () => number
  /** Attempt cache for remote signing retries (MPP_STORE). */
  kv?: KVNamespace
}

export function depsFromEnv(env: X402PayerEnv): X402PayerDeps {
  return {
    ledger: supabaseLedger(env),
    evmRemote: remoteSignerFromEnv(env, FUNDER_WALLET, (...args) => fetch(...args)),
    svmSigner: () => svmSignerFromSecret(env.X402_SOLANA_FUNDER_SECRET_KEY, env.X402_SOLANA_FUNDER_ADDRESS),
    svmBuild: x402SvmPayloadBuilder(env.X402_SOLANA_RPC_URL),
    fetchImpl: (...args) => fetch(...args),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    kv: env.MPP_STORE,
  }
}

export const X402_PATHS: ReadonlySet<string> = new Set([
  '/v1/x402/keys',
  '/v1/x402/balance',
  '/v1/x402/topup',
  '/v1/x402/sign',
])

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })
}

function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { ok: false, code, error: { code, message }, ...extra })
}

/** Map a ledger outcome that is not a success to an HTTP answer. */
function outcomeResponse(r: LedgerResult): Response {
  switch (r.outcome) {
    case 'disabled':
      return fail(503, 'X402_PAYER_DISABLED', 'The x402 payer is switched off.')
    case 'unknown_key':
      return fail(401, 'X402_KEY_INVALID', 'Unknown agent key.')
    case 'account_inactive':
      return fail(403, 'X402_KEY_SUSPENDED', `This agent key is ${r.status ?? 'inactive'}.`)
    case 'conflict':
      return fail(409, 'X402_IDEMPOTENCY_CONFLICT',
        'This idempotencyKey was already used for a different payment requirement. Use a new key for a new challenge.')
    case 'mode_changed':
      return fail(503, 'X402_PAYER_MODE_CHANGED', 'The payer switch changed during this request. Retry.')
    case 'per_tx_limit':
      return fail(402, 'X402_PER_TX_LIMIT_EXCEEDED', `Amount is above this key's single-payment limit of $${r.limit_usd}.`,
        { limitUsd: r.limit_usd })
    case 'insufficient_balance':
      return fail(402, 'X402_INSUFFICIENT_BALANCE', 'Balance is too low for this payment. Top up with POST /v1/x402/topup.',
        { balanceUsd: r.balance_usd })
    case 'daily_limit':
      return fail(429, 'X402_DAILY_LIMIT_EXCEEDED', `This key's daily limit of $${r.limit_usd} would be exceeded.`,
        { limitUsd: r.limit_usd, spentTodayUsd: r.spent_today_usd })
    case 'global_cap':
      return fail(429, 'X402_GLOBAL_DAILY_CAP_REACHED', 'The payer has reached its daily volume cap. Try again after 00:00 UTC.')
    case 'pay_to_not_allowed':
      return fail(403, 'X402_PAYTO_NOT_ALLOWED', "payTo is not on this key's allowlist.")
    case 'nonce_collision':
      return fail(503, 'X402_RETRY', 'Transient signing conflict. Retry with the same idempotencyKey.')
    case 'bad_request':
      return fail(400, 'X402_INVALID_REQUEST', `Rejected by the ledger: ${r.reason ?? 'invalid request'}.`)
    default:
      return fail(503, 'X402_LEDGER_UNAVAILABLE', 'Unexpected ledger answer.')
  }
}

function readAgentKey(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim())
  const token = m?.[1] ?? request.headers.get('x-agent-key')?.trim() ?? ''
  return AGENT_KEY_RE.test(token) ? token : null
}

function newAgentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `ak_${b64}`
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function publicAccount(r: LedgerResult) {
  const a = r.account!
  return {
    mode: r.mode,
    status: a.status,
    balanceUsd: a.balance_usd,
    perTxLimitUsd: a.per_tx_limit_usd,
    dailyLimitUsd: a.daily_limit_usd,
    spentTodayUsd: a.spent_today_usd,
    payToAllowlist: a.pay_to_allowlist,
    flags: a.flags ?? [],
  }
}

/** Router entry. Returns null for paths this module does not own. */
export async function handleX402Payer(request: Request, env: X402PayerEnv, deps: X402PayerDeps = depsFromEnv(env)): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!X402_PATHS.has(path)) return null
  if (!deps.ledger) {
    return fail(503, 'X402_PAYER_NOT_CONFIGURED', 'The x402 payer ledger is not configured on this deployment.')
  }
  try {
    if (path === '/v1/x402/keys') {
      if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Use POST.')
      return await createKey(request, env, deps)
    }
    if (path === '/v1/x402/balance') {
      if (request.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'Use GET.')
      return await balance(request, deps)
    }
    if (path === '/v1/x402/topup') {
      if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Use POST.')
      return await topup(request, env, deps)
    }
    if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Use POST.')
    return await sign(request, deps)
  } catch (err) {
    if (err instanceof LedgerUnavailableError) {
      console.warn(`[x402-payer] ${err.message}`)
      return fail(503, 'X402_LEDGER_UNAVAILABLE', 'The payer ledger is unavailable. Retry shortly.')
    }
    console.error(`[x402-payer] ${path} failed: ${(err as Error).message}`)
    return fail(500, 'X402_INTERNAL', 'Internal error.')
  }
}

async function createKey(request: Request, env: X402PayerEnv, deps: X402PayerDeps): Promise<Response> {
  // Cheap abuse backstop: keys are free to create, so cap per IP per hour.
  const hour = Math.floor(deps.nowSeconds() / 3600)
  const rlKey = `x402payer:keys:${clientIp(request)}:${hour}`
  const used = Number((await env.MPP_STORE.get(rlKey)) ?? '0')
  if (used >= KEY_CREATE_LIMIT_PER_HOUR) {
    return fail(429, 'X402_KEY_RATE_LIMITED', 'Too many keys created from this address. Try again later.')
  }
  const body = (await readJson(request)) ?? {}
  const label = typeof body.label === 'string' ? body.label.slice(0, 80) : null

  const token = newAgentKey()
  const r = await deps.ledger!.createAccount(await sha256Hex(token), label)
  if (r.outcome !== 'created') {
    return r.outcome === 'exists' ? fail(503, 'X402_RETRY', 'Key collision. Retry.') : outcomeResponse(r)
  }
  await env.MPP_STORE.put(rlKey, String(used + 1), { expirationTtl: 3600 })
  return json(201, {
    ok: true,
    apiKey: token,
    warning: 'Store this key now. Rozo keeps only its hash and cannot show it again.',
    account: publicAccount(r),
  })
}

async function balance(request: Request, deps: X402PayerDeps): Promise<Response> {
  const token = readAgentKey(request)
  if (!token) return fail(401, 'X402_KEY_INVALID', 'Send the agent key as "Authorization: Bearer ak_...".')
  const r = await deps.ledger!.getAccount(await sha256Hex(token))
  if (r.outcome !== 'ok') return outcomeResponse(r)
  return json(200, { ok: true, ...publicAccount(r) })
}

async function topup(request: Request, env: X402PayerEnv, deps: X402PayerDeps): Promise<Response> {
  const token = readAgentKey(request)
  if (!token) return fail(401, 'X402_KEY_INVALID', 'Send the agent key as "Authorization: Bearer ak_...".')
  const digest = await sha256Hex(token)
  const acct = await deps.ledger!.getAccount(digest)
  if (acct.outcome !== 'ok') return outcomeResponse(acct)
  if (acct.mode !== 'on') {
    return fail(503, 'X402_PAYER_SHADOW', 'Top-ups open when the payer is switched on.')
  }
  if (acct.account!.status !== 'active') return outcomeResponse({ ...acct, outcome: 'account_inactive', status: acct.account!.status })

  const apiKey = env.ROZO_X402_TOPUP_API_KEY
  if (!apiKey) return fail(503, 'X402_TOPUP_NOT_CONFIGURED', 'Top-ups are not configured on this deployment.')
  // A balance nobody can spend is a trap: refuse to take money in unless the
  // remote Base signing service is configured (URL + shared secret). Checked
  // before any order exists, so a refusal has no side effect.
  if (!deps.evmRemote) {
    return fail(503, 'X402_SIGNER_NOT_CONFIGURED', 'The signing service is not configured on this deployment, so top-ups are closed.')
  }

  const body = await readJson(request)
  if (!body) return fail(400, 'X402_INVALID_REQUEST', 'Body must be a JSON object.')
  const amountRaw = typeof body.amount === 'number' ? String(body.amount) : body.amount
  if (typeof amountRaw !== 'string' || !/^[0-9]{1,6}(\.[0-9]{1,2})?$/.test(amountRaw)) {
    return fail(400, 'X402_INVALID_REQUEST', 'amount must be a USD amount with at most 2 decimals, e.g. "20".')
  }
  const amount = Number(amountRaw)
  if (amount < TOPUP_MIN_USD || amount > TOPUP_MAX_USD) {
    return fail(400, 'X402_TOPUP_AMOUNT_OUT_OF_RANGE', `Top-up must be between $${TOPUP_MIN_USD} and $${TOPUP_MAX_USD}.`)
  }

  // Which coin the agent pays with. Never defaulted: a caller that meant
  // Solana USDT and got a Base USDC address would send to the wrong chain.
  const pick = parseTopupSource(body)
  if ('error' in pick) return fail(400, pick.error.code, pick.error.message, pick.error.extra ?? {})
  // Stablecoin sources only in v1 (same table as checkout). Native coins and
  // Lightning settle exactOut through separate gates; added later.
  const src = resolveSource({ chainId: pick.chainId, tokenSymbol: pick.token }, new Set())
  if (src.error) {
    return fail(400, 'X402_TOPUP_SOURCE_UNSUPPORTED', src.error.message, src.error.supported ? { supported: src.error.supported } : {})
  }

  const receiver = (env.X402_TOPUP_RECEIVER || FUNDER_WALLET).trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(receiver)) {
    return fail(503, 'X402_TOPUP_NOT_CONFIGURED', 'Top-up receiver is misconfigured.')
  }
  const accountId = acct.account!.id
  const orderId = `x402topup-${accountId.slice(0, 8)}-${deps.nowSeconds()}-${crypto.randomUUID().slice(0, 8)}`
  const intentsBody = {
    appId: X402_TOPUP_APP_ID,
    orderId,
    type: 'exactIn',
    display: { title: `x402 balance top-up $${amountRaw}`, currency: 'USD' },
    source: {
      chainId: src.resolved.chainId,
      tokenSymbol: src.resolved.tokenSymbol,
      amount: amountRaw,
      tokenAddress: src.resolved.tokenAddress,
    },
    destination: {
      chainId: '8453',
      receiverAddress: receiver,
      tokenSymbol: 'USDC',
      tokenAddress: BASE_USDC_ADDRESS,
    },
    metadata: {
      source: 'mpprouter-x402-topup',
      merchant_handle: X402_TOPUP_MERCHANT_HANDLE,
      x402_account_id: accountId,
    },
  }

  let res: Response
  try {
    res = await deps.fetchImpl(ROZO_INTENTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(intentsBody),
    })
  } catch (err) {
    return fail(502, 'INTENTS_API_FAILED', `Rozo intents API unreachable: ${(err as Error).message}`)
  }
  const text = await res.text()
  if (!res.ok) {
    return fail(502, 'INTENTS_API_FAILED', `Rozo intents API returned ${res.status}.`)
  }
  let order: any
  try {
    order = JSON.parse(text)
  } catch {
    return fail(502, 'INTENTS_API_FAILED', 'Rozo intents API returned non-JSON.')
  }
  const paymentId = typeof order?.id === 'string' ? order.id : null
  const destReceiver = String(order?.destination?.receiverAddress ?? '')
  if (!paymentId) return fail(502, 'INTENTS_API_FAILED', 'Rozo intents API returned no payment id.')
  // payment-api can force a merchant's own destination. If that is not the
  // receiver we bind, the credit would land in review: refuse up front and
  // never hand out the deposit address.
  if (destReceiver.toLowerCase() !== receiver.toLowerCase()) {
    console.error('[x402-payer] top-up order destination differs from the configured receiver')
    return fail(503, 'X402_TOPUP_MISCONFIGURED', 'Top-up destination mismatch. Nothing was charged; try again later.')
  }

  // The order must take the coin the caller asked for; otherwise refuse
  // rather than show an address on another chain.
  const orderChain = order?.source?.chainId !== undefined ? String(order.source.chainId) : src.resolved.chainId
  const orderToken = order?.source?.tokenSymbol !== undefined ? String(order.source.tokenSymbol).toUpperCase() : src.resolved.tokenSymbol
  if (orderChain !== src.resolved.chainId || orderToken !== src.resolved.tokenSymbol) {
    console.error('[x402-payer] top-up order source differs from the requested chain/token')
    return fail(503, 'X402_TOPUP_MISCONFIGURED', 'Top-up source mismatch. Nothing was charged; try again later.')
  }
  const depositAddress = typeof order?.source?.receiverAddress === 'string' ? order.source.receiverAddress : null
  if (!depositAddress) return fail(502, 'INTENTS_API_FAILED', 'Rozo intents API returned no deposit address.')

  const reg = await deps.ledger!.registerTopup({
    key_digest: digest,
    payment_id: paymentId,
    requested_usd: amountRaw,
    expected_receiver: receiver,
  })
  if (reg.outcome !== 'registered') {
    // Unbound order: it can never credit anyone, so do not show the deposit.
    return reg.outcome === 'disabled' || reg.outcome === 'unknown_key' || reg.outcome === 'account_inactive'
      ? outcomeResponse(reg)
      : fail(503, 'X402_TOPUP_NOT_REGISTERED', 'Could not register the top-up. Nothing was charged; try again.')
  }

  const expiresAt = order?.expiresAt ?? null
  return json(200, {
    ok: true,
    paymentId,
    // Echo of what was asked, so the client can check it got the right coin.
    chain: pick.chain,
    token: src.resolved.tokenSymbol,
    amount: amountRaw,
    deposit: {
      address: depositAddress,
      memo: order?.source?.receiverMemo ?? null,
      chain: pick.chain,
      chainId: src.resolved.chainId,
      token: src.resolved.tokenSymbol,
      amount: order?.source?.amount ?? amountRaw,
      expiresAt,
    },
    paymentLink: order?.paymentLink ?? order?.url ?? null,
    expiresAt,
    creditUsd: order?.destination?.amount ?? null,
    note: 'Send exactly deposit.amount to deposit.address (with memo if present). The balance is credited with creditUsd when the deposit is confirmed.',
    ...(src.resolved.warnings.length ? { warnings: src.resolved.warnings } : {}),
  })
}

/**
 * Top-up chain names. CAIP-2 ids (canonical, echoed back) plus the plain
 * names the design and CLI use. Mapped to the payment-api chainId.
 */
export const TOPUP_CHAINS: Record<string, { chainId: string; caip2: string }> = (() => {
  const defs: Array<[string, string, string[]]> = [
    ['1', 'eip155:1', ['ethereum']],
    ['56', 'eip155:56', ['bsc', 'bnb']],
    ['137', 'eip155:137', ['polygon']],
    ['8453', 'eip155:8453', ['base']],
    ['42161', 'eip155:42161', ['arbitrum']],
    ['900', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', ['solana']],
    ['1500', 'stellar:pubnet', ['stellar']],
  ]
  const out: Record<string, { chainId: string; caip2: string }> = {}
  for (const [chainId, caip2, names] of defs) {
    for (const n of [caip2, ...names]) out[n.toLowerCase()] = { chainId, caip2 }
  }
  return out
})()

const NATIVE_OR_BTC = new Set(['ETH', 'BNB', 'SOL', 'POL', 'MATIC', 'XLM', 'BTC'])

/** Read {chain, token} (or the alias source:{chainId, tokenSymbol}); both required. */
export function parseTopupSource(body: Record<string, unknown>):
  | { chain: string; chainId: string; token: string }
  | { error: { code: string; message: string; extra?: Record<string, unknown> } } {
  const source = body.source && typeof body.source === 'object' && !Array.isArray(body.source)
    ? (body.source as Record<string, unknown>)
    : null
  const chainRaw = body.chain ?? source?.chainId
  const tokenRaw = body.token ?? source?.tokenSymbol
  if (chainRaw === undefined || chainRaw === null || chainRaw === '' || typeof tokenRaw !== 'string' || !tokenRaw) {
    return {
      error: {
        code: 'X402_TOPUP_SOURCE_REQUIRED',
        message: 'Say which coin you pay with: {"chain": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" or "solana", "token": "USDT"}.',
        extra: { chains: [...new Set(Object.values(TOPUP_CHAINS).map((c) => c.caip2))] },
      },
    }
  }
  const token = tokenRaw.trim().toUpperCase()
  const chainStr = String(chainRaw).trim()
  if (chainStr.toLowerCase() === 'lightning' || NATIVE_OR_BTC.has(token)) {
    return {
      error: {
        code: 'X402_TOPUP_SOURCE_UNSUPPORTED',
        message: 'Native coin and Lightning top-ups are not available yet. Top up with USDC or USDT.',
      },
    }
  }
  // Legacy numeric chainId (alias form) or a known name / CAIP-2 id.
  const byNumeric = Object.values(TOPUP_CHAINS).find((c) => c.chainId === chainStr)
  const hit = TOPUP_CHAINS[chainStr.toLowerCase()] ?? byNumeric
  if (!hit) {
    return {
      error: {
        code: 'X402_UNSUPPORTED_CHAIN',
        message: `Chain "${chainStr}" is not supported for top-ups. Use a CAIP-2 id such as solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp, or a name such as solana.`,
      },
    }
  }
  return { chain: hit.caip2, chainId: hit.chainId, token }
}

function shadowResponse(paymentId: string, replay: boolean): Response {
  return fail(503, 'X402_PAYER_SHADOW', 'The payer is in shadow mode: the payment was checked and recorded, but not signed.', {
    paymentId,
    wouldSign: true,
    replay,
  })
}

/** An expired credential whose debit went back to the balance is dead. */
function isRefunded(p: LedgerPayment): boolean {
  return Boolean(p.refunded_at) || p.status === 'expired'
}

function refundedResponse(p: LedgerPayment): Response {
  return fail(410, 'X402_CREDENTIAL_REFUNDED',
    'This credential expired unused and its amount was returned to your balance. Fetch a new 402 challenge and sign it with a new idempotencyKey.',
    { paymentId: p.id, refundedAt: p.refunded_at ?? null })
}

function storedPaymentResponse(p: LedgerPayment, replay: boolean, balanceUsd?: string): Response {
  if (isRefunded(p)) return refundedResponse(p)
  if (p.mode === 'shadow' || !p.credential) return shadowResponse(p.id, replay)
  const paymentPayload = p.credential
  return json(200, {
    ok: true,
    replay,
    paymentId: p.id,
    network: p.network,
    amountUsd: p.amount_usd,
    validBefore: p.valid_before,
    header: 'PAYMENT-SIGNATURE',
    paymentSignature: encodePaymentSignatureHeader(paymentPayload as any),
    paymentPayload,
    ...(balanceUsd !== undefined ? { balanceUsd } : {}),
  })
}

async function sign(request: Request, deps: X402PayerDeps): Promise<Response> {
  const token = readAgentKey(request)
  if (!token) return fail(401, 'X402_KEY_INVALID', 'Send the agent key as "Authorization: Bearer ak_...".')
  const body = await readJson(request)
  if (!body) return fail(400, 'X402_INVALID_REQUEST', 'Body must be a JSON object.')

  const idempotencyKey = body.idempotencyKey
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return fail(400, 'X402_IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required: 8 to 128 chars of [A-Za-z0-9_.:-], one per 402 challenge.')
  }
  if (body.x402Version !== undefined && body.x402Version !== 2) {
    return fail(400, 'X402_UNSUPPORTED_VERSION', 'Only x402Version 2 is supported.')
  }
  const selected = selectRequirement(body.accepts)
  if ('error' in selected) return fail(400, selected.error.code, selected.error.message)
  const req: ValidatedRequirement = selected.ok
  const amountUsd = atomicToUsd(req.amountAtomic)

  // budget (design 5.1); maxAmountUsd accepted as an alias.
  const budgetRaw = body.budget ?? body.maxAmountUsd
  if (budgetRaw !== undefined && budgetRaw !== null) {
    const budget = Number(budgetRaw)
    if (!Number.isFinite(budget) || budget <= 0) return fail(400, 'X402_INVALID_REQUEST', 'budget must be a positive USD amount.')
    if (Number(amountUsd) > budget) {
      return fail(402, 'X402_BUDGET_EXCEEDED', `The challenge asks $${amountUsd}, above budget $${budget}.`)
    }
  }

  const hash = await requirementHash(req)
  const digest = await sha256Hex(token)

  // 1. Switch, account, and what this idempotency key already maps to.
  const acct = await deps.ledger!.getAccount(digest, idempotencyKey)
  if (acct.outcome !== 'ok') return outcomeResponse(acct)
  // Authorisation first, replay second: a stored credential is handed out
  // again only while the switch is still on and the key is still active.
  const mode = acct.mode
  if (mode === 'off') return outcomeResponse({ ...acct, outcome: 'disabled' })
  const a = acct.account!
  if (a.status !== 'active') return outcomeResponse({ ...acct, outcome: 'account_inactive', status: a.status })
  if (acct.payment) {
    if ('foreign' in acct.payment || acct.payment.accepts_hash !== hash) {
      return outcomeResponse({ ...acct, outcome: 'conflict' })
    }
    if (mode !== 'on') return shadowResponse(acct.payment.id, true)
    return storedPaymentResponse(acct.payment, true, acct.account?.balance_usd)
  }

  // 2. Fast local pre-checks so a doomed request never reaches a signer. The
  //    ledger re-checks all of them inside the commit transaction.
  if (Number(amountUsd) > Number(a.per_tx_limit_usd)) {
    return outcomeResponse({ ...acct, outcome: 'per_tx_limit', limit_usd: a.per_tx_limit_usd })
  }
  if (mode === 'on' && Number(a.balance_usd) < Number(amountUsd)) {
    return outcomeResponse({ ...acct, outcome: 'insufficient_balance', balance_usd: a.balance_usd })
  }

  // 3. Sign (on) or draw a placeholder nonce (shadow).
  let funder: string
  let nonce: string
  let credential: Record<string, unknown> | null = null
  let validBeforeUnix: number | null = null
  const isEvm = req.network === BASE_MAINNET_CAIP2
  if (mode === 'on') {
    if (isEvm) {
      if (!deps.evmRemote) return fail(503, 'X402_SIGNER_NOT_CONFIGURED', 'Base signing is not configured on this deployment.')
      // Same (agent key, idempotencyKey) -> same remote key and, while the
      // first attempt is still valid, the same nonce and validBefore, so a
      // retry after a timeout asks the signing service for the identical
      // authorization (it answers idempotently) instead of a second one.
      const remoteKey = await sha256Hex(`x402:${a.id}:${idempotencyKey}`)
      const attempt = await loadOrCreateAttempt(deps, remoteKey, hash, req.maxTimeoutSeconds)
      const signed = await remoteSignEvmExact(deps.evmRemote, req, {
        nonce: attempt.nonce,
        validBeforeUnix: attempt.validBefore,
        idempotencyKey: remoteKey,
        paymentReference: `x402req_${remoteKey.slice(0, 32)}`,
      })
      // Nothing is debited on any error: the ledger commit below never ran.
      if ('error' in signed) return fail(signed.error.status, signed.error.code, signed.error.message)
      funder = signed.ok.funder
      nonce = signed.ok.nonce
      validBeforeUnix = signed.ok.validBeforeUnix
      credential = buildPaymentPayload(body, req, signed.ok.payload)
    } else {
      const signer = await deps.svmSigner()
      if (!signer) return fail(503, 'X402_SIGNER_NOT_CONFIGURED', 'Solana signing is not configured on this deployment.')
      try {
        const r = await signSolanaExact(signer, req, deps.svmBuild)
        funder = r.funder
        nonce = r.nonce
        credential = buildPaymentPayload(body, req, r.payload)
      } catch (err) {
        if (err instanceof SvmSignError) return fail(400, 'X402_INVALID_REQUIREMENT', err.message)
        throw err
      }
    }
  } else {
    // Shadow: no signer is touched. The funder address is what would sign.
    if (isEvm) {
      funder = FUNDER_WALLET
      nonce = randomEvmNonce()
      validBeforeUnix = deps.nowSeconds() + req.maxTimeoutSeconds
    } else {
      const signer = await deps.svmSigner()
      funder = signer ? String(signer.address) : 'unconfigured'
      nonce = randomSvmNonce()
    }
  }

  // 4. One transaction: idempotency row + nonce + credential + debit.
  const committed = await deps.ledger!.commitPayment({
    key_digest: digest,
    idempotency_key: idempotencyKey,
    accepts_hash: hash,
    accepts: req.raw,
    scheme: 'exact',
    network: req.network,
    asset: req.asset,
    amount_atomic: req.amount,
    pay_to: req.payTo,
    funder,
    nonce,
    credential,
    valid_before_unix: validBeforeUnix,
    mode,
  })
  if (committed.outcome !== 'created' && committed.outcome !== 'replay') return outcomeResponse(committed)
  const stored = committed.payment as LedgerPayment
  // A replay found at commit (lost race) is subject to the same rule: the
  // ledger reports the switch as it is now.
  if (committed.outcome === 'replay' && committed.mode !== 'on') return shadowResponse(stored.id, true)
  return storedPaymentResponse(stored, committed.outcome === 'replay', committed.balance_usd)
}

const ATTEMPT_PREFIX = 'x402payer:attempt:'

/**
 * Signing parameters of the first attempt for one remote key, reused by
 * retries while still valid. KV is eventually consistent across colos: a
 * retry that misses the cache draws new parameters and the signing service
 * answers 409, surfaced as X402_IDEMPOTENCY_CONFLICT (use a new key).
 */
async function loadOrCreateAttempt(
  deps: X402PayerDeps,
  remoteKey: string,
  hash: string,
  maxTimeoutSeconds: number,
): Promise<{ nonce: `0x${string}`; validBefore: number }> {
  const now = deps.nowSeconds()
  const kvKey = ATTEMPT_PREFIX + remoteKey
  try {
    const raw = await deps.kv?.get(kvKey)
    if (raw) {
      const prev = JSON.parse(raw) as { nonce: `0x${string}`; validBefore: number; hash: string }
      if (prev.hash === hash && prev.validBefore > now + 5 && /^0x[0-9a-f]{64}$/.test(prev.nonce)) {
        return { nonce: prev.nonce, validBefore: prev.validBefore }
      }
    }
  } catch {
    // fall through to fresh parameters
  }
  const fresh = { nonce: randomEvmNonce(), validBefore: now + maxTimeoutSeconds }
  await deps.kv?.put(kvKey, JSON.stringify({ ...fresh, hash }), { expirationTtl: Math.max(120, maxTimeoutSeconds + 120) })
  return fresh
}

/** x402 v2 PaymentPayload: the requirement exactly as the server sent it. */
function buildPaymentPayload(body: Record<string, unknown>, req: ValidatedRequirement, payload: object): Record<string, unknown> {
  const resource = body.resource && typeof body.resource === 'object' && !Array.isArray(body.resource) ? body.resource : undefined
  return {
    x402Version: 2,
    ...(resource ? { resource } : {}),
    accepted: req.raw,
    payload,
  }
}
