/**
 * DO CAS daily rate-limit counter (src/mpp/rate-limit-do.ts), the
 * mechanism enforcing Mercury's 1,000 calls/day cap. Copied pattern
 * from coupon.ts:273-313's bumpCounter — these tests are the
 * equivalent lock-in for the new module.
 */

import { describe, it, expect } from 'vitest'
import { checkAndBumpDailyLimit, secondsUntilUtcMidnight, utcDateKey } from '../src/mpp/rate-limit-do'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import type { Env } from '../src/index'

function makeEnv(): Env {
  return { ATOMIC_STORE: makeAtomicStoreMock() } as unknown as Env
}

describe('checkAndBumpDailyLimit', () => {
  it('allows calls under the cap and consumes one slot per call', async () => {
    const env = makeEnv()
    const r1 = await checkAndBumpDailyLimit(env, 'ratelimit:mercury:test-a', 3)
    const r2 = await checkAndBumpDailyLimit(env, 'ratelimit:mercury:test-a', 3)
    expect(r1).toEqual({ ok: true, used: 1, limit: 3 })
    expect(r2).toEqual({ ok: true, used: 2, limit: 3 })
  })

  it('refuses the call once the cap is hit and does NOT consume a slot on refusal', async () => {
    const env = makeEnv()
    const key = 'ratelimit:mercury:test-b'
    await checkAndBumpDailyLimit(env, key, 2)
    await checkAndBumpDailyLimit(env, key, 2)
    const over = await checkAndBumpDailyLimit(env, key, 2)
    expect(over.ok).toBe(false)
    expect(over.used).toBe(2)
    // Refused calls stay refused — the counter didn't advance past the cap.
    const overAgain = await checkAndBumpDailyLimit(env, key, 2)
    expect(overAgain).toEqual({ ok: false, used: 2, limit: 2 })
  })

  it('resets the window on a new UTC day', async () => {
    const env = makeEnv()
    const key = 'ratelimit:mercury:test-c'
    const day1 = Date.parse('2026-08-12T23:59:00Z')
    const day2 = Date.parse('2026-08-13T00:01:00Z')
    await checkAndBumpDailyLimit(env, key, 1, day1)
    const sameDayOver = await checkAndBumpDailyLimit(env, key, 1, day1)
    expect(sameDayOver.ok).toBe(false)
    const nextDay = await checkAndBumpDailyLimit(env, key, 1, day2)
    expect(nextDay).toEqual({ ok: true, used: 1, limit: 1 })
  })

  it('keeps separate services/keys independent', async () => {
    const env = makeEnv()
    await checkAndBumpDailyLimit(env, 'ratelimit:mercury:test-d', 1)
    const other = await checkAndBumpDailyLimit(env, 'ratelimit:other-service:test-d', 1)
    expect(other).toEqual({ ok: true, used: 1, limit: 1 })
  })
})

describe('utcDateKey', () => {
  it('formats a fixed UTC yyyy-mm-dd window key', () => {
    expect(utcDateKey(Date.parse('2026-08-12T23:59:59Z'))).toBe('2026-08-12')
    expect(utcDateKey(Date.parse('2026-08-13T00:00:00Z'))).toBe('2026-08-13')
  })
})

describe('secondsUntilUtcMidnight', () => {
  it('counts down to the next UTC midnight', () => {
    expect(secondsUntilUtcMidnight(Date.parse('2026-08-12T23:59:00Z'))).toBe(60)
    expect(secondsUntilUtcMidnight(Date.parse('2026-08-12T00:00:00Z'))).toBe(24 * 60 * 60)
  })
})
