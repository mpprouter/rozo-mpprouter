/**
 * `PlaygroundLedger` money semantics: deposit caps, the global credit ceiling,
 * intent rate limiting, and the reserve → commit/release lifecycle.
 *
 * These tests exercise the REAL Durable Object class over in-memory storage
 * (see `helpers/playground-ledger-mock.ts`), so the arithmetic under test is
 * the arithmetic that runs in production.
 *
 * Fixture addresses are randomly generated Stellar public keys, valid StrKey
 * (the routes now enforce the CRC16 checksum) but with no private key retained
 * and no funds — never a real or blacklisted account.
 */

import { describe, expect, it } from 'vitest'
import type { Env } from '../src/index'
import { formatUsd, formatUsdc7, parseAtomic, parseUsd } from '../src/playground/amount'
import {
  commit,
  createIntent,
  globalCapAtomic,
  openIntent,
  readAccount,
  readTotals,
  release,
  reserve,
} from '../src/playground/ledger-client'
import { INTENT_RATE_PER_HOUR } from '../src/playground/models'
import { RESERVED_LEASE_MS } from '../src/playground/ledger-do'
import {
  makePlaygroundLedgerMock,
  makePlaygroundLedgerMockWithControls,
} from './helpers/playground-ledger-mock'

const ALICE = 'GA6SKSJLJ3E33KKDNB3UDBRIECIBQKGYLGXLCBTXNQ7WWJ27BMDUH6JW'
const BOB = 'GCO6S4R5NIFYKXTAMLLLHIMK2VXEYCEZS3JCPWENX3525WSAA7LNUMHH'
const ROUTER = 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV'
const TX_A = 'a'.repeat(64)
const TX_B = 'b'.repeat(64)

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PLAYGROUND_LEDGER: makePlaygroundLedgerMock(),
    ...overrides,
  } as unknown as Env
}

let counter = 0
function nextId(): string {
  counter += 1
  return `intent-${counter}`
}

async function mintIntent(
  env: Env,
  args: { account?: string; usd?: string; now?: number; memo?: string } = {},
) {
  const now = args.now ?? Date.UTC(2026, 7, 12, 10, 0, 0)
  return createIntent(env, {
    intentId: nextId(),
    account: args.account ?? ALICE,
    amountAtomic: parseUsd(args.usd ?? '1'),
    memo: args.memo ?? `pg-${nextId()}`,
    destination: ROUTER,
    now,
    expiresAt: now + 30 * 60 * 1000,
  })
}

/** Mint an intent and immediately credit it, returning the balance. */
async function deposit(
  env: Env,
  args: { account?: string; usd?: string; txHash?: string; opIndex?: number } = {},
) {
  const now = Date.UTC(2026, 7, 12, 10, 0, 0)
  const intent = await mintIntent(env, args)
  if (!intent.ok) throw new Error(`intent failed: ${intent.code}`)
  const opened = await openIntent(env, {
    intentId: intent.value.intent_id,
    txHash: args.txHash ?? TX_A,
    opIndex: args.opIndex ?? 0,
    now,
    confirmedAt: now,
    sessionJti: 'jti-1',
    sessionExp: Math.floor(now / 1000) + 3600,
  })
  return { intent: intent.value, opened }
}

describe('amount arithmetic', () => {
  it('parses and formats without floating point loss', () => {
    expect(parseUsd('1')).toBe(10_000_000n)
    expect(parseUsd('0.1')).toBe(1_000_000n)
    expect(parseUsd('0.001')).toBe(10_000n)
    expect(parseUsd('0.0000001')).toBe(1n)
    expect(formatUsdc7(10_000_000n)).toBe('1.0000000')
    expect(formatUsd(parseUsd('0.02'))).toBe('0.02')
    expect(formatUsd(parseUsd('1'))).toBe('1.00')
  })

  it('refuses precision it cannot represent rather than truncating to zero', () => {
    expect(() => parseUsd('0.00000001')).toThrow(RangeError)
    expect(() => parseUsd('1e-3')).toThrow(RangeError)
    expect(() => parseUsd('abc')).toThrow(RangeError)
  })
})

