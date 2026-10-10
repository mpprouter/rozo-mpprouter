import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { hashTypedData, recoverTypedDataAddress, getAddress } from 'viem'
import {
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  verifySignature,
} from '@solana/kit'
import { decodePaymentSignatureHeader } from '@x402/core/http'
import { handleX402Payer, type X402PayerDeps } from '../src/x402payer/routes'
import {
  BASE_MAINNET_CAIP2,
  BASE_USDC,
  SOLANA_MAINNET_CAIP2,
  SOLANA_USDC,
  requirementHash,
  selectRequirement,
  validateRequirement,
} from '../src/x402payer/requirements'
import { TRANSFER_WITH_AUTHORIZATION_TYPES, buildTransferWithAuthorizationTypedData, signEvmExact } from '../src/x402payer/evm'
import { signSolanaExact, x402SvmPayloadBuilder } from '../src/x402payer/svm'
import type { CommitArgs, LedgerResult, PayerMode, X402Ledger } from '../src/x402payer/ledger'
import { reconcileX402Payer } from '../src/x402payer/reconcile'

// ---------------------------------------------------------------------------
// Fake ledger with the same rules as x402_payment_commit (the SQL itself is
// covered by rozo-intents-api supabase/tests/x402_payer_ledger_test.sql).
// ---------------------------------------------------------------------------
interface Acct { id: string; digest: string; balance: number; perTx: number; daily: number; status: string }
interface Pay { id: string; account: string; key: string; hash: string; mode: 'shadow' | 'on'; credential: any; nonce: string; funder: string; network: string; asset: string; amount_usd: number; created: number }

class FakeLedger implements X402Ledger {
  mode: PayerMode = 'on'
  accounts = new Map<string, Acct>()
  payments: Pay[] = []
  commits = 0
  globalCap = 500
  topups: any[] = []

  private acctJson(a: Acct) {
    const spent = this.payments.filter((p) => p.account === a.id && p.mode === (this.mode === 'shadow' ? 'shadow' : 'on'))
      .reduce((s, p) => s + p.amount_usd, 0)
    return {
      id: a.id, status: a.status as any, balance_usd: a.balance.toFixed(6), per_tx_limit_usd: a.perTx.toFixed(6),
      daily_limit_usd: a.daily.toFixed(6), spent_today_usd: spent.toFixed(6), pay_to_allowlist: null, created_at: 'now',
    }
  }
  private payJson(p: Pay) {
    return {
      id: p.id, idempotency_key: p.key, accepts_hash: p.hash, network: p.network, asset: p.asset, amount_atomic: '0',
      amount_usd: p.amount_usd.toFixed(6), pay_to: 'x', funder: p.funder, nonce: p.nonce, credential: p.credential,
      valid_before: null, mode: p.mode, status: p.mode === 'on' ? 'signed' : 'would_sign', created_at: 'now',
    }
  }
  async createAccount(digest: string): Promise<LedgerResult> {
    if (this.mode === 'off') return { mode: 'off', outcome: 'disabled' }
    const a: Acct = { id: `acct-${this.accounts.size + 1}-0000-0000`, digest, balance: 0, perTx: 5, daily: 100, status: 'active' }
    this.accounts.set(digest, a)
    return { mode: this.mode, outcome: 'created', account: this.acctJson(a) }
  }
  async getAccount(digest: string, key?: string): Promise<LedgerResult> {
    if (this.mode === 'off') return { mode: 'off', outcome: 'disabled' }
    const a = this.accounts.get(digest)
    if (!a) return { mode: this.mode, outcome: 'unknown_key' }
    const out: LedgerResult = { mode: this.mode, outcome: 'ok', account: this.acctJson(a) }
    const p = key ? this.payments.find((x) => x.key === key) : undefined
    if (p) out.payment = p.account === a.id ? this.payJson(p) : { foreign: true }
    return out
  }
  async commitPayment(args: CommitArgs): Promise<LedgerResult> {
    this.commits++
    if (this.mode === 'off') return { mode: 'off', outcome: 'disabled' }
    const a = this.accounts.get(args.key_digest)
    if (!a) return { mode: this.mode, outcome: 'unknown_key' }
    const existing = this.payments.find((x) => x.key === args.idempotency_key)
    if (existing) {
      if (existing.account !== a.id || existing.hash !== args.accepts_hash) return { mode: this.mode, outcome: 'conflict' }
      return { mode: this.mode, outcome: 'replay', payment: this.payJson(existing), balance_usd: a.balance.toFixed(6) }
    }
    if (args.mode !== this.mode) return { mode: this.mode, outcome: 'mode_changed' }
    const usd = Number(args.amount_atomic) / 1e6
    if (usd > a.perTx) return { mode: this.mode, outcome: 'per_tx_limit', limit_usd: a.perTx.toFixed(6) }
    const spent = this.payments.filter((p) => p.account === a.id && p.mode === this.mode).reduce((s, p) => s + p.amount_usd, 0)
    if (spent + usd > a.daily) return { mode: this.mode, outcome: 'daily_limit', limit_usd: a.daily.toFixed(6), spent_today_usd: spent.toFixed(6) }
    const global = this.payments.filter((p) => p.mode === this.mode).reduce((s, p) => s + p.amount_usd, 0)
    if (global + usd > this.globalCap) return { mode: this.mode, outcome: 'global_cap' }
    if (a.balance < usd) return { mode: this.mode, outcome: 'insufficient_balance', balance_usd: a.balance.toFixed(6) }
    if (this.payments.some((p) => p.funder === args.funder && p.asset === args.asset && p.network === args.network && p.nonce === args.nonce)) {
      return { mode: this.mode, outcome: 'nonce_collision' }
    }
    const p: Pay = {
      id: `pay-${this.payments.length + 1}`, account: a.id, key: args.idempotency_key, hash: args.accepts_hash,
      mode: this.mode as 'shadow' | 'on', credential: this.mode === 'on' ? args.credential : null, nonce: args.nonce,
      funder: args.funder, network: args.network, asset: args.asset, amount_usd: usd, created: Date.now(),
    }
    this.payments.push(p)
    if (this.mode === 'on') a.balance -= usd
    return { mode: this.mode, outcome: 'created', payment: this.payJson(p), balance_usd: a.balance.toFixed(6) }
  }
  async registerTopup(args: any): Promise<LedgerResult> {
    this.topups.push(args)
    return { mode: this.mode, outcome: 'registered', credit: { outcome: 'pending' } }
  }
  async liabilitySnapshot() {
    return { mode: this.mode, accounts: this.accounts.size, balance_usd_total: '0', signed_unsettled_usd: '0', topups_review: 0 }
  }
}

