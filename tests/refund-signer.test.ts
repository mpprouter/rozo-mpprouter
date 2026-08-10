import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  type Transaction,
} from '@stellar/stellar-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyRefund,
  assertRefundWithinPaid,
  runRefundSigner,
  sendAlert,
  type Env,
  type RefundSignerRpc,
} from '../src/refund-signer-core'

const USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

function env(secret: string): Env {
  return {
    ROUTER_URL: 'https://router.test',
    STELLAR_RPC_URL: 'https://rpc.test',
    AUTO_REFUND_MAX_ATOMIC: '1000000000',
    REFUND_ALERT_THRESHOLD_ATOMIC: '100000000',
    ROUTER_SIGNING_SECRET: secret,
    REFUND_EXECUTOR_TOKEN: 'executor-token',
    DINGTALK_ACCESS_TOKEN: 'alert-token',
  }
}

function job(signer: Keypair, amount = '10000') {
  return {
    refundId: 'refund-1', publicId: 'public-1', state: 'pending' as const,
    refundAmountAtomic: amount, reason: 'non_fulfillment', merchant: 'merchant.test',
    payment: {
      payer: Keypair.random().publicKey(), recipient: signer.publicKey(),
      asset: USDC, paymentTx: 'a'.repeat(64), amountAtomic: amount,
    },
  }
}

function rpcFixture(signer: Keypair, refundJob = job(signer)): RefundSignerRpc {
  const payment = new TransactionBuilder(new Account(refundJob.payment.payer, '1'), {
    fee: '100', networkPassphrase: Networks.PUBLIC,
  }).addOperation(new Contract(USDC).call(
    'transfer',
    Address.fromString(refundJob.payment.payer).toScVal(),
    Address.fromString(signer.publicKey()).toScVal(),
    nativeToScVal(BigInt(refundJob.payment.amountAtomic), { type: 'i128' }),
  )).setTimeout(30).build()
  refundJob.payment.paymentTx = payment.hash().toString('hex')
  return {
    getAccount: async () => new Account(signer.publicKey(), '1'),
    prepareTransaction: async (tx: Transaction) => TransactionBuilder.cloneFrom(tx, {
      fee: '100', sorobanData: new SorobanDataBuilder().build(),
    }).build(),
    sendTransaction: async () => ({ status: 'PENDING', hash: 'b'.repeat(64), latestLedger: 1, latestLedgerCloseTime: 1 }) as rpc.Api.SendTransactionResponse,
    getTransaction: async () => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 123,
      envelopeXdr: payment.toXDR(), resultXdr: '', resultMetaXdr: '',
    }) as rpc.Api.GetSuccessfulTransactionResponse,
  }
}

