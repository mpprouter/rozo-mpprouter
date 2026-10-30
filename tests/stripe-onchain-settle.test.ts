// manual_review records are closed from the chain: Stripe's relayer pulling
// the exact invoice amount from the funder after the intents payout is
// Stripe's confirmation, readable long after the session answers 410.
import { describe, it, expect } from 'vitest'
import {
  seedStripeRecord, stripeKvKey, settleManualReviewFromChain, sweepManualReviewOnchain,
  ONCHAIN_RESOLVED_BY, ONCHAIN_RECHECK_MS,
} from '../src/routes/stripe-fulfillment'
import { findStripeRelayerPull, STRIPE_RELAYER, STRIPE_PAYIN_CONTRACT, STRIPE_PULL_WINDOW_BLOCKS, STRIPE_PULL_CHUNK_BLOCKS, makeBaseRpc, parseAtomic } from '../src/utils/stripe-relayer-pull'
import { casRead } from '../src/routes/stripe-atomic'
import type { Env } from '../src/index'

function makeDoNamespace() {
  const store = new Map<string, string>(); const versions = new Map<string, number>()
  const stub = { async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url); const body: any = await req.json()
    if (url.pathname === '/read') return Response.json({ value: store.get(body.key) ?? null, version: versions.get(body.key) ?? 0 })
    if (url.pathname === '/commit') {
      const cur = versions.get(body.key) ?? 0
      if (cur !== body.expectedVersion) return Response.json({ ok: false, value: store.get(body.key) ?? null, version: cur })
      if (body.op === 'set') store.set(body.key, body.value); else store.delete(body.key)
      versions.set(body.key, body.expectedVersion + 1); return Response.json({ ok: true })
    }
    if (url.pathname === '/scan') return Response.json({ values: [...store.entries()].filter(([k]) => k.startsWith(body.prefix)).map(([, v]) => v) })
    return new Response('Not Found', { status: 404 })
  } }
  return { idFromName: (n: string) => ({ name: n }), get: (_id: any) => stub }
}
const TEST_CAP_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
function makeEnv(): Env {
  const kv = new Map<string, string>()
  return { MPP_STORE: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) },
    ATOMIC_STORE: makeDoNamespace(), PAYINVOICE_ADMIN_SECRET: 'admin', ROZO_INTENTS_API_KEY: 'key', ROZO_WEBHOOK_SECRET: 'whsec',
    INVOICE_CAPABILITY_ENCRYPTION_KEY: TEST_CAP_KEY } as unknown as Env
}

const FUNDER = '0x2352fa2970dbadd12d21808db0f56cdec8141739'
const PAYOUT_TX = '0x' + '11'.repeat(32)
const PULL_TX = '0x' + '22'.repeat(32)
const PAYOUT_BLOCK = 50786086
const AMOUNT = 31440000n
const T0 = new Date('2026-09-02T15:05:19Z')

function transferLog(to: string, amount: bigint, tx: string, block = PAYOUT_BLOCK + 6, index = 5) {
  return { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x' + amount.toString(16), transactionHash: tx,
    blockNumber: '0x' + block.toString(16), logIndex: '0x' + index.toString(16),
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + 'ab'.repeat(32), '0x' + to.slice(2).padStart(64, '0')] }
}
function fakeRpc(o: { sender?: string; contract?: string; amount?: bigint; status?: string; payoutLogs?: any[]; windowLogs?: any[]; inboundLogs?: any[] } = {}) {
  const calls: string[] = []
  const rpc = async (method: string, params: unknown[]) => {
    calls.push(method)
    if (method === 'eth_getTransactionReceipt') return { status: o.status ?? '0x1', blockNumber: '0x' + PAYOUT_BLOCK.toString(16), logs: o.payoutLogs ?? [transferLog(FUNDER, 31760000n, PAYOUT_TX, PAYOUT_BLOCK, 7)] }
    if (method === 'eth_getLogs') {
      const f = params[0] as any
      expect(parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16)).toBeLessThan(STRIPE_PULL_CHUNK_BLOCKS)
      if (f.topics[1] === null) {
        // inbound to the funder: the payout itself plus whatever the test adds
        const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16)
        return [transferLog(FUNDER, 31760000n, PAYOUT_TX, PAYOUT_BLOCK, 7), ...(o.inboundLogs ?? [])].filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= from && b <= to })
      }
      return o.windowLogs ?? [transferLog(FUNDER, 5000000n, '0x' + '33'.repeat(32)), transferLog(FUNDER, o.amount ?? AMOUNT, PULL_TX)]
    }
    if (method === 'eth_getTransactionByHash') return { from: o.sender ?? STRIPE_RELAYER, to: o.contract ?? STRIPE_PAYIN_CONTRACT }
    throw new Error(method)
  }
  return { rpc, calls }
}