function kv() {
  const m = new Map<string, string>()
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
  } as unknown as KVNamespace
}

const FUNDER_KEY = generatePrivateKey()
const FUNDER = privateKeyToAccount(FUNDER_KEY)
const PAY_TO = '0x1111111111111111111111111111111111111111'

function baseReq(overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'exact',
    network: BASE_MAINNET_CAIP2,
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '10000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
    ...overrides,
  }
}

let ledger: FakeLedger
let env: any
let deps: X402PayerDeps
let evmSigns = 0

beforeEach(() => {
  ledger = new FakeLedger()
  env = { MPP_STORE: kv(), ROZO_X402_TOPUP_API_KEY: 'topup-key' }
  evmSigns = 0
  deps = {
    ledger,
    evmSigner: async () => ({
      address: FUNDER.address,
      signTypedData: async (args: any) => {
        evmSigns++
        return FUNDER.signTypedData(args)
      },
    }),
    svmSigner: async () => null,
    svmBuild: async () => { throw new Error('not used') },
    fetchImpl: (async () => { throw new Error('no network in tests') }) as any,
    nowSeconds: () => 1_800_000_000,
  }
})

afterEach(() => vi.restoreAllMocks())

async function call(path: string, init: RequestInit & { key?: string } = {}) {
  const headers = new Headers(init.headers)
  if (init.key) headers.set('authorization', `Bearer ${init.key}`)
  if (init.body) headers.set('content-type', 'application/json')
  const res = await handleX402Payer(new Request(`https://router.test${path}`, { ...init, headers }), env, deps)
  return { status: res!.status, body: (await res!.json()) as any }
}

async function newKey(balance = 10): Promise<string> {
  const r = await call('/v1/x402/keys', { method: 'POST', body: '{}' })
  expect(r.status).toBe(201)
  const acct = [...ledger.accounts.values()].at(-1)!
  acct.balance = balance
  return r.body.apiKey
}