function ledgerFixture() {
  const alerts = new Map<string, string>()
  return {
    alerts,
    ledger: {
      reserve: vi.fn(async () => undefined),
      markConfirmed: vi.fn(async () => undefined),
      enqueueAlert: vi.fn(async (key: string, content: string) => { alerts.set(key, content) }),
    },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('refund signer policy', () => {
  it('uses strict $10 notification and $100 hold boundaries', () => {
    expect(classifyRefund(100_000_000n, 1_000_000_000n, 100_000_000n)).toBe('auto')
    expect(classifyRefund(100_000_001n, 1_000_000_000n, 100_000_000n)).toBe('auto_alert')
    expect(classifyRefund(999_999_999n, 1_000_000_000n, 100_000_000n)).toBe('auto_alert')
    expect(classifyRefund(1_000_000_000n, 1_000_000_000n, 100_000_000n)).toBe('hold_alert')
  })

  it('never reserves cumulative refunds above the independently verified payment', () => {
    expect(() => assertRefundWithinPaid(6n, 4n, 10n)).not.toThrow()
    expect(() => assertRefundWithinPaid(6n, 5n, 10n)).toThrow('exceed original payment')
  })

  it('fails closed when runtime policy tries to raise the hard $100 limit', async () => {
    const signer = Keypair.random()
    const unsafe = env(signer.secret())
    unsafe.AUTO_REFUND_MAX_ATOMIC = '1000000001'
    const { ledger } = ledgerFixture()
    await expect(runRefundSigner(unsafe, ledger, rpcFixture(signer))).rejects.toThrow('hard-coded safety limits')
  })

  it('leases, records, broadcasts, and confirms one exact signed refund', async () => {
    const signer = Keypair.random()
    const pending = job(signer)
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      requests.push({ path: url.pathname, body })
      if (url.pathname.endsWith('/pending')) return Response.json({ jobs: [pending] })
      if (url.pathname.endsWith('/lease')) return Response.json({ job: { ...pending, state: 'leased', lease: { id: body?.leaseId, until: new Date().toISOString() } } })
      return Response.json({ ok: true })
    }))

    const { ledger } = ledgerFixture()
    await runRefundSigner(env(signer.secret()), ledger, rpcFixture(signer, pending))

    expect(requests.map((request) => request.path)).toEqual([
      '/admin/refunds/pending', '/admin/refunds/lease',
      '/admin/refunds/complete', '/admin/refunds/confirm',
    ])
    const submitted = requests.find((request) => request.path.endsWith('/complete'))?.body
    const xdr = String(submitted?.signedXdr)
    const tx = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC) as Transaction
    expect(tx.signatures).toHaveLength(1)
    expect(tx.toEnvelope().v1().tx().ext().switch()).toBe(1)
    expect(tx.hash().toString('hex')).toBe(submitted?.refundTx)
  })

  it('refunds above $10 and emits one completion alert', async () => {
    const signer = Keypair.random()
    const large = job(signer, '100000001')
    const { ledger, alerts } = ledgerFixture()
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      if (url.hostname === 'oapi.dingtalk.com') return Response.json({ errcode: 0 })
      if (url.pathname.endsWith('/pending')) return Response.json({ jobs: [large] })
      if (url.pathname.endsWith('/lease')) return Response.json({ job: { ...large, state: 'leased', lease: { id: body?.leaseId, until: new Date().toISOString() } } })
      return Response.json({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    await runRefundSigner(env(signer.secret()), ledger, rpcFixture(signer, large))

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/lease'))).toBe(true)
    expect(alerts.size).toBe(1)
  })

  it('holds $100 without leasing and sends only one alert', async () => {
    const signer = Keypair.random()
    const held = job(signer, '1000000000')
    const { ledger, alerts } = ledgerFixture()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.hostname === 'router.test') return Response.json({ jobs: [held] })
      return Response.json({ errcode: 0 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rpcServer = rpcFixture(signer, held)
    await runRefundSigner(env(signer.secret()), ledger, rpcServer)
    await runRefundSigner(env(signer.secret()), ledger, rpcServer)

    expect(alerts.size).toBe(1)
    expect(ledger.reserve).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/lease'))).toBe(false)
  })

  it('treats DingTalk HTTP 200 with a nonzero errcode as a failed alert', async () => {
    const signer = Keypair.random()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ errcode: 310000, errmsg: 'invalid token' })))

    await expect(sendAlert(env(signer.secret()), 'refund alert')).rejects.toThrow('DingTalk alert rejected')
  })


  it('re-signs a submitted refund whose time bound expired instead of resubmitting dead XDR', async () => {
    const signer = Keypair.random()
    const base = job(signer)
    const payment = new TransactionBuilder(new Account(base.payment.payer, '1'), {
      fee: '100', networkPassphrase: Networks.PUBLIC,
    }).addOperation(new Contract(USDC).call(
      'transfer',
      Address.fromString(base.payment.payer).toScVal(),
      Address.fromString(signer.publicKey()).toScVal(),
      nativeToScVal(BigInt(base.payment.amountAtomic), { type: 'i128' }),
    )).setTimeout(30).build()
    base.payment.paymentTx = payment.hash().toString('hex')

    const expiredBase = new TransactionBuilder(new Account(signer.publicKey(), '1'), {
      fee: '100', networkPassphrase: Networks.PUBLIC,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) - 120 },
    }).addOperation(new Contract(USDC).call(
      'transfer',
      Address.fromString(signer.publicKey()).toScVal(),
      Address.fromString(base.payment.payer).toScVal(),
      nativeToScVal(BigInt(base.refundAmountAtomic), { type: 'i128' }),
    )).build()
    const expired = TransactionBuilder.cloneFrom(expiredBase, {
      fee: '100', sorobanData: new SorobanDataBuilder().build(),
    }).build()
    expired.sign(signer)
    const expiredHash = expired.hash().toString('hex')

    const submittedJob = {
      ...base, state: 'submitted' as const,
      refundTx: expiredHash, signedXdr: expired.toXDR(),
      lease: { id: 'lease-77', until: new Date(Date.now() + 60_000).toISOString() },
    }

    const requests: Array<{ path: string; body?: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const path = new URL(url).pathname
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      requests.push({ path, body })
      if (path.endsWith('/admin/refunds/pending')) {
        return new Response(JSON.stringify({ jobs: [submittedJob] }), { status: 200 })
      }
      if (path.endsWith('/admin/refunds/lease')) {
        const cleaned = { ...base, state: 'leased', lease: { id: (body as { leaseId: string }).leaseId, until: new Date(Date.now() + 60_000).toISOString() } }
        return new Response(JSON.stringify({ job: cleaned }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, errcode: 0 }), { status: 200 })
    }))

    let sent: Transaction | null = null
    const server: RefundSignerRpc = {
      getAccount: async () => new Account(signer.publicKey(), '5'),
      prepareTransaction: async (tx: Transaction) => TransactionBuilder.cloneFrom(tx, {
        fee: '100', sorobanData: new SorobanDataBuilder().build(),
      }).build(),
      sendTransaction: async (tx) => {
        sent = tx as Transaction
        return { status: 'PENDING', hash: (tx as Transaction).hash().toString('hex'), latestLedger: 1, latestLedgerCloseTime: 1 } as rpc.Api.SendTransactionResponse
      },
      getTransaction: async (hash: string) => {
        if (hash === expiredHash) {
          return { status: rpc.Api.GetTransactionStatus.NOT_FOUND } as rpc.Api.GetMissingTransactionResponse
        }
        return {
          status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 123,
          envelopeXdr: payment.toXDR(), resultXdr: '', resultMetaXdr: '',
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse
      },
    }

    const { ledger } = ledgerFixture()
    await runRefundSigner(env(signer.secret()), ledger, server)

    // A fresh envelope was signed and submitted — not the dead one.
    expect(sent).not.toBeNull()
    expect(sent!.hash().toString('hex')).not.toBe(expiredHash)
    // The dead envelope was requeued through the Router's sanctioned path…
    const requeue = requests.find((r) => r.path.endsWith('/admin/refunds/requeue-malformed'))?.body
    expect(requeue?.leaseId).toBe('lease-77')
    // …then the normal pending path signed fresh under a NEW lease and confirmed.
    const complete = requests.find((r) => r.path.endsWith('/admin/refunds/complete'))?.body
    expect(complete?.state).toBe('submitted')
    expect(complete?.refundTx).toBe(sent!.hash().toString('hex'))
    expect(complete?.leaseId).not.toBe('lease-77')
    const confirm = requests.find((r) => r.path.endsWith('/admin/refunds/confirm'))?.body
    expect(confirm?.leaseId).toBe(complete?.leaseId)
    expect(ledger.markConfirmed).toHaveBeenCalled()
  })

  it('rejects a Router job whose claimed payer differs from the on-chain transfer', async () => {
    const signer = Keypair.random()
    const forged = job(signer)
    const rpcServer = rpcFixture(signer, forged)
    forged.payment.payer = Keypair.random().publicKey()
    const { ledger } = ledgerFixture()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.pathname.endsWith('/pending')) return Response.json({ jobs: [forged] })
      return Response.json({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    await runRefundSigner(env(signer.secret()), ledger, rpcServer)

    expect(ledger.reserve).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/lease'))).toBe(false)
  })

  it('refuses a lease response that changes the verified refund proof', async () => {
    const signer = Keypair.random()
    const pending = job(signer)
    const rpcServer = rpcFixture(signer, pending)
    rpcServer.sendTransaction = vi.fn(rpcServer.sendTransaction)
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      requests.push(url.pathname)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      if (url.pathname.endsWith('/pending')) return Response.json({ jobs: [pending] })
      if (url.pathname.endsWith('/lease')) {
        return Response.json({
          job: {
            ...pending,
            refundAmountAtomic: '10001',
            state: 'leased',
            lease: { id: body?.leaseId, until: new Date().toISOString() },
          },
        })
      }
      return Response.json({ ok: true })
    }))
    const { ledger } = ledgerFixture()

    await runRefundSigner(env(signer.secret()), ledger, rpcServer)

    expect(requests).not.toContain('/admin/refunds/complete')
    expect(rpcServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('refuses to sign an RPC-prepared transaction above the hard fee cap', async () => {
    const signer = Keypair.random()
    const pending = job(signer)
    const rpcServer = rpcFixture(signer, pending)
    rpcServer.prepareTransaction = async (tx: Transaction) => TransactionBuilder.cloneFrom(tx, {
      fee: '10000001', sorobanData: new SorobanDataBuilder().build(),
    }).build()
    const { ledger } = ledgerFixture()
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      requests.push(url.pathname)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      if (url.pathname.endsWith('/pending')) return Response.json({ jobs: [pending] })
      if (url.pathname.endsWith('/lease')) return Response.json({ job: { ...pending, state: 'leased', lease: { id: body?.leaseId, until: new Date().toISOString() } } })
      return Response.json({ ok: true })
    }))

    await runRefundSigner(env(signer.secret()), ledger, rpcServer)

    expect(requests).not.toContain('/admin/refunds/complete')
  })
})
