import { describe, it, expect } from 'vitest'
import {
  decide,
  checkFunderBalance,
  formatUsd,
  classifyBand,
  SAMPLE_INTERVAL_MS,
  UNREADABLE_ALERT_AFTER,
  type FunderWatchState,
} from './funder-balance-watch'

const ADDR = '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739'
const usd = (n: number) => BigInt(Math.round(n * 100)) * 10_000n

function st(p: Partial<FunderWatchState> = {}): FunderWatchState {
  return { band: 'ok', lastBalance: usd(400).toString(), lastSampleAt: 0, unreadableStreak: 0, unreadableAlerted: false, ...p }
}

function fakeKv() {
  const store = new Map<string, string>()
  return {
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace,
    store,
  }
}

const reader = (balance: bigint | null) => async () => ({ balance, rpcsTried: [{ url: 'https://rpc', ok: balance !== null }] })

describe('formatting and bands', () => {
  it('formats base units as dollars without rounding up', () => {
    expect(formatUsd(usd(433.16) + 6341n)).toBe('$433.16')
    expect(formatUsd(usd(1234.5))).toBe('$1,234.50')
  })
  it('classifies the P0/P1 bands', () => {
    expect(classifyBand(usd(49.99))).toBe('p0')
    expect(classifyBand(usd(50))).toBe('p1')
    expect(classifyBand(usd(99.99))).toBe('p1')
    expect(classifyBand(usd(100))).toBe('ok')
  })
})

describe('decide', () => {
  it('announces itself once on the first sample', () => {
    const d = decide({ ...st(), band: null, lastBalance: null }, usd(433.16), ADDR, 1)
    expect(d.messages).toHaveLength(1)
    expect(d.messages[0]).toContain('monitor online: $433.16')
  })

  it('is silent while the band is unchanged', () => {
    expect(decide(st(), usd(390), ADDR, 1).messages).toEqual([])
    expect(decide(st({ band: 'p1', lastBalance: usd(90).toString() }), usd(85), ADDR, 1).messages).toEqual([])
  })

  it('alerts on ok → p1 → p0 and on recovery', () => {
    expect(decide(st({ lastBalance: usd(120).toString() }), usd(95), ADDR, 1).messages[0]).toContain('P1')
    expect(decide(st({ band: 'p1', lastBalance: usd(60).toString() }), usd(45), ADDR, 1).messages[0]).toContain('🚨')
    expect(decide(st({ band: 'p0', lastBalance: usd(45).toString() }), usd(245), ADDR, 1).messages[0]).toContain('back to OK')
  })

  it('flags a >50% drop of at least $20, and not smaller ones', () => {
    const big = decide(st({ lastBalance: usd(1000).toString() }), usd(400), ADDR, 1).messages
    expect(big.some((m) => m.includes('dropped sharply'))).toBe(true)
    expect(decide(st({ lastBalance: usd(400).toString() }), usd(250), ADDR, 1).messages).toEqual([])
    expect(decide(st({ band: 'p0', lastBalance: usd(30).toString() }), usd(12), ADDR, 1).messages).toEqual([])
  })

  it('never treats an unreadable balance as low, and reports blindness once', () => {
    let s = st()
    const sent: string[] = []
    for (let i = 0; i < UNREADABLE_ALERT_AFTER + 3; i++) {
      const d = decide(s, null, ADDR, i)
      sent.push(...d.messages)
      s = d.nextState
    }
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('unreadable')
    expect(s.band).toBe('ok')
    // Recovery to the same band after an outage is silent.
    expect(decide(s, usd(399), ADDR, 99).messages).toEqual([])
  })
})

describe('checkFunderBalance', () => {
  it('samples at most once per interval and commits only when told to', async () => {
    const { kv, store } = fakeKv()
    const first = await checkFunderBalance({ kv, address: ADDR, now: 1_000_000_000, readBalance: reader(usd(433)) })
    expect(first?.messages[0]).toContain('online')
    expect(store.size).toBe(0) // not committed yet
    await first!.commit()

    const tooSoon = await checkFunderBalance({ kv, address: ADDR, now: 1_000_000_000 + 60_000, readBalance: reader(usd(10)) })
    expect(tooSoon).toBeNull()

    const later = await checkFunderBalance({ kv, address: ADDR, now: 1_000_000_000 + SAMPLE_INTERVAL_MS, readBalance: reader(usd(430)) })
    expect(later).toBeNull() // healthy, committed silently
    expect(JSON.parse(store.get('funder-balance:watch-state')!).lastBalance).toBe(usd(430).toString())
  })

  it('an uncommitted alert is re-sent on the next sample', async () => {
    const { kv } = fakeKv()
    await (await checkFunderBalance({ kv, address: ADDR, now: 1_000_000_000, readBalance: reader(usd(433)) }))!.commit()
    const a = await checkFunderBalance({ kv, address: ADDR, now: 1_000_000_000 + SAMPLE_INTERVAL_MS, readBalance: reader(usd(90)) })
    expect(a?.messages.length).toBeGreaterThan(0)
    const b = await checkFunderBalance({ kv, address: ADDR, now: 1_000_000_000 + 2 * SAMPLE_INTERVAL_MS, readBalance: reader(usd(90)) })
    expect(b?.messages.some((m) => m.includes('P1'))).toBe(true)
  })
})