// ---------------------------------------------------------------------------
describe('switch three states', () => {
  it('off: every route answers 503 X402_PAYER_DISABLED', async () => {
    ledger.mode = 'on'
    const key = await newKey()
    ledger.mode = 'off'
    for (const [path, init] of [
      ['/v1/x402/keys', { method: 'POST', body: '{}' }],
      ['/v1/x402/balance', { method: 'GET', key }],
      ['/v1/x402/topup', { method: 'POST', key, body: JSON.stringify({ amount: '20' }) }],
      ['/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-off-0001', accepts: baseReq() }) }],
    ] as const) {
      const r = await call(path, init as any)
      expect(r.status, path).toBe(503)
      expect(r.body.code, path).toBe('X402_PAYER_DISABLED')
    }
    expect(evmSigns).toBe(0)
  })

  it('shadow: records would_sign, returns no signature, never signs or debits', async () => {
    ledger.mode = 'shadow'
    const key = await newKey(10)
    const r = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-shadow-1', accepts: baseReq() }) })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('X402_PAYER_SHADOW')
    expect(r.body.wouldSign).toBe(true)
    expect(r.body.paymentSignature).toBeUndefined()
    expect(evmSigns).toBe(0)
    expect(ledger.payments).toHaveLength(1)
    expect(ledger.payments[0].credential).toBeNull()
    expect([...ledger.accounts.values()][0].balance).toBe(10)
    // Top-ups stay closed in shadow.
    const t = await call('/v1/x402/topup', { method: 'POST', key, body: JSON.stringify({ amount: '20' }) })
    expect(t.body.code).toBe('X402_PAYER_SHADOW')
  })

  it('on: signs and debits', async () => {
    const key = await newKey(10)
    const ok = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-on-0001', accepts: baseReq() }) })
    expect(ok.status).toBe(200)
    expect(ok.body.header).toBe('PAYMENT-SIGNATURE')
    expect(ok.body.balanceUsd).toBe('9.990000')
    expect(evmSigns).toBe(1)
  })
})

describe('idempotency', () => {
  it('same key + same hash: same credential, signed once, debited once', async () => {
    const key = await newKey(10)
    const body = JSON.stringify({ idempotencyKey: 'idem-same-0001', accepts: baseReq() })
    const a = await call('/v1/x402/sign', { method: 'POST', key, body })
    const b = await call('/v1/x402/sign', { method: 'POST', key, body })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(b.body.replay).toBe(true)
    expect(b.body.paymentSignature).toBe(a.body.paymentSignature)
    expect(evmSigns).toBe(1)
    expect([...ledger.accounts.values()][0].balance).toBeCloseTo(9.99, 6)
  })

  it('same key + different hash: 409, nothing signed', async () => {
    const key = await newKey(10)
    await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-diff-0001', accepts: baseReq() }) })
    const r = await call('/v1/x402/sign', {
      method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-diff-0001', accepts: baseReq({ amount: '20000' }) }),
    })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('X402_IDEMPOTENCY_CONFLICT')
    expect(evmSigns).toBe(1)
  })

  it('different key: a new credential with a new nonce', async () => {
    const key = await newKey(10)
    const a = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-k-000001', accepts: baseReq() }) })
    const b = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-k-000002', accepts: baseReq() }) })
    expect(b.status).toBe(200)
    expect(b.body.replay).toBe(false)
    expect(b.body.paymentPayload.payload.authorization.nonce).not.toBe(a.body.paymentPayload.payload.authorization.nonce)
    expect(evmSigns).toBe(2)
  })

  it('same idempotency key from another agent key: 409 without the other credential', async () => {
    const k1 = await newKey(10)
    const k2 = await newKey(10)
    const body = JSON.stringify({ idempotencyKey: 'idem-shared-01', accepts: baseReq() })
    expect((await call('/v1/x402/sign', { method: 'POST', key: k1, body })).status).toBe(200)
    const r = await call('/v1/x402/sign', { method: 'POST', key: k2, body })
    expect(r.status).toBe(409)
    expect(r.body.paymentSignature).toBeUndefined()
  })

  it('a race lost at commit discards our signature and returns the winner', async () => {
    const key = await newKey(10)
    // Simulate the lookup missing a row that a parallel request then commits.
    const realGet = ledger.getAccount.bind(ledger)
    ledger.getAccount = async (d, _k) => realGet(d)
    const body = JSON.stringify({ idempotencyKey: 'idem-race-0001', accepts: baseReq() })
    const a = await call('/v1/x402/sign', { method: 'POST', key, body })
    const b = await call('/v1/x402/sign', { method: 'POST', key, body })
    expect(b.body.replay).toBe(true)
    expect(b.body.paymentSignature).toBe(a.body.paymentSignature)
  })

  it('idempotencyKey is required', async () => {
    const key = await newKey(10)
    const r = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ accepts: baseReq() }) })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('X402_IDEMPOTENCY_KEY_REQUIRED')
  })

  it('hash binds payTo, amount, asset, network and maxTimeoutSeconds but not key order', async () => {
    const h = async (o: Record<string, unknown>) => {
      const r = selectRequirement(o)
      if ('error' in r) throw new Error(r.error.message)
      return requirementHash(r.ok)
    }
    const base = await h(baseReq())
    const reordered = await h(Object.fromEntries(Object.entries(baseReq()).reverse()))
    expect(reordered).toBe(base)
    expect(await h(baseReq({ payTo: PAY_TO.toUpperCase().replace('0X', '0x') }))).toBe(base)
    for (const o of [{ amount: '10001' }, { payTo: '0x2222222222222222222222222222222222222222' }, { maxTimeoutSeconds: 61 }]) {
      expect(await h(baseReq(o))).not.toBe(base)
    }
  })
})

