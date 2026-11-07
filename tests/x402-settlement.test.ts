import { rpc } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/index'
import { checkAndBumpWindowLimit } from '../src/mpp/rate-limit-do'
import { runBoundedSettlement, type StellarX402SettleResult } from '../src/mpp/stellar-x402-server'
import { orderStatsRow, type OrderLedgerEntry } from '../src/services/order-ledger'
import {
  claimSettlementAlertSlot,
  resolveOpenX402Settlements,
  RESOLVER_GIVE_UP_MS,
  settleAndRecordX402,
  TX_EXPIRED_AFTER_MS,
} from '../src/services/x402-settlement'
import { toPublicRow } from '../src/routes/ledger'
import { sendAlert } from '../src/utils/alert'

vi.mock('../src/mpp/rate-limit-do', () => ({ checkAndBumpWindowLimit: vi.fn() }))
vi.mock('../src/utils/alert', async (original) => ({
  ...(await original<typeof import('../src/utils/alert')>()),
  alertSinkConfigured: () => true,
  sendAlert: vi.fn(async () => true),
}))

const limiter = vi.mocked(checkAndBumpWindowLimit)
const alert = vi.mocked(sendAlert)

function fakeEnv() {
  const store = new Map<string, string>()
  const kv = {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    }),
  }
  return { env: { MPP_STORE: kv, STELLAR_RPC_URL: 'https://rpc.invalid' } as unknown as Env, store }
}

function fakeCtx() {
  const pending: Promise<unknown>[] = []
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext, pending }
}

function rows(store: Map<string, string>): OrderLedgerEntry[] {
  return [...store].filter(([k]) => k.startsWith('mercury_order:')).map(([, v]) => JSON.parse(v))
}

const baseParams = {
  payload: {} as never,
  requirements: {} as never,
  routeId: 'deepseek_chat',
  payer: 'GPAYER',
  amountUsd: '0.035',
  requestPath: '/chat',
  upstreamStatus: 200,
  latencyMs: 10,
}

const settled = (tx: string): StellarX402SettleResult => ({
  success: true, outcome: 'settled', transaction: tx, attemptedTxs: [tx], causes: [],
})

beforeEach(() => {
  limiter.mockReset()
  limiter.mockResolvedValue({ ok: true, used: 1, limit: 1 })
  alert.mockClear()
})

