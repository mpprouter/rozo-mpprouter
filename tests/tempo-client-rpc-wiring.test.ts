/**
 * Wiring cover: the shared client must actually reach mppx.
 *
 * This is the test that would have caught the original bug. The other
 * suite proves `getTempoClient` behaves; this one proves the payment path
 * *uses* it. Before the fix, `tempo.charge({ account })` was called with no
 * `getClient`, so mppx fell back to its own hardcoded
 * `defaults.rpcUrl = { 4217: 'https://rpc.tempo.xyz' }` and `TEMPO_RPC_URL`
 * was a silent no-op — the config looked right while every payment went to
 * the throttled public endpoint.
 *
 * All three registered methods are checked, because `charge`, `session` and
 * `sessionLegacy` each resolve their client independently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// `vi.mock` is hoisted above the imports, so the spies it closes over must
// be created inside `vi.hoisted` rather than as plain top-level consts.
const { chargeSpy, sessionSpy, legacySessionSpy } = vi.hoisted(() => ({
  chargeSpy: vi.fn(() => ({ name: 'charge' })),
  sessionSpy: vi.fn(() => ({ name: 'session' })),
  legacySessionSpy: vi.fn(() => ({ name: 'sessionLegacy' })),
}))

vi.mock('mppx/client', () => ({
  Mppx: { create: vi.fn(() => ({ fetch: vi.fn() })) },
  tempo: { charge: chargeSpy, session: sessionSpy },
  sessionLegacy: legacySessionSpy,
  Transport: {},
}))

import { payMerchant } from '../src/mpp/tempo-client'
import { getTempoClient, resetTempoClients } from '../src/mpp/tempo-rpc'

const PRIVATE_RPC = 'https://tempo.example-provider.io/v1/test-key'

// Well-known throwaway test key (Anvil account #0). Not a real wallet.
const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

function makeEnv(rpcUrl: string | undefined) {
  return {
    TEMPO_ROUTER_PRIVATE_KEY: TEST_KEY,
    TEMPO_ROUTER_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    TEMPO_RPC_URL: rpcUrl,
  } as any
}

describe('tempo payment path RPC wiring', () => {
  beforeEach(() => {
    resetTempoClients()
    chargeSpy.mockClear()
    sessionSpy.mockClear()
    legacySessionSpy.mockClear()
  })

  it('passes a getClient to all three mppx methods', async () => {
    await payMerchant(makeEnv(PRIVATE_RPC), 'https://merchant.example/api')

    for (const spy of [chargeSpy, sessionSpy, legacySessionSpy]) {
      expect(spy).toHaveBeenCalledTimes(1)
      const params = spy.mock.calls[0][0] as any
      expect(
        typeof params?.getClient,
        `${spy.getMockName()} must receive getClient or mppx silently uses rpc.tempo.xyz`,
      ).toBe('function')
    }
  })

  it('resolves that getClient to the configured endpoint, not the public default', async () => {
    await payMerchant(makeEnv(PRIVATE_RPC), 'https://merchant.example/api')

    for (const spy of [chargeSpy, sessionSpy, legacySessionSpy]) {
      const { getClient } = spy.mock.calls[0][0] as any
      const client = await getClient({ chainId: 4217 })
      expect(client.transport.url).toBe(PRIVATE_RPC)
      expect(client.transport.url).not.toBe('https://rpc.tempo.xyz')
    }
  })

  it('hands every method the SAME client instance — one connection, not three', async () => {
    await payMerchant(makeEnv(PRIVATE_RPC), 'https://merchant.example/api')

    const clients = await Promise.all(
      [chargeSpy, sessionSpy, legacySessionSpy].map((spy) =>
        (spy.mock.calls[0][0] as any).getClient({ chainId: 4217 }),
      ),
    )

    expect(clients[0]).toBe(clients[1])
    expect(clients[1]).toBe(clients[2])
    expect(clients[0]).toBe(getTempoClient(PRIVATE_RPC))
  })

  it('reuses one client across separate requests', async () => {
    const env = makeEnv(PRIVATE_RPC)

    await payMerchant(env, 'https://merchant.example/api')
    const first = await (chargeSpy.mock.calls[0][0] as any).getClient({ chainId: 4217 })

    chargeSpy.mockClear()
    await payMerchant(env, 'https://merchant.example/api')
    const second = await (chargeSpy.mock.calls[0][0] as any).getClient({ chainId: 4217 })

    expect(second).toBe(first)
  })
})
