/**
 * On-chain deposit verification (`src/playground/deposit.ts`).
 *
 * Every test here is a substitution attack: the caller supplies a `tx_hash`
 * and we must refuse to mint credit unless the chain agrees on ALL of memo,
 * destination, asset code, asset issuer, amount, and operation source. Each
 * check gets its own case, because any one of them silently passing is a way
 * to buy API calls for free.
 *
 * Horizon is stubbed. Fixture addresses are obviously-fake G-addresses.
 */

import { describe, expect, it } from 'vitest'
import { parseUsd } from '../src/playground/amount'
import {
  STELLAR_PUBNET_USDC_ISSUER,
  verifyDeposit,
} from '../src/playground/deposit'

const ROUTER = 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV'
const PAYER = 'GD42CKPIJSO5SKLTFU4WEO7MAUGJQ3EQM2FAAVMSVJCBQ4TOEX7RV4JF'
const STRANGER = 'GA3OIWUOYWSLWXUYE4JXWUPMKZX5ZIJ2WRXI3BBDMZKNLFREJO672NOH'
/** A worthless self-issued asset that also calls itself "USDC". */
const FAKE_ISSUER = 'GCFQWQC6NYQEPOX2Q2ITUZHYW3ZU6Y3KO6FEQWBENHH35YY5ZWAA3A3W'

const TX = 'a'.repeat(64)
const MEMO = 'pg-0123456789abcdef0123'

function goodPaymentOp(overrides: Record<string, unknown> = {}) {
  return {
    type: 'payment',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: STELLAR_PUBNET_USDC_ISSUER,
    from: PAYER,
    to: ROUTER,
    amount: '1.0000000',
    ...overrides,
  }
}

/** Build a fetch stub serving one transaction and its operation list. */
function stubHorizon(tx: Record<string, unknown>, ops: Record<string, unknown>[]) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/operations')) {
      return new Response(JSON.stringify({ _embedded: { records: ops } }), { status: 200 })
    }
    if (tx.__status === 404) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(tx), { status: 200 })
  }) as unknown as typeof fetch
}

function verify(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return verifyDeposit({
    horizonUrl: 'https://horizon.example',
    txHash: TX,
    memo: MEMO,
    destination: ROUTER,
    account: PAYER,
    amountAtomic: parseUsd('1'),
    fetchImpl,
    ...overrides,
  } as any)
}

const CLOSED_AT = '2026-08-12T10:00:00Z'
const GOOD_TX = { successful: true, memo_type: 'text', memo: MEMO, created_at: CLOSED_AT }