describe('runBoundedSettlement', () => {
  it('returns settled on success', async () => {
    const r = await runBoundedSettlement(async () => ({ success: true, transaction: 'abc' }))
    expect(r).toMatchObject({ success: true, outcome: 'settled', transaction: 'abc' })
  })

  it('stops waiting for a settlement that hangs', async () => {
    const r = await runBoundedSettlement(() => new Promise(() => undefined), undefined, 20)
    expect(r).toMatchObject({ success: false, outcome: 'unknown', errorReason: 'settle_wait_exceeded' })
  })

  it('keeps a hung signed tx as unknown with its hash', async () => {
    const r = await runBoundedSettlement(() => new Promise(() => undefined), undefined, 20, (t) => {
      t.hashes.push('h1')
      t.accepted = true
    })
    expect(r).toMatchObject({ outcome: 'unknown', attemptedTxs: ['h1'] })
  })

  it('retries a transient failure once, and the retry can settle', async () => {
    const attempt = vi.fn()
      .mockResolvedValueOnce({ success: false, errorReason: 'unexpected_verify_error' })
      .mockResolvedValueOnce({ success: true, transaction: 'abc' })
    const r = await runBoundedSettlement(attempt)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(r.outcome).toBe('settled')
  })

  it('does not retry more than once', async () => {
    const attempt = vi.fn(async () => ({ success: false, errorReason: 'unexpected_settle_error' }))
    const r = await runBoundedSettlement(attempt)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ outcome: 'failed', errorReason: 'unexpected_settle_error' })
  })

  it('does not retry a payer-side rejection', async () => {
    const attempt = vi.fn(async () => ({ success: false, errorReason: 'invalid_exact_stellar_payload_simulation_failed' }))
    const r = await runBoundedSettlement(attempt)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(r.outcome).toBe('failed')
  })

  it('does not retry once the RPC accepted a tx', async () => {
    const attempt = vi.fn(async () => ({ success: false, errorReason: 'unexpected_settle_error' }))
    const r = await runBoundedSettlement(attempt, undefined, 28_000, (t) => {
      t.accepted = true
      t.hashes.push('h1')
    })
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(r.outcome).toBe('unknown')
  })

  it('does not retry when too little time remains', async () => {
    const attempt = vi.fn(async () => ({ success: false, errorReason: 'unexpected_settle_error' }))
    await runBoundedSettlement(attempt, undefined, 5_000)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('calls an on-chain failure failed when only one tx was signed', async () => {
    const r = await runBoundedSettlement(
      async () => ({ success: false, errorReason: 'settle_exact_stellar_transaction_failed' }),
      undefined,
      28_000,
      (t) => {
        t.hashes.push('h1')
        t.accepted = true
        t.failedOnChain = true
      },
    )
    expect(r.outcome).toBe('failed')
  })

  it('keeps the underlying error the library only logged', async () => {
    const r = await runBoundedSettlement(async () => {
      const err = Object.assign(new Error('Request failed'), { response: { status: 429, data: 'preflight queue full' } })
      console.error('Unexpected verification error:', err)
      return { success: false, errorReason: 'invalid_exact_stellar_payload_wrong_asset' }
    })
    expect(r.causes[0]).toContain('status=429')
    expect(r.causes[0]).toContain('preflight queue full')
  })

  it('refuses to submit after the deadline', async () => {
    let refused: unknown
    let done: () => void = () => undefined
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })
    await runBoundedSettlement(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      refused = await new rpc.Server('https://rpc.invalid').sendTransaction({} as never).catch((e) => e)
      done()
      return { success: false }
    }, undefined, 10)
    await finished
    expect(String(refused)).toContain('not submitting')
  })

  it('does not capture console.error from outside a settlement', async () => {
    const r = await runBoundedSettlement(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return { success: true, transaction: 'abc' }
    })
    console.error('unrelated')
    expect(r.causes).toEqual([])
  })
})