describe('findStripeRelayerPull', () => {
  it('matches the exact amount pulled by the Stripe relayer after the payout', async () => {
    const { rpc, calls } = fakeRpc()
    expect(await findStripeRelayerPull(rpc, PAYOUT_TX, AMOUNT)).toBe(PULL_TX)
    // sibling scan over [start - W, start + W] plus the pull scan over [start, start + W], all in 50-block chunks
    expect(calls.filter((m) => m === 'eth_getLogs').length).toBe(13 + STRIPE_PULL_WINDOW_BLOCKS / STRIPE_PULL_CHUNK_BLOCKS)
    expect(calls.filter((m) => m === 'eth_getTransactionByHash').length).toBe(1)
  })
  it('rejects other senders, contracts, amounts, failed payouts, ambiguous receivers, rpc failures', async () => {
    expect(await findStripeRelayerPull(fakeRpc({ sender: FUNDER }).rpc, PAYOUT_TX, AMOUNT)).toBeNull()
    expect(await findStripeRelayerPull(fakeRpc({ contract: '0x' + 'ab'.repeat(20) }).rpc, PAYOUT_TX, AMOUNT)).toBeNull()
    expect(await findStripeRelayerPull(fakeRpc({ amount: 31430000n }).rpc, PAYOUT_TX, AMOUNT)).toBeNull()
    expect(await findStripeRelayerPull(fakeRpc({ status: '0x0' }).rpc, PAYOUT_TX, AMOUNT)).toBeNull()
    expect(await findStripeRelayerPull(fakeRpc({ payoutLogs: [] }).rpc, PAYOUT_TX, AMOUNT)).toBeNull()
    expect(await findStripeRelayerPull(fakeRpc({ payoutLogs: [transferLog(FUNDER, 1n, PAYOUT_TX), transferLog('0x' + 'cd'.repeat(20), 2n, PAYOUT_TX)] }).rpc, PAYOUT_TX, AMOUNT)).toBeNull()
    expect(await findStripeRelayerPull(async () => { throw new Error('down') }, PAYOUT_TX, AMOUNT)).toBeNull()
    expect(await findStripeRelayerPull(fakeRpc().rpc, 'not-a-hash', AMOUNT)).toBeNull()
  })
  it('needs exactly one pull, strictly after the payout', async () => {
    const other = '0x' + '44'.repeat(32)
    expect(await findStripeRelayerPull(fakeRpc({ windowLogs: [transferLog(FUNDER, AMOUNT, PULL_TX), transferLog(FUNDER, AMOUNT, other)] }).rpc, PAYOUT_TX, AMOUNT)).toBeNull()
    expect(await findStripeRelayerPull(fakeRpc({ windowLogs: [transferLog(FUNDER, AMOUNT, PULL_TX, PAYOUT_BLOCK, 3)] }).rpc, PAYOUT_TX, AMOUNT)).toBeNull()
    expect(await findStripeRelayerPull(fakeRpc({ windowLogs: [transferLog(FUNDER, AMOUNT, PULL_TX, PAYOUT_BLOCK, 9)] }).rpc, PAYOUT_TX, AMOUNT)).toBe(PULL_TX)
  })
  it('a similar-size payout to the funder next to this one makes the pull unattributable (codex P1)', async () => {
    const sibling = (amount: bigint, block: number) => transferLog(FUNDER, amount, '0x' + '55'.repeat(32), block, 1)
    expect(await findStripeRelayerPull(fakeRpc({ inboundLogs: [sibling(31760000n, PAYOUT_BLOCK - 120)] }).rpc, PAYOUT_TX, AMOUNT)).toBeNull()   // same amount, 4 min earlier
    expect(await findStripeRelayerPull(fakeRpc({ inboundLogs: [sibling(31300000n, PAYOUT_BLOCK + 200)] }).rpc, PAYOUT_TX, AMOUNT)).toBeNull()   // within 2%, later
    expect(await findStripeRelayerPull(fakeRpc({ inboundLogs: [sibling(5800000n, PAYOUT_BLOCK + 10)] }).rpc, PAYOUT_TX, AMOUNT)).toBe(PULL_TX)  // different size: fine
    expect(await findStripeRelayerPull(fakeRpc({ inboundLogs: [sibling(31760000n, PAYOUT_BLOCK + 301)] }).rpc, PAYOUT_TX, AMOUNT)).toBe(PULL_TX) // outside the window
  })
  it('parseAtomic is defensive', () => {
    expect(parseAtomic('31440000')).toBe(31440000n); expect(parseAtomic('0')).toBeNull(); expect(parseAtomic('abc')).toBeNull(); expect(parseAtomic(null)).toBeNull(); expect(parseAtomic('1e6')).toBeNull()
  })
  it('makeBaseRpc falls through endpoints that error and redacts nothing into the result', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(url)
      if (seen.length === 1) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'eth_getLogs is limited to 0 - 50 blocks range' } }), { status: 200 })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await makeBaseRpc('https://paid.example/v2/secret', fetchImpl)('eth_chainId', [])).toBe('0x1')
    expect(seen.length).toBe(2)
  })
})

