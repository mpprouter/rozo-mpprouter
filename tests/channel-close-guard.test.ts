/**
 * Round-8 call-time close-state gate.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  channelClosingForSpend,
  isClosingOrRefundable,
  _clearCloseStateCache,
  type CloseGuardDeps,
} from '../src/playground/channel-close-guard'

const CHANNEL = 'C' + 'A'.repeat(55)
const env = { STELLAR_NETWORK: 'stellar:pubnet', STELLAR_RPC_URL: 'https://rpc' } as any

beforeEach(() => _clearCloseStateCache())

describe('isClosingOrRefundable', () => {
  it('open when closeEffectiveAtLedger is null', () => {
    expect(isClosingOrRefundable({ closeEffectiveAtLedger: null, currentLedger: 100 })).toBe(false)
  })
  it('closing when closeEffectiveAtLedger is set (any remaining ledgers)', () => {
    expect(isClosingOrRefundable({ closeEffectiveAtLedger: 999999, currentLedger: 100 })).toBe(true)
  })
})

describe('channelClosingForSpend', () => {
  it('false for a fully-open channel', async () => {
    const deps: CloseGuardDeps = {
      getChannelState: vi.fn(async () => ({ closeEffectiveAtLedger: null, currentLedger: 10 })),
    }
    expect(await channelClosingForSpend(env, CHANNEL, deps)).toBe(false)
  })

  it('true once close_start has set closeEffectiveAtLedger', async () => {
    const deps: CloseGuardDeps = {
      getChannelState: vi.fn(async () => ({ closeEffectiveAtLedger: 500, currentLedger: 10 })),
    }
    expect(await channelClosingForSpend(env, CHANNEL, deps)).toBe(true)
  })

  it('FAILS CLOSED (true) when the close state cannot be read', async () => {
    const deps: CloseGuardDeps = {
      getChannelState: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    }
    expect(await channelClosingForSpend(env, CHANNEL, deps)).toBe(true)
  })

  it('caches the read within the TTL (no second RPC)', async () => {
    const getChannelState = vi.fn(async () => ({ closeEffectiveAtLedger: null, currentLedger: 10 }))
    const deps: CloseGuardDeps = { getChannelState }
    await channelClosingForSpend(env, CHANNEL, deps)
    await channelClosingForSpend(env, CHANNEL, deps)
    expect(getChannelState).toHaveBeenCalledOnce()
  })
})