describe('replay is re-authorised', () => {
  it('a stored credential is not returned once the switch is shadow/off or the key is suspended', async () => {
    const key = await newKey(10)
    const body = JSON.stringify({ idempotencyKey: 'idem-reauth-01', accepts: baseReq() })
    const first = await call('/v1/x402/sign', { method: 'POST', key, body })
    expect(first.status).toBe(200)

    ledger.mode = 'shadow'
    const s1 = await call('/v1/x402/sign', { method: 'POST', key, body })
    expect(s1.status).toBe(503)
    expect(s1.body.code).toBe('X402_PAYER_SHADOW')
    expect(s1.body.paymentSignature).toBeUndefined()

    ledger.mode = 'off'
    const s2 = await call('/v1/x402/sign', { method: 'POST', key, body })
    expect(s2.status).toBe(503)
    expect(s2.body.code).toBe('X402_PAYER_DISABLED')
    expect(s2.body.paymentSignature).toBeUndefined()

    ledger.mode = 'on'
    ;[...ledger.accounts.values()][0].status = 'suspended'
    const s3 = await call('/v1/x402/sign', { method: 'POST', key, body })
    expect(s3.status).toBe(403)
    expect(s3.body.code).toBe('X402_KEY_SUSPENDED')
    expect(s3.body.paymentSignature).toBeUndefined()

    ;[...ledger.accounts.values()][0].status = 'active'
    const s4 = await call('/v1/x402/sign', { method: 'POST', key, body })
    expect(s4.status).toBe(200)
    expect(s4.body.paymentSignature).toBe(first.body.paymentSignature)
    expect(evmSigns).toBe(1)
  })
})

describe('balance and limits', () => {
  it('per-tx limit -> 402 X402_PER_TX_LIMIT_EXCEEDED', async () => {
    const key = await newKey(100)
    const r = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-lim-0001', accepts: baseReq({ amount: '5000001' }) }) })
    expect(r.status).toBe(402)
    expect(r.body.code).toBe('X402_PER_TX_LIMIT_EXCEEDED')
    expect(evmSigns).toBe(0)
  })

  it('insufficient balance -> 402 X402_INSUFFICIENT_BALANCE', async () => {
    const key = await newKey(0.005)
    const r = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-lim-0002', accepts: baseReq() }) })
    expect(r.status).toBe(402)
    expect(r.body.code).toBe('X402_INSUFFICIENT_BALANCE')
    expect(evmSigns).toBe(0)
  })

  it('daily limit -> 429 X402_DAILY_LIMIT_EXCEEDED', async () => {
    const key = await newKey(1000)
    ;[...ledger.accounts.values()][0].daily = 7
    const ok = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-lim-0003', accepts: baseReq({ amount: '5000000' }) }) })
    expect(ok.status).toBe(200)
    const r = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-lim-0004', accepts: baseReq({ amount: '2500000' }) }) })
    expect(r.status).toBe(429)
    expect(r.body.code).toBe('X402_DAILY_LIMIT_EXCEEDED')
  })

  it('global cap -> 429 X402_GLOBAL_DAILY_CAP_REACHED', async () => {
    const key = await newKey(1000)
    ledger.globalCap = 1
    const r = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-lim-0005', accepts: baseReq({ amount: '2000000' }) }) })
    expect(r.status).toBe(429)
    expect(r.body.code).toBe('X402_GLOBAL_DAILY_CAP_REACHED')
  })

  it('budget guard (maxAmountUsd alias too)', async () => {
    const key = await newKey(10)
    for (const field of ['budget', 'maxAmountUsd']) {
      const r = await call('/v1/x402/sign', {
        method: 'POST', key, body: JSON.stringify({ idempotencyKey: `idem-budget-${field}`, accepts: baseReq({ amount: '2000000' }), [field]: '1' }),
      })
      expect(r.status).toBe(402)
      expect(r.body.code).toBe('X402_BUDGET_EXCEEDED')
    }
    expect(evmSigns).toBe(0)
  })

  it('x402Version 1 is refused with X402_UNSUPPORTED_VERSION', async () => {
    const key = await newKey(10)
    const r = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-v1-00001', x402Version: 1, accepts: baseReq() }) })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('X402_UNSUPPORTED_VERSION')
  })

  it('unknown or malformed key -> 401', async () => {
    const r = await call('/v1/x402/balance', { method: 'GET', key: 'ak_' + 'A'.repeat(43) })
    expect(r.status).toBe(401)
    const r2 = await call('/v1/x402/balance', { method: 'GET', key: 'not-a-key' })
    expect(r2.status).toBe(401)
  })

  it('balance reports limits', async () => {
    const key = await newKey(12.5)
    const r = await call('/v1/x402/balance', { method: 'GET', key })
    expect(r.body).toMatchObject({ ok: true, mode: 'on', balanceUsd: '12.500000', perTxLimitUsd: '5.000000', dailyLimitUsd: '100.000000' })
  })
})