describe('verifyDeposit — happy path', () => {
  it('accepts a matching payment and returns its operation index', async () => {
    const result = await verify(stubHorizon(GOOD_TX, [goodPaymentOp()]))
    // confirmedAt is the LEDGER CLOSE TIME, which is what intent expiry is
    // judged against — not the moment the claim arrived.
    expect(result).toEqual({ ok: true, opIndex: 0, confirmedAt: Date.parse(CLOSED_AT) })
  })

  it('falls back to now when Horizon omits created_at, never to a permissive value', async () => {
    const before = Date.now()
    const result = await verify(
      stubHorizon({ successful: true, memo_type: 'text', memo: MEMO }, [goodPaymentOp()]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // "now" can only make the expiry check stricter than a real close time.
    expect(result.confirmedAt).toBeGreaterThanOrEqual(before)
  })

  it('finds the matching payment among other operations in a multi-op tx', async () => {
    const result = await verify(
      stubHorizon(GOOD_TX, [
        { type: 'manage_data' },
        goodPaymentOp({ to: STRANGER }),
        goodPaymentOp(),
      ]),
    )
    expect(result).toMatchObject({ ok: true, opIndex: 2 })
  })

  it('accepts an integer-formatted Horizon amount', async () => {
    const result = await verify(stubHorizon(GOOD_TX, [goodPaymentOp({ amount: '1' })]))
    expect(result.ok).toBe(true)
  })
})

describe('verifyDeposit — refusals', () => {
  it('refuses a failed transaction, even though it has a real hash', async () => {
    const result = await verify(stubHorizon({ ...GOOD_TX, successful: false }, [goodPaymentOp()]))
    expect(result).toMatchObject({ ok: false, reason: 'tx_failed' })
  })

  it('refuses a transaction whose memo is not the intent nonce', async () => {
    const result = await verify(stubHorizon({ ...GOOD_TX, memo: 'pg-somethingelse' }, [goodPaymentOp()]))
    expect(result).toMatchObject({ ok: false, reason: 'memo_mismatch' })
  })

  it('refuses a non-text memo that cannot carry our nonce', async () => {
    const result = await verify(
      stubHorizon({ successful: true, memo_type: 'hash', memo: MEMO }, [goodPaymentOp()]),
    )
    expect(result).toMatchObject({ ok: false, reason: 'memo_mismatch' })
  })

  it('refuses a payment sent to any other destination', async () => {
    const result = await verify(stubHorizon(GOOD_TX, [goodPaymentOp({ to: STRANGER })]))
    expect(result).toMatchObject({ ok: false, reason: 'no_matching_payment' })
  })

  it('refuses a "USDC" from an issuer that is not Circle', async () => {
    // The load-bearing check: anyone can issue an asset named USDC.
    const result = await verify(stubHorizon(GOOD_TX, [goodPaymentOp({ asset_issuer: FAKE_ISSUER })]))
    expect(result).toMatchObject({ ok: false, reason: 'no_matching_payment' })
  })

  it('refuses a different asset code from the right issuer', async () => {
    const result = await verify(stubHorizon(GOOD_TX, [goodPaymentOp({ asset_code: 'EURC' })]))
    expect(result).toMatchObject({ ok: false, reason: 'no_matching_payment' })
  })

  it('refuses a native XLM payment', async () => {
    const result = await verify(
      stubHorizon(GOOD_TX, [
        { type: 'payment', asset_type: 'native', from: PAYER, to: ROUTER, amount: '1.0000000' },
      ]),
    )
    expect(result).toMatchObject({ ok: false, reason: 'no_matching_payment' })
  })

  it('refuses an amount that is not exactly the intent amount', async () => {
    const under = await verify(stubHorizon(GOOD_TX, [goodPaymentOp({ amount: '0.9999999' })]))
    expect(under).toMatchObject({ ok: false, reason: 'no_matching_payment' })
    // Over-payment is refused too: the credited figure comes from the intent,
    // so a mismatch means the caller is claiming a different payment.
    const over = await verify(stubHorizon(GOOD_TX, [goodPaymentOp({ amount: '2.0000000' })]))
    expect(over).toMatchObject({ ok: false, reason: 'no_matching_payment' })
  })

  it("refuses to let one account claim someone else's payment", async () => {
    const result = await verify(
      stubHorizon(GOOD_TX, [goodPaymentOp({ from: STRANGER, source_account: STRANGER })]),
    )
    expect(result).toMatchObject({ ok: false, reason: 'no_matching_payment' })
  })

  it('honours an explicit operation source_account over `from`', async () => {
    const result = await verify(
      stubHorizon(GOOD_TX, [goodPaymentOp({ from: PAYER, source_account: STRANGER })]),
    )
    expect(result).toMatchObject({ ok: false, reason: 'no_matching_payment' })
  })

  it('refuses a transaction Horizon has never seen', async () => {
    const result = await verify(stubHorizon({ __status: 404 }, []))
    expect(result).toMatchObject({ ok: false, reason: 'tx_not_found' })
  })

  it('refuses a malformed hash without ever calling Horizon', async () => {
    let called = false
    const spy = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const result = await verifyDeposit({
      horizonUrl: 'https://horizon.example',
      txHash: '../../admin',
      memo: MEMO,
      destination: ROUTER,
      account: PAYER,
      amountAtomic: parseUsd('1'),
      fetchImpl: spy,
    })
    expect(result).toMatchObject({ ok: false, reason: 'tx_not_found' })
    expect(called).toBe(false)
  })

  it('reports a Horizon outage distinctly, so it is retried not rejected', async () => {
    const flaky = (async () => {
      throw new Error('connection reset')
    }) as unknown as typeof fetch
    const result = await verify(flaky)
    expect(result).toMatchObject({ ok: false, reason: 'horizon_unavailable' })
  })
})