const KEY = 'cpis_1TESTonchainSettle00000001'
const ORDER = `stripe_crypto_${KEY}`
const ROZO_ID = '00000000-0000-4000-8000-000000000001'

async function seed(env: Env, status: string, overrides: Record<string, unknown> = {}, key = KEY, rozoId = ROZO_ID) {
  await seedStripeRecord(env, { invoiceKey: key, merchantAccount: 'acct_1TESTonchain', invoiceAmountAtomic: AMOUNT.toString(), invoiceCurrency: 'usdc', lockFingerprint: 'fp', stripeUrl: 'https://crypto.stripe.com/pay/CDMx' + key, rozoPaymentId: rozoId })
  const raw = await casRead(env, stripeKvKey(key))
  const rec = JSON.parse(raw.value!)
  Object.assign(rec, { status, events: [{ kind: 'payment_payin_completed', at: new Date(T0.getTime() - 10_000).toISOString() }, { kind: 'payment_payout_completed', at: T0.toISOString() }, { kind: 'stripe_confirm_submitted', at: new Date(T0.getTime() + 4_000).toISOString() }], ...overrides })
  await (env as any).ATOMIC_STORE.get(null).fetch(new Request('http://do/commit', { method: 'POST', body: JSON.stringify({ key: stripeKvKey(key), expectedVersion: raw.version, op: 'set', value: JSON.stringify(rec) }) }))
}
const load = async (env: Env, key = KEY) => JSON.parse((await casRead(env, stripeKvKey(key))).value!)
const payment = async () => ({ id: ROZO_ID, destination: { txHash: PAYOUT_TX, amount: '31.76', confirmedAt: T0.toISOString() } })