describe('CAIP-2 network ids', () => {
  for (const net of ['solana:mainnet', 'solana', 'solana-mainnet', 'base', 'base-mainnet']) {
    it(`rejects shorthand ${net}`, async () => {
      const key = await newKey(10)
      const r = await call('/v1/x402/sign', {
        method: 'POST', key,
        body: JSON.stringify({ idempotencyKey: 'idem-net-0001', accepts: { ...baseReq(), network: net, asset: net.startsWith('solana') ? SOLANA_USDC : BASE_USDC } }),
      })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('X402_UNSUPPORTED_NETWORK')
      expect(r.body.error.message).toMatch(/CAIP-2/)
    })
  }

  it('rejects other CAIP-2 networks and non-USDC assets', () => {
    expect(validateRequirement(baseReq({ network: 'eip155:84532' }))).toMatchObject({ error: { code: 'X402_UNSUPPORTED_NETWORK' } })
    expect(validateRequirement(baseReq({ asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }))).toMatchObject({ error: { code: 'X402_UNSUPPORTED_ASSET' } })
    expect(validateRequirement(baseReq({ scheme: 'upto' }))).toMatchObject({ error: { code: 'X402_UNSUPPORTED_SCHEME' } })
  })

  it('picks the first supported entry from a raw accepts array', () => {
    const r = selectRequirement([{ ...baseReq(), network: 'eip155:84532' }, baseReq()])
    expect('ok' in r && r.ok.network).toBe(BASE_MAINNET_CAIP2)
  })
})

describe('EVM typed data (EIP-3009 TransferWithAuthorization)', () => {
  // Copied from @x402/evm 2.9.0 src/constants.ts (authorizationTypes).
  const OFFICIAL_TYPES = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  }

  it('domain, types, primaryType and message match the x402 exact EVM client', async () => {
    const r = validateRequirement(baseReq())
    if (!('ok' in r)) throw new Error('invalid')
    const nonce = `0x${'ab'.repeat(32)}` as const
    const signed = await signEvmExact(FUNDER as any, r.ok, { nowSeconds: 1_800_000_000, nonce })
    const auth = signed.payload.authorization
    expect(auth).toEqual({
      from: FUNDER.address,
      to: getAddress(PAY_TO),
      value: '10000',
      validAfter: String(1_800_000_000 - 600),
      validBefore: String(1_800_000_000 + 60),
      nonce,
    })
    const td = buildTransferWithAuthorizationTypedData(r.ok, auth)
    expect(td.primaryType).toBe('TransferWithAuthorization')
    expect(td.types).toEqual(OFFICIAL_TYPES)
    expect(TRANSFER_WITH_AUTHORIZATION_TYPES).toEqual(OFFICIAL_TYPES)
    expect(td.domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    })
    // Not ReceiveWithAuthorization: the struct hash must differ.
    const receiveHash = hashTypedData({
      domain: td.domain,
      types: { ReceiveWithAuthorization: OFFICIAL_TYPES.TransferWithAuthorization },
      primaryType: 'ReceiveWithAuthorization',
      message: td.message,
    })
    expect(hashTypedData({ ...td, types: OFFICIAL_TYPES } as any)).not.toBe(receiveHash)
    const recovered = await recoverTypedDataAddress({ ...td, types: OFFICIAL_TYPES, signature: signed.payload.signature } as any)
    expect(recovered).toBe(FUNDER.address)
  })

  it('refuses a requirement without the USDC EIP-712 domain', () => {
    expect(validateRequirement(baseReq({ extra: {} }))).toMatchObject({ error: { code: 'X402_INVALID_REQUIREMENT' } })
    expect(validateRequirement(baseReq({ extra: { name: 'USDC', version: '2' } }))).toMatchObject({ error: { code: 'X402_INVALID_REQUIREMENT' } })
  })

  it('the PAYMENT-SIGNATURE value decodes to an x402 v2 payload with the requirement as sent', async () => {
    const key = await newKey(10)
    const accepts = baseReq()
    const r = await call('/v1/x402/sign', {
      method: 'POST', key,
      body: JSON.stringify({ idempotencyKey: 'idem-hdr-0001', accepts, resource: { url: 'https://api.example.com/x' } }),
    })
    const decoded = decodePaymentSignatureHeader(r.body.paymentSignature)
    expect(decoded.x402Version).toBe(2)
    expect(decoded.accepted).toEqual(accepts)
    expect((decoded as any).resource).toEqual({ url: 'https://api.example.com/x' })
    expect((decoded.payload as any).authorization.from).toBe(FUNDER.address)
  })
})

