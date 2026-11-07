import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/index'
import { checkAndBumpWindowLimit } from '../src/mpp/rate-limit-do'
import { claimTempoLowBalanceAlertSlot, LOW_BALANCE_ALERT_WINDOW_MS } from '../src/utils/tempo-balance'

vi.mock('../src/mpp/rate-limit-do', () => ({ checkAndBumpWindowLimit: vi.fn() }))

const limiter = vi.mocked(checkAndBumpWindowLimit)
const env = {} as Env
const ADDRESS = '0xABC0000000000000000000000000000000000DEF'

describe('claimTempoLowBalanceAlertSlot', () => {
  beforeEach(() => {
    limiter.mockReset()
  })

  it('sends the first alert of the hour', async () => {
    limiter.mockResolvedValue({ ok: true, used: 1, limit: 1 })
    await expect(claimTempoLowBalanceAlertSlot(env, ADDRESS, 1_000)).resolves.toBe(true)
    expect(limiter).toHaveBeenCalledWith(
      env,
      `alert:tempo-low-balance:${ADDRESS.toLowerCase()}`,
      1,
      LOW_BALANCE_ALERT_WINDOW_MS,
      1_000,
    )
  })

  it('suppresses later alerts in the same hour', async () => {
    limiter.mockResolvedValue({ ok: false, used: 1, limit: 1 })
    await expect(claimTempoLowBalanceAlertSlot(env, ADDRESS)).resolves.toBe(false)
  })

  it('still alerts when the limiter is unavailable', async () => {
    limiter.mockRejectedValue(new Error('do unavailable'))
    await expect(claimTempoLowBalanceAlertSlot(env, ADDRESS)).resolves.toBe(true)
  })
})