describe('settleAndRecordX402', () => {
  it('writes the row and marker before settlement starts', async () => {
    const { env, store } = fakeEnv()
    const { ctx } = fakeCtx()
    let seen: OrderLedgerEntry[] = []
    let markers = 0
    await settleAndRecordX402({
      ...baseParams, env, ctx,
      settle: async () => {
        seen = rows(store)
        markers = [...store.keys()].filter((k) => k.startsWith('x402_settle_open:')).length
        return settled('abc')
      },
    })
    expect(seen[0].settlement_status).toBe('pending')
    expect(markers).toBe(1)
  })

  it('records a settled call, indexes the tx, clears the marker, does not alert', async () => {
    const { env, store } = fakeEnv()
    const { ctx } = fakeCtx()
    const r = await settleAndRecordX402({ ...baseParams, env, ctx, settle: async () => settled('abc') })
    expect(r.success).toBe(true)
    expect(rows(store)[0]).toMatchObject({ settlement_status: 'settled', settlement_ref: 'abc' })
    expect(store.get('mercury_order_tx:abc')).toBeDefined()
    expect([...store.keys()].some((k) => k.startsWith('x402_settle_open:'))).toBe(false)
    expect(alert).not.toHaveBeenCalled()
  })

  it('records a failed call with its cause and alerts', async () => {
    const { env, store } = fakeEnv()
    const { ctx } = fakeCtx()
    await settleAndRecordX402({
      ...baseParams, env, ctx,
      settle: async () => ({
        success: false, outcome: 'failed', errorReason: 'unexpected_verify_error', attemptedTxs: [],
        causes: ['Error: Request failed status=429'],
      }),
    })
    const row = rows(store)[0]
    expect(row).toMatchObject({ settlement_status: 'failed', settlement_ref: null, settlement_error_reason: 'unexpected_verify_error' })
    expect(row.settlement_error).toContain('429')
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it('keeps a marker for an unknown outcome, without a settlement_ref', async () => {
    const { env, store } = fakeEnv()
    const { ctx } = fakeCtx()
    await settleAndRecordX402({
      ...baseParams, env, ctx,
      settle: async () => ({
        success: false, outcome: 'unknown', transaction: 'h1', errorReason: 'settle_wait_exceeded',
        attemptedTxs: ['h1'], rpcStatus: 'NOT_FOUND', causes: [],
      }),
    })
    expect(rows(store)[0]).toMatchObject({ settlement_status: 'unknown', settlement_ref: null, settlement_attempt_txs: ['h1'] })
    expect([...store.keys()].some((k) => k.startsWith('x402_settle_open:'))).toBe(true)
    expect(alert).not.toHaveBeenCalled()
  })

  it('leaves a recoverable record when the Worker dies mid-settlement', async () => {
    const { env, store } = fakeEnv()
    const { ctx, pending } = fakeCtx()
    void settleAndRecordX402({
      ...baseParams, env, ctx,
      settle: async (_e, _p, _r, opts) => {
        await opts?.onSigned?.(['h1'])
        return new Promise(() => undefined)
      },
    })
    // The hash write waits out the KV same-key gap after the first marker write.
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    expect(pending).toHaveLength(1)
    expect(rows(store)[0].settlement_status).toBe('pending')

    const raw = [...store].find(([k]) => k.startsWith('x402_settle_open:'))![1]
    expect(JSON.parse(raw).entry.settlement_attempt_txs).toEqual(['h1'])

    await resolveOpenX402Settlements(env, { getStatus: async () => 'SUCCESS', now: Date.now() + 70_000 })
    expect(rows(store)[0]).toMatchObject({ settlement_status: 'settled', settlement_ref: 'h1' })
  })
})

describe('open marker writes', () => {
  it('spaces same-key writes so a second hash is not rate limited', async () => {
    const { env } = fakeEnv()
    const { ctx } = fakeCtx()
    const times: number[] = []
    const put = env.MPP_STORE.put.bind(env.MPP_STORE)
    env.MPP_STORE.put = (async (k: string, v: string) => {
      if (k.startsWith('x402_settle_open:')) times.push(Date.now())
      return put(k, v)
    }) as never
    await settleAndRecordX402({
      ...baseParams, env, ctx,
      settle: async (_e, _p, _r, opts) => {
        await opts?.onSigned?.(['h1'])
        await opts?.onSigned?.(['h1', 'h2'])
        return { success: false, outcome: 'unknown', attemptedTxs: ['h1', 'h2'], causes: [] }
      },
    })
    expect(times.length).toBeGreaterThanOrEqual(4)
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1_000)
  })
})

describe('resolveOpenX402Settlements', () => {
  async function open(hashes: string[]) {
    const f = fakeEnv()
    const { ctx } = fakeCtx()
    await settleAndRecordX402({
      ...baseParams, env: f.env, ctx,
      settle: async () => ({
        success: false, outcome: 'unknown', transaction: hashes[0], errorReason: 'settle_wait_exceeded',
        attemptedTxs: hashes, causes: [],
      }),
    })
    return f
  }

  it('leaves a recent row to its request', async () => {
    const { env, store } = await open(['h1'])
    const getStatus = vi.fn(async () => 'SUCCESS' as const)
    await resolveOpenX402Settlements(env, { getStatus, now: Date.now() + 1_000 })
    expect(getStatus).not.toHaveBeenCalled()
    expect(rows(store)[0].settlement_status).toBe('unknown')
  })

  it('does not call a tx failed before its time bound passed', async () => {
    const { env, store } = await open(['h1'])
    await resolveOpenX402Settlements(env, { getStatus: async () => 'NOT_FOUND', now: Date.now() + 120_000 })
    expect(rows(store)[0].settlement_status).toBe('unknown')
  })

  it('calls an expired tx failed, then alerts and closes', async () => {
    const { env, store } = await open(['h1'])
    await resolveOpenX402Settlements(env, { getStatus: async () => 'NOT_FOUND', now: Date.now() + TX_EXPIRED_AFTER_MS + 1 })
    expect(rows(store)[0]).toMatchObject({ settlement_status: 'failed', settlement_ref: null })
    expect([...store.keys()].some((k) => k.startsWith('x402_settle_open:'))).toBe(false)
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it('settles if any attempted tx landed', async () => {
    const { env, store } = await open(['h1', 'h2'])
    await resolveOpenX402Settlements(env, {
      getStatus: async (h) => (h === 'h2' ? 'SUCCESS' : 'NOT_FOUND'),
      now: Date.now() + 70_000,
    })
    expect(rows(store)[0]).toMatchObject({ settlement_status: 'settled', settlement_ref: 'h2' })
  })

  it('keeps a row open while the chain is unreadable, and gives up after a day', async () => {
    const { env, store } = await open(['h1'])
    const throws = async () => {
      throw new Error('429')
    }
    await resolveOpenX402Settlements(env, { getStatus: throws, now: Date.now() + TX_EXPIRED_AFTER_MS + 1 })
    expect([...store.keys()].some((k) => k.startsWith('x402_settle_open:'))).toBe(true)
    await resolveOpenX402Settlements(env, { getStatus: throws, now: Date.now() + RESOLVER_GIVE_UP_MS + 1 })
    expect(rows(store)[0]).toMatchObject({ settlement_status: 'unknown', settlement_error_reason: 'settle_wait_exceeded' })
    expect([...store.keys()].some((k) => k.startsWith('x402_settle_open:'))).toBe(false)
  })
})

describe('counting and display', () => {
  const entry: OrderLedgerEntry = {
    order_id: 'o', ts: '2026-11-07T00:00:00.000Z', route_id: 'deepseek_chat', payer: null, amount_usd: '0.035',
    settlement_ref: null, request_path: '/', upstream_status: 200, latency_ms: 1, refund_status: 'none',
  }

  it('writes no stats row while settlement is pending', async () => {
    expect(await orderStatsRow({ ...entry, settlement_status: 'pending' })).toBeNull()
  })

  it.each(['failed', 'unknown'] as const)('writes a %s row as unsettled, not as volume', async (settlement_status) => {
    expect((await orderStatsRow({ ...entry, settlement_status }))?.settled).toBe(0)
  })

  it('counts settled rows and other branches that carry a settlement reference', async () => {
    expect((await orderStatsRow({ ...entry, settlement_status: 'settled' }))?.settled).toBe(1)
    expect((await orderStatsRow({ ...entry, settlement_ref: 'receipt-ref' }))?.settled).toBe(1)
    // A legacy row with neither a status nor a reference never settled.
    expect((await orderStatsRow(entry))?.settled).toBe(0)
  })

  it('shows the settlement state publicly, without the internal detail', () => {
    const lists = { internal: new Set<string>(), unresolved: new Set<string>() }
    const row = toPublicRow(
      { ...entry, settlement_status: 'failed', settlement_error_reason: 'unexpected_verify_error', settlement_error: 'secret-ish' },
      lists,
    )
    expect(row).toMatchObject({ status: 'delivered', settlement_status: 'failed', settlement_error_reason: 'unexpected_verify_error' })
    expect(JSON.stringify(row)).not.toContain('secret-ish')
    expect(toPublicRow(entry, lists).settlement_status).toBe('not_recorded')
  })
})

describe('claimSettlementAlertSlot', () => {
  it('is hourly and fails open', async () => {
    limiter.mockResolvedValueOnce({ ok: false, used: 1, limit: 1 })
    await expect(claimSettlementAlertSlot({} as Env)).resolves.toBe(false)
    expect(limiter.mock.calls[0][3]).toBe(60 * 60 * 1000)
    limiter.mockRejectedValueOnce(new Error('do down'))
    await expect(claimSettlementAlertSlot({} as Env)).resolves.toBe(true)
  })
})