describe('Solana exact (partially signed, facilitator pays fees)', () => {
  const FACILITATOR = 'BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP'

  function mintAccountData(): string {
    const b = new Uint8Array(82)
    b[44] = 6 // decimals
    b[45] = 1 // is_initialized
    return btoa(String.fromCharCode(...b))
  }

  it('builds the official @x402/svm transaction with the funder as authority only', async () => {
    const signer = await generateKeyPairSigner()
    const blockhash = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'
    const rpcCalls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_input: any, init?: any) => {
      const req = JSON.parse(String(init?.body ?? '{}'))
      rpcCalls.push(req.method)
      const result = req.method === 'getAccountInfo'
        ? { context: { slot: 1 }, value: { data: [mintAccountData(), 'base64'], executable: false, lamports: 1_000_000, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 82 } }
        : { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 100 } }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any)

    const r = validateRequirement({
      scheme: 'exact', network: SOLANA_MAINNET_CAIP2, asset: SOLANA_USDC, amount: '25000',
      payTo: 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5', maxTimeoutSeconds: 60, extra: { feePayer: FACILITATOR },
    })
    if (!('ok' in r)) throw new Error(JSON.stringify(r))
    const out = await signSolanaExact(signer, r.ok, x402SvmPayloadBuilder('https://rpc.test'))
    expect(rpcCalls).toEqual(expect.arrayContaining(['getAccountInfo', 'getLatestBlockhash']))

    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(out.payload.transaction))
    const sigs = tx.signatures as Record<string, Uint8Array | null>
    expect(Object.keys(sigs)[0]).toBe(FACILITATOR)
    expect(sigs[FACILITATOR]).toBeNull()
    expect(sigs[signer.address]).toBeTruthy()
    expect(await verifySignature(signer.keyPair.publicKey, sigs[signer.address] as any, tx.messageBytes)).toBe(true)
    expect(out.funder).toBe(signer.address)
    expect(out.nonce.length).toBeGreaterThan(80)
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
    expect(String(msg.staticAccounts[0])).toBe(FACILITATOR)
    expect(msg.staticAccounts.map(String)).toContain(SOLANA_USDC)
    expect(getAddressEncoder().encode(signer.address).length).toBe(32)
  })

  it('refuses a challenge naming our funder as fee payer', async () => {
    const signer = await generateKeyPairSigner()
    const r = validateRequirement({
      scheme: 'exact', network: SOLANA_MAINNET_CAIP2, asset: SOLANA_USDC, amount: '25000',
      payTo: 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5', maxTimeoutSeconds: 60, extra: { feePayer: signer.address },
    })
    if (!('ok' in r)) throw new Error('invalid')
    await expect(signSolanaExact(signer, r.ok, async () => ({ transaction: '' }))).rejects.toThrow(/feePayer/)
  })

  it('Solana requires extra.feePayer', () => {
    expect(validateRequirement({
      scheme: 'exact', network: SOLANA_MAINNET_CAIP2, asset: SOLANA_USDC, amount: '1',
      payTo: 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5', maxTimeoutSeconds: 60, extra: {},
    })).toMatchObject({ error: { code: 'X402_INVALID_REQUIREMENT' } })
  })
})