describe('settleManualReviewFromChain', () => {
  it('manual_review → paid with the pull tx as evidence, through the manual-resolution path', async () => {
    const env = makeEnv(); await seed(env, 'manual_review')
    const now = new Date(T0.getTime() + 3600_000)
    const out = await settleManualReviewFromChain(env, KEY, now, { rpc: fakeRpc().rpc, fetchPayment: payment })
    expect(out).toEqual({ checked: true, txHash: PULL_TX, transition: 'paid' })
    const rec = await load(env)
    expect(rec.status).toBe('paid'); expect(rec.paidAt).toBe(now.toISOString())
    expect(rec.manualResolution.resolvedBy).toBe(ONCHAIN_RESOLVED_BY); expect(rec.manualResolution.txHash).toBe(PULL_TX)
    expect(rec.manualResolution.evidence).not.toContain('crypto.stripe.com')
    expect(rec.providerResult.blockchainTxId).toBe(PULL_TX)
    expect(rec.events.at(-1).kind).toBe('manual_review_resolved_paid')
  })
  it('stays manual_review when there is no pull, and does not re-read the chain for 24h', async () => {
    const env = makeEnv(); await seed(env, 'manual_review')
    const { rpc, calls } = fakeRpc({ sender: FUNDER })
    const now = new Date(T0.getTime() + 3600_000)
    expect(await settleManualReviewFromChain(env, KEY, now, { rpc, fetchPayment: payment })).toEqual({ checked: true, txHash: null, transition: null })
    expect((await load(env)).status).toBe('manual_review')
    const before = calls.length
    expect(await settleManualReviewFromChain(env, KEY, new Date(now.getTime() + ONCHAIN_RECHECK_MS - 1), { rpc, fetchPayment: payment })).toEqual({ checked: false, reason: 'throttled' })
    expect(calls.length).toBe(before)
    expect((await settleManualReviewFromChain(env, KEY, new Date(now.getTime() + ONCHAIN_RECHECK_MS + 1), { rpc, fetchPayment: payment })).checked).toBe(true)
  })
  it.each(['paid', 'provider_paying', 'failed_provider', 'payout_seen'])('leaves %s alone', async (status) => {
    const env = makeEnv(); await seed(env, status)
    expect(await settleManualReviewFromChain(env, KEY, new Date(), { rpc: fakeRpc().rpc, fetchPayment: payment })).toEqual({ checked: false, reason: 'not_manual_review' })
    expect((await load(env)).status).toBe(status)
  })
  it('needs the intents payout tx; never touches the chain without it', async () => {
    const env = makeEnv(); await seed(env, 'manual_review')
    const { rpc, calls } = fakeRpc()
    expect(await settleManualReviewFromChain(env, KEY, new Date(), { rpc, fetchPayment: async () => ({ destination: null }) })).toEqual({ checked: false, reason: 'no_payout_tx' })
    expect(calls.length).toBe(0)
    expect((await load(env)).status).toBe('manual_review')
  })
  it('a malformed stored amount is skipped, not thrown, and does not abort the batch (codex P2)', async () => {
    const env = makeEnv(); await seed(env, 'manual_review')
    await seed(env, 'manual_review', { invoiceAmountAtomic: 'not-a-number' }, 'cpis_1TESTonchainSettle00000002', '00000000-0000-4000-8000-000000000002')
    const res = await sweepManualReviewOnchain(env, new Date(T0.getTime() + 3600_000), { rpc: fakeRpc().rpc, fetchPayment: payment })
    expect(res.manualReview).toBe(2); expect(res.checked).toBe(1)
    expect((await load(env)).status).toBe('paid')
    expect((await load(env, 'cpis_1TESTonchainSettle00000002')).status).toBe('manual_review')
  })
  it('uncheckable records never consume the per-run quota (codex P2)', async () => {
    const env = makeEnv()
    for (let i = 0; i < 6; i++) await seed(env, 'manual_review', { invoiceAmountAtomic: null }, `cpis_1TESTnoamount000000000${i}`, `00000000-0000-4000-8000-00000000001${i}`)
    await seed(env, 'manual_review')
    const { rpc } = fakeRpc()
    const res = await sweepManualReviewOnchain(env, new Date(T0.getTime() + 3600_000), { rpc, fetchPayment: payment })
    expect(res.manualReview).toBe(7); expect(res.checked).toBe(1)
    expect(res.transitions).toEqual([expect.stringMatching(/:paid$/)])
    expect((await load(env)).status).toBe('paid')
  })
})