describe('global cap resolution', () => {
  it('falls back to the default rather than to "unlimited" on a bad value', () => {
    expect(globalCapAtomic(makeEnv({ PLAYGROUND_GLOBAL_CAP_USD: '50' } as any))).toBe(parseUsd('50'))
    expect(globalCapAtomic(makeEnv({ PLAYGROUND_GLOBAL_CAP_USD: 'oops' } as any))).toBe(
      parseUsd('200'),
    )
    expect(globalCapAtomic(makeEnv({ PLAYGROUND_GLOBAL_CAP_USD: '0' } as any))).toBe(parseUsd('200'))
    expect(globalCapAtomic(makeEnv())).toBe(parseUsd('200'))
  })
})

describe('deposit intents', () => {
  it('mints an intent and credits the balance when opened', async () => {
    const env = makeEnv()
    const { opened } = await deposit(env, { usd: '1' })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.value.balance).toBe(parseUsd('1').toString())
    expect(opened.value.replayed).toBe(false)
    expect(opened.value.intent.status).toBe('consumed')
  })

  /**
   * Fill an account's daily deposit allowance with $1 deposits.
   *
   * One deposit per UTC hour, deliberately: the intent rate limit is a 6/hour
   * fixed window, so ten intents in one hour would be refused by the RATE
   * LIMIT before the daily cap could ever be reached. Spreading them out is
   * what isolates the cap under test — and the fact that this was necessary
   * is itself evidence the two windows are independent.
   */
  async function fillDailyCap(env: Env, account: string, txHash: string) {
    for (let hour = 0; hour < 10; hour++) {
      const now = Date.UTC(2026, 7, 12, hour, 0, 0)
      const r = await createIntent(env, {
        intentId: nextId(),
        account,
        amountAtomic: parseUsd('1'),
        memo: `pg-${nextId()}`,
        destination: ROUTER,
        now,
        expiresAt: now + 30 * 60 * 1000,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const opened = await openIntent(env, {
        intentId: r.value.intent_id,
        txHash,
        opIndex: hour,
        now,
        confirmedAt: now,
        sessionJti: 'j',
        sessionExp: 1,
      })
      expect(opened.ok).toBe(true)
    }
  }

  it('enforces the $10/day per-account deposit cap', async () => {
    const env = makeEnv()
    await fillDailyCap(env, ALICE, 'c'.repeat(64))

    const over = await mintIntent(env, { usd: '1', now: Date.UTC(2026, 7, 12, 11, 0, 0) })
    expect(over.ok).toBe(false)
    if (over.ok) return
    expect(over.code).toBe('deposit_cap_exceeded')

    // The cap is daily: the next UTC day is a fresh allowance.
    const nextDay = await mintIntent(env, { usd: '1', now: Date.UTC(2026, 7, 13, 0, 0, 0) })
    expect(nextDay.ok).toBe(true)
  })

  it('caps are per account, not global', async () => {
    const env = makeEnv()
    await fillDailyCap(env, ALICE, 'd'.repeat(64))
    const bob = await mintIntent(env, {
      account: BOB,
      usd: '1',
      now: Date.UTC(2026, 7, 12, 11, 0, 0),
    })
    expect(bob.ok).toBe(true)
  })

  it('refuses intents once the global outstanding-credit cap is reached', async () => {
    // A $1 ceiling: the first $1 deposit fills it, the next intent is refused.
    const env = makeEnv({ PLAYGROUND_GLOBAL_CAP_USD: '1' } as any)
    const { opened } = await deposit(env, { usd: '1' })
    expect(opened.ok).toBe(true)
    const next = await mintIntent(env, { account: BOB, usd: '1' })
    expect(next.ok).toBe(false)
    if (next.ok) return
    expect(next.code).toBe('global_cap_exceeded')
  })

  it('rate-limits intent creation per account per hour', async () => {
    const env = makeEnv()
    const now = Date.UTC(2026, 7, 12, 10, 0, 0)
    for (let i = 0; i < INTENT_RATE_PER_HOUR; i++) {
      const r = await mintIntent(env, { usd: '0.1', now })
      expect(r.ok).toBe(true)
    }
    const over = await mintIntent(env, { usd: '0.1', now })
    expect(over.ok).toBe(false)
    if (over.ok) return
    expect(over.code).toBe('rate_limited')

    // The window is fixed and hourly — the next hour is a fresh allowance.
    const nextHour = await mintIntent(env, { usd: '0.1', now: now + 3_600_000 })
    expect(nextHour.ok).toBe(true)
  })

  it('is idempotent when the same intent and payment are re-submitted', async () => {
    const env = makeEnv()
    const { intent, opened } = await deposit(env, { usd: '1' })
    expect(opened.ok).toBe(true)

    const again = await openIntent(env, {
      intentId: intent.intent_id,
      txHash: TX_A,
      opIndex: 0,
      now: Date.now(),
      confirmedAt: Date.now(),
      sessionJti: 'different-jti',
      sessionExp: 999,
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.replayed).toBe(true)
    // Crucially: the balance did NOT double.
    expect(again.value.balance).toBe(parseUsd('1').toString())
    // And the original session identity is preserved, not re-minted.
    expect(again.value.intent.session_jti).toBe('jti-1')
  })

  it('refuses to credit the same (tx_hash, op_index) against a second intent', async () => {
    const env = makeEnv()
    await deposit(env, { usd: '1', txHash: TX_A, opIndex: 0 })
    const second = await mintIntent(env, { usd: '1' })
    if (!second.ok) return
    const replay = await openIntent(env, {
      intentId: second.value.intent_id,
      txHash: TX_A,
      opIndex: 0,
      now: Date.now(),
      confirmedAt: Date.now(),
      sessionJti: 'j2',
      sessionExp: 1,
    })
    expect(replay.ok).toBe(false)
    if (replay.ok) return
    expect(replay.code).toBe('payment_already_claimed')
  })

  it('allows distinct operations of the same multi-op transaction to fund distinct intents', async () => {
    const env = makeEnv()
    const first = await deposit(env, { usd: '1', txHash: TX_B, opIndex: 0 })
    expect(first.opened.ok).toBe(true)
    const second = await deposit(env, { usd: '1', txHash: TX_B, opIndex: 3 })
    expect(second.opened.ok).toBe(true)
    if (!second.opened.ok) return
    expect(second.opened.value.balance).toBe(parseUsd('2').toString())
  })

  it('refuses to reuse a spent intent with a different payment', async () => {
    const env = makeEnv()
    const { intent } = await deposit(env, { usd: '1', txHash: TX_A, opIndex: 0 })
    const reuse = await openIntent(env, {
      intentId: intent.intent_id,
      txHash: TX_B,
      opIndex: 0,
      now: Date.now(),
      confirmedAt: Date.now(),
      sessionJti: 'j',
      sessionExp: 1,
    })
    expect(reuse.ok).toBe(false)
    if (reuse.ok) return
    expect(reuse.code).toBe('intent_already_used')
  })

  it('refuses an expired intent', async () => {
    const env = makeEnv()
    const now = Date.UTC(2026, 7, 12, 10, 0, 0)
    const intent = await mintIntent(env, { usd: '1', now })
    if (!intent.ok) return
    // Expiry is judged by the ON-CHAIN confirmation time, not by when the
    // claim arrives: a deposit that confirmed after the window is late.
    const late = await openIntent(env, {
      intentId: intent.value.intent_id,
      txHash: TX_A,
      opIndex: 0,
      now: now + 60 * 60 * 1000,
      confirmedAt: now + 60 * 60 * 1000,
      sessionJti: 'j',
      sessionExp: 1,
    })
    expect(late.ok).toBe(false)
    if (late.ok) return
    expect(late.code).toBe('intent_expired')
  })

  it('credits a deposit confirmed inside the window but claimed long after', async () => {
    // The bug this locks out: judging expiry by Date.now() at claim time would
    // throw away a deposit that settled on-chain while the intent was valid.
    const env = makeEnv()
    const now = Date.UTC(2026, 7, 12, 10, 0, 0)
    const intent = await mintIntent(env, { usd: '1', now })
    if (!intent.ok) return
    const claimed = await openIntent(env, {
      intentId: intent.value.intent_id,
      txHash: TX_A,
      opIndex: 0,
      // Claimed a day late...
      now: now + 24 * 60 * 60 * 1000,
      // ...but confirmed on-chain one minute after the intent was minted.
      confirmedAt: now + 60 * 1000,
      sessionJti: 'j',
      sessionExp: 1,
    })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(claimed.value.balance).toBe(parseUsd('1').toString())
  })

  it('reports an unknown intent rather than crediting anything', async () => {
    const env = makeEnv()
    const missing = await openIntent(env, {
      intentId: 'nope',
      txHash: TX_A,
      opIndex: 0,
      now: Date.now(),
      confirmedAt: Date.now(),
      sessionJti: 'j',
      sessionExp: 1,
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.code).toBe('intent_not_found')
  })
})

describe('reserve / commit / release', () => {
  const now = Date.UTC(2026, 7, 12, 11, 0, 0)

  it('holds the maximum price and refunds the unspent remainder on commit', async () => {
    const env = makeEnv()
    await deposit(env, { usd: '1' })

    const held = await reserve(env, {
      callId: 'call-1',
      account: ALICE,
      chip: 'chat',
      model: 'llama-3.1-8b-instant',
      maxPriceAtomic: parseUsd('0.10'),
      now,
    })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    expect(held.value.ok).toBe(true)
    // The full max price is withheld while the call is in flight.
    expect(held.value.balance).toBe(parseUsd('0.90').toString())

    const settled = await commit(env, 'call-1', parseUsd('0.02'))
    expect(settled.ok).toBe(true)
    if (!settled.ok) return
    expect(settled.value.call.status).toBe('committed')
    expect(settled.value.call.charged).toBe(parseUsd('0.02').toString())
    expect(settled.value.balance).toBe(parseUsd('0.98').toString())
  })

  it('returns the entire hold on release, so a failed call is never billed', async () => {
    const env = makeEnv()
    await deposit(env, { usd: '1' })
    await reserve(env, {
      callId: 'call-2',
      account: ALICE,
      chip: 'chat',
      maxPriceAtomic: parseUsd('0.10'),
      now,
    })
    const released = await release(env, 'call-2', 'upstream_error')
    expect(released.ok).toBe(true)
    if (!released.ok) return
    expect(released.value.call.status).toBe('released')
    expect(released.value.call.charged).toBe('0')
    expect(released.value.balance).toBe(parseUsd('1').toString())
  })

  it('never charges twice for a retried call_id', async () => {
    const env = makeEnv()
    await deposit(env, { usd: '1' })
    await reserve(env, {
      callId: 'call-3',
      account: ALICE,
      chip: 'chat',
      maxPriceAtomic: parseUsd('0.02'),
      now,
    })
    await commit(env, 'call-3', parseUsd('0.02'))

    // The retry must be recognised as a duplicate and must not take a second hold.
    const retry = await reserve(env, {
      callId: 'call-3',
      account: ALICE,
      chip: 'chat',
      maxPriceAtomic: parseUsd('0.02'),
      now,
    })
    expect(retry.ok).toBe(true)
    if (!retry.ok) return
    expect(retry.value.duplicate).toBe(true)
    expect(retry.value.call?.status).toBe('committed')
    expect(retry.value.balance).toBe(parseUsd('0.98').toString())

    // Re-settling is a reported no-op, not a second charge.
    const resettle = await commit(env, 'call-3', parseUsd('0.02'))
    expect(resettle.ok).toBe(true)
    if (!resettle.ok) return
    expect(resettle.value.already_settled).toBe(true)
    expect(resettle.value.balance).toBe(parseUsd('0.98').toString())
  })

  it('refuses a call the balance cannot cover, and says how much is left', async () => {
    const env = makeEnv()
    await deposit(env, { usd: '0.1' })
    const held = await reserve(env, {
      callId: 'call-4',
      account: ALICE,
      chip: 'chat',
      maxPriceAtomic: parseUsd('1'),
      now,
    })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    expect(held.value.ok).toBe(false)
    expect(held.value.code).toBe('insufficient_balance')
    expect(held.value.balance).toBe(parseUsd('0.1').toString())
    // The refused call left no trace on the balance.
    expect(held.value.call).toBeNull()
  })

  it('clamps an over-large commit to the reserved maximum', async () => {
    const env = makeEnv()
    await deposit(env, { usd: '1' })
    await reserve(env, {
      callId: 'call-5',
      account: ALICE,
      chip: 'chat',
      maxPriceAtomic: parseUsd('0.02'),
      now,
    })
    // A pricing bug asking for $5 must not overdraw a $1 session.
    const settled = await commit(env, 'call-5', parseUsd('5'))
    expect(settled.ok).toBe(true)
    if (!settled.ok) return
    expect(settled.value.call.charged).toBe(parseUsd('0.02').toString())
    expect(settled.value.balance).toBe(parseUsd('0.98').toString())
  })

  it('reports an unknown call_id rather than silently succeeding', async () => {
    const env = makeEnv()
    const settled = await commit(env, 'never-reserved', parseUsd('0.02'))
    expect(settled.ok).toBe(false)
    if (settled.ok) return
    expect(settled.code).toBe('call_not_found')
  })

  it('records call history newest-first for the session view', async () => {
    const env = makeEnv()
    await deposit(env, { usd: '1' })
    for (const id of ['h1', 'h2', 'h3']) {
      await reserve(env, {
        callId: id,
        account: ALICE,
        chip: 'chat',
        maxPriceAtomic: parseUsd('0.02'),
        now,
      })
      await commit(env, id, parseUsd('0.02'))
    }
    const account = await readAccount(env, ALICE)
    expect(account.ok).toBe(true)
    if (!account.ok) return
    expect(account.value.calls.map(c => c.call_id)).toEqual(['h3', 'h2', 'h1'])
    expect(account.value.balance).toBe(parseUsd('0.94').toString())
  })
})

describe('solvency totals', () => {
  it('keeps the incremental counters consistent with a full rescan', async () => {
    const env = makeEnv()
    await deposit(env, { usd: '1', txHash: TX_A, opIndex: 0 })
    await deposit(env, { account: BOB, usd: '1', txHash: TX_B, opIndex: 0 })

    await reserve(env, {
      callId: 't1',
      account: ALICE,
      chip: 'chat',
      maxPriceAtomic: parseUsd('0.10'),
      now: Date.now(),
    })
    await commit(env, 't1', parseUsd('0.02'))

    // A still-in-flight call: its hold is out of the balance but not spent.
    await reserve(env, {
      callId: 't2',
      account: BOB,
      chip: 'chat',
      maxPriceAtomic: parseUsd('0.10'),
      now: Date.now(),
    })

    const totals = await readTotals(env)
    expect(totals.ok).toBe(true)
    if (!totals.ok) return

    expect(totals.value.credited).toBe(parseUsd('2').toString())
    expect(totals.value.committed).toBe(parseUsd('0.02').toString())

    // outstanding == credited - committed, and it must equal what a full
    // rescan of balances plus in-flight holds says.
    const rescan = parseAtomic(totals.value.balances_sum) + parseAtomic(totals.value.holds_sum)
    expect(parseAtomic(totals.value.outstanding)).toBe(rescan)
    expect(parseAtomic(totals.value.outstanding)).toBe(parseUsd('1.98'))

    expect(totals.value.consumed_deposits).toHaveLength(2)
  })
})

describe('caps are enforced at CREDIT MINT, not just at intent creation (P0-1)', () => {
  /**
   * The attack this closes: the checks at intent creation hold nothing, so an
   * attacker can mint many intents while each individually looks under the
   * cap, pay them all, and then open them all. Enforcement has to happen where
   * credit is actually created.
   */
  it('refuses to credit an open that would breach the per-account daily cap', async () => {
    const env = makeEnv()
    // Mint ELEVEN intents up front, spaced to dodge the hourly rate limit.
    // Every one passes the advisory check because nothing is credited yet.
    const ids: string[] = []
    for (let hour = 0; hour < 11; hour++) {
      const now = Date.UTC(2026, 7, 12, hour, 0, 0)
      const r = await createIntent(env, {
        intentId: nextId(),
        account: ALICE,
        amountAtomic: parseUsd('1'),
        memo: `pg-${nextId()}`,
        destination: ROUTER,
        now,
        expiresAt: now + 24 * 60 * 60 * 1000,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.push(r.value.intent_id)
    }

    // Now open all eleven. The first ten fit the $10/day cap; the eleventh
    // must be refused rather than silently credited.
    const at = Date.UTC(2026, 7, 12, 12, 0, 0)
    for (let i = 0; i < 10; i++) {
      const opened = await openIntent(env, {
        intentId: ids[i],
        txHash: 'e'.repeat(64),
        opIndex: i,
        now: at,
        confirmedAt: at,
        sessionJti: 'j',
        sessionExp: 1,
      })
      expect(opened.ok).toBe(true)
    }

    const over = await openIntent(env, {
      intentId: ids[10],
      txHash: 'e'.repeat(64),
      opIndex: 10,
      now: at,
      confirmedAt: at,
      sessionJti: 'j',
      sessionExp: 1,
    })
    expect(over.ok).toBe(false)
    if (over.ok) return
    expect(over.code).toBe('deposit_exceeds_cap')
    expect(over.detail?.reason).toBe('deposit_cap_exceeded')

    // The balance stopped at the cap — the eleventh deposit was NOT credited.
    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.balance).toBe(parseUsd('10').toString())
  })

  it('refuses to credit an open that would breach the global ceiling', async () => {
    const env = makeEnv({ PLAYGROUND_GLOBAL_CAP_USD: '1' } as any)
    const now = Date.UTC(2026, 7, 12, 10, 0, 0)
    // Two intents minted while the ledger is empty: both pass the advisory check.
    const a = await mintIntent(env, { usd: '1', now })
    const b = await mintIntent(env, { account: BOB, usd: '1', now })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    const first = await openIntent(env, {
      intentId: a.value.intent_id,
      txHash: TX_A,
      opIndex: 0,
      now,
      confirmedAt: now,
      sessionJti: 'j',
      sessionExp: 1,
    })
    expect(first.ok).toBe(true)

    const second = await openIntent(env, {
      intentId: b.value.intent_id,
      txHash: TX_B,
      opIndex: 0,
      now,
      confirmedAt: now,
      sessionJti: 'j',
      sessionExp: 1,
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe('deposit_exceeds_cap')
    expect(second.detail?.reason).toBe('global_cap_exceeded')
  })

  it('records an over-cap deposit as terminal and idempotent, never silently credited', async () => {
    const env = makeEnv({ PLAYGROUND_GLOBAL_CAP_USD: '1' } as any)
    const now = Date.UTC(2026, 7, 12, 10, 0, 0)
    await deposit(env, { usd: '1' })
    const b = await mintIntent(env, { account: BOB, usd: '1', now })
    if (!b.ok) return

    const args = {
      intentId: b.value.intent_id,
      txHash: TX_B,
      opIndex: 0,
      now,
      confirmedAt: now,
      sessionJti: 'j',
      sessionExp: 1,
    }
    const first = await openIntent(env, args)
    expect(first.ok).toBe(false)

    // Re-submitting reports the same terminal state rather than re-running the
    // cap check (which could later pass and credit a deposit support may
    // already have refunded).
    const again = await openIntent(env, args)
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.code).toBe('deposit_exceeds_cap')

    const account = await readAccount(env, BOB)
    if (!account.ok) return
    expect(account.value.balance).toBe('0')
  })

  it('caps the number of unclaimed intents an account can accumulate', async () => {
    // Bounds total DO storage growth, not just its rate.
    const env = makeEnv()
    let refusal: string | undefined
    for (let hour = 0; hour < 40; hour++) {
      const now = Date.UTC(2026, 7, 12, 0, 0, 0) + hour * 3_600_000
      const r = await createIntent(env, {
        intentId: nextId(),
        account: ALICE,
        amountAtomic: parseUsd('0.1'),
        memo: `pg-${nextId()}`,
        destination: ROUTER,
        now,
        expiresAt: now + 1_000,
      })
      if (!r.ok) {
        refusal = r.code
        break
      }
    }
    expect(refusal).toBe('too_many_open_intents')
  })
})

describe('stale reserved-call reaper (P1)', () => {
  /**
   * A call is stranded when the request dies between taking the hold and
   * settling it — most often a commit that failed AFTER the upstream had
   * already delivered. Without a reaper the hold is frozen forever AND the
   * `call_id` retry short-circuit keeps returning `duplicate` for a call that
   * never produced a result.
   */
  it('commits calls stranded in reserved past the lease, and flags them for support', async () => {
    const mock = makePlaygroundLedgerMockWithControls()
    const env = { PLAYGROUND_LEDGER: mock.namespace } as unknown as Env
    await deposit(env, { usd: '1' })

    const staleAt = Date.now() - RESERVED_LEASE_MS - 1000
    await reserve(env, {
      callId: 'stranded',
      account: ALICE,
      chip: 'chat',
      maxPriceAtomic: parseUsd('0.02'),
      now: staleAt,
    })

    await mock.runAlarm()

    const account = await readAccount(env, ALICE)
    expect(account.ok).toBe(true)
    if (!account.ok) return
    const call = account.value.calls.find(c => c.call_id === 'stranded')!
    // Committed, not released: the reserve->settle window brackets the paid
    // upstream call, so a stranded call most likely cost the router money.
    expect(call.status).toBe('committed')
    expect(call.charged).toBe(parseUsd('0.02').toString())
    expect(call.reaped).toBe(true)
    // The hold is gone from the balance exactly once.
    expect(account.value.balance).toBe(parseUsd('0.98').toString())
  })

  it('leaves healthy in-flight calls alone', async () => {
    const mock = makePlaygroundLedgerMockWithControls()
    const env = { PLAYGROUND_LEDGER: mock.namespace } as unknown as Env
    await deposit(env, { usd: '1' })
    await reserve(env, {
      callId: 'in-flight',
      account: ALICE,
      chip: 'chat',
      maxPriceAtomic: parseUsd('0.02'),
      now: Date.now(),
    })

    await mock.runAlarm()

    const account = await readAccount(env, ALICE)
    if (!account.ok) return
    expect(account.value.calls[0].status).toBe('reserved')
  })

  it('arms an alarm when a hold is taken', async () => {
    const mock = makePlaygroundLedgerMockWithControls()
    const env = { PLAYGROUND_LEDGER: mock.namespace } as unknown as Env
    await deposit(env, { usd: '1' })
    expect(mock.getAlarm()).toBeNull()
    await reserve(env, {
      callId: 'arms-alarm',
      account: ALICE,
      chip: 'chat',
      maxPriceAtomic: parseUsd('0.02'),
      now: Date.now(),
    })
    expect(mock.getAlarm()).not.toBeNull()
  })

  it('keeps the ledger self-consistent after reaping', async () => {
    const mock = makePlaygroundLedgerMockWithControls()
    const env = { PLAYGROUND_LEDGER: mock.namespace } as unknown as Env
    await deposit(env, { usd: '1' })
    await reserve(env, {
      callId: 'stranded-2',
      account: ALICE,
      chip: 'chat',
      maxPriceAtomic: parseUsd('0.02'),
      now: Date.now() - RESERVED_LEASE_MS - 1,
    })
    await mock.runAlarm()

    const totals = await readTotals(env)
    if (!totals.ok) return
    expect(parseAtomic(totals.value.credited)).toBe(
      parseAtomic(totals.value.committed) +
        parseAtomic(totals.value.balances_sum) +
        parseAtomic(totals.value.holds_sum),
    )
  })
})