describe('topup', () => {
  it('creates a payment-api order under merchant_x402_topup and binds it', async () => {
    const key = await newKey(0)
    let sent: any = null
    deps.fetchImpl = (async (_u: any, init: any) => {
      sent = { body: JSON.parse(init.body), apiKey: new Headers(init.headers).get('X-API-Key') }
      return new Response(JSON.stringify({
        id: '6f1c6c7e-1111-4222-8333-944455556666',
        source: { chainId: '900', tokenSymbol: 'USDT', receiverAddress: 'DepositAddr111', amount: '20' },
        destination: { receiverAddress: '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739', amount: '19.80' },
        expiresAt: '2999-01-01T00:00:00Z',
      }), { status: 200 })
    }) as any
    const r = await call('/v1/x402/topup', { method: 'POST', key, body: JSON.stringify({ amount: '20', source: { chainId: '900', tokenSymbol: 'USDT' } }) })
    expect(r.status).toBe(200)
    expect(sent.apiKey).toBe('topup-key')
    expect(sent.body.appId).toBe('merchant_x402_topup')
    expect(sent.body.metadata.merchant_handle).toBe('x402_topup')
    expect(sent.body.destination.receiverAddress).toBe('0x2352Fa2970dBadD12d21808DB0F56CDEC8141739')
    expect(ledger.topups[0]).toMatchObject({ payment_id: '6f1c6c7e-1111-4222-8333-944455556666', requested_usd: '20' })
    expect(r.body.deposit.address).toBe('DepositAddr111')
    expect(r.body.creditUsd).toBe('19.80')
  })

  it('refuses to hand out a deposit when payment-api rerouted the destination', async () => {
    const key = await newKey(0)
    deps.fetchImpl = (async () => new Response(JSON.stringify({
      id: '6f1c6c7e-1111-4222-8333-944455556666',
      source: { receiverAddress: 'DepositAddr111' },
      destination: { receiverAddress: '0x9999999999999999999999999999999999999999' },
    }), { status: 200 })) as any
    const r = await call('/v1/x402/topup', { method: 'POST', key, body: JSON.stringify({ amount: '20', chain: 'base', token: 'USDC' }) })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('X402_TOPUP_MISCONFIGURED')
    expect(r.body.deposit).toBeUndefined()
    expect(ledger.topups).toHaveLength(0)
  })

  it('enforces min/max and stablecoin-only sources with explicit codes', async () => {
    const key = await newKey(0)
    const topup = async (b: Record<string, unknown>) => (await call('/v1/x402/topup', { method: 'POST', key, body: JSON.stringify(b) })).body
    expect((await topup({ amount: '4.99', chain: 'base', token: 'USDC' })).code).toBe('X402_TOPUP_AMOUNT_OUT_OF_RANGE')
    expect((await topup({ amount: '20', chain: 'base', token: 'ETH' })).code).toBe('X402_TOPUP_SOURCE_UNSUPPORTED')
    expect((await topup({ amount: '20', source: { chainId: '8453', tokenSymbol: 'ETH' } })).code).toBe('X402_TOPUP_SOURCE_UNSUPPORTED')
    expect((await topup({ amount: '20', chain: 'lightning', token: 'BTC' })).code).toBe('X402_TOPUP_SOURCE_UNSUPPORTED')
    expect((await topup({ amount: '20', chain: 'solana', token: 'SOL' })).code).toBe('X402_TOPUP_SOURCE_UNSUPPORTED')
    expect((await topup({ amount: '20', chain: 'base', token: 'USDT' })).code).toBe('X402_TOPUP_SOURCE_UNSUPPORTED')
    expect((await topup({ amount: '20', chain: 'solana:mainnet', token: 'USDC' })).code).toBe('X402_UNSUPPORTED_CHAIN')
  })

  it('never defaults the coin: missing chain or token is 400, no order created', async () => {
    const key = await newKey(0)
    let posts = 0
    deps.fetchImpl = (async () => { posts++; return new Response('{}') }) as any
    for (const b of [{ amount: '20' }, { amount: '20', token: 'USDT' }, { amount: '20', chain: 'solana' }, { amount: '20', source: {} }]) {
      const r = await call('/v1/x402/topup', { method: 'POST', key, body: JSON.stringify(b) })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('X402_TOPUP_SOURCE_REQUIRED')
    }
    expect(posts).toBe(0)
  })

  it('accepts {amount, token, chain} with CAIP-2 or a chain name and echoes chain/token', async () => {
    const key = await newKey(0)
    let sent: any = null
    deps.fetchImpl = (async (_u: any, init: any) => {
      sent = JSON.parse(init.body)
      return new Response(JSON.stringify({
        id: '6f1c6c7e-1111-4222-8333-944455556667',
        source: { chainId: '900', tokenSymbol: 'USDT', receiverAddress: 'DepositAddr222', amount: '20' },
        destination: { receiverAddress: '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739', amount: '19.80' },
        expiresAt: '2999-01-01T00:00:00Z',
      }), { status: 200 })
    }) as any
    for (const chain of ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana']) {
      const r = await call('/v1/x402/topup', { method: 'POST', key, body: JSON.stringify({ amount: '20', token: 'usdt', chain }) })
      expect(r.status).toBe(200)
      expect(sent.source).toMatchObject({ chainId: '900', tokenSymbol: 'USDT' })
      expect(r.body).toMatchObject({
        chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        token: 'USDT',
        deposit: { address: 'DepositAddr222', chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', token: 'USDT', amount: '20', expiresAt: '2999-01-01T00:00:00Z' },
      })
    }
  })

  it('refuses when payment-api answers with a different source coin', async () => {
    const key = await newKey(0)
    deps.fetchImpl = (async () => new Response(JSON.stringify({
      id: '6f1c6c7e-1111-4222-8333-944455556668',
      source: { chainId: '8453', tokenSymbol: 'USDC', receiverAddress: '0xabc' },
      destination: { receiverAddress: '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739' },
    }), { status: 200 })) as any
    const r = await call('/v1/x402/topup', { method: 'POST', key, body: JSON.stringify({ amount: '20', token: 'USDT', chain: 'solana' }) })
    expect(r.body.code).toBe('X402_TOPUP_MISCONFIGURED')
    expect(r.body.deposit).toBeUndefined()
    expect(ledger.topups).toHaveLength(0)
  })

  it('503 X402_SIGNER_NOT_CONFIGURED and no order when neither leg can sign', async () => {
    const key = await newKey(0)
    deps.evmSigner = async () => null
    deps.svmSigner = async () => null
    let posts = 0
    deps.fetchImpl = (async () => { posts++; return new Response('{}') }) as any
    const r = await call('/v1/x402/topup', { method: 'POST', key, body: JSON.stringify({ amount: '20', token: 'USDT', chain: 'solana' }) })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('X402_SIGNER_NOT_CONFIGURED')
    expect(r.body.deposit).toBeUndefined()
    expect(posts).toBe(0)
    expect(ledger.topups).toHaveLength(0)
  })

  it('503 when the top-up API key is not configured', async () => {
    const key = await newKey(0)
    delete env.ROZO_X402_TOPUP_API_KEY
    const r = await call('/v1/x402/topup', { method: 'POST', key, body: JSON.stringify({ amount: '20' }) })
    expect(r.body.code).toBe('X402_TOPUP_NOT_CONFIGURED')
  })
})

describe('configuration and reconciliation skeleton', () => {
  it('503 when the ledger is not configured', async () => {
    deps.ledger = null
    const r = await call('/v1/x402/balance', { method: 'GET' })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('X402_PAYER_NOT_CONFIGURED')
  })

  it('503 X402_SIGNER_NOT_CONFIGURED when the funder key is unset, nothing committed', async () => {
    const key = await newKey(10)
    deps.evmSigner = async () => null
    const r = await call('/v1/x402/sign', { method: 'POST', key, body: JSON.stringify({ idempotencyKey: 'idem-cfg-0001', accepts: baseReq() }) })
    expect(r.body.code).toBe('X402_SIGNER_NOT_CONFIGURED')
    expect(ledger.commits).toBe(0)
  })

  it('key creation is rate limited per IP', async () => {
    for (let i = 0; i < 10; i++) expect((await call('/v1/x402/keys', { method: 'POST', body: '{}' })).status).toBe(201)
    expect((await call('/v1/x402/keys', { method: 'POST', body: '{}' })).body.code).toBe('X402_KEY_RATE_LIMITED')
  })

  it('reconcile runs once per hour', async () => {
    const store = kv()
    expect((await reconcileX402Payer(store, ledger, 3_600_000 * 10)).ran).toBe(true)
    expect((await reconcileX402Payer(store, ledger, 3_600_000 * 10 + 120_000)).ran).toBe(false)
    expect((await reconcileX402Payer(store, ledger, 3_600_000 * 11)).ran).toBe(true)
    expect((await reconcileX402Payer(store, null)).ran).toBe(false)
  })
})
