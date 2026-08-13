/**
 * GET /v1/playground/config — the `channel` block must carry exactly the
 * fields the frontend (PR #20) needs to build the Soroban open tx.
 */
import { describe, expect, it } from 'vitest'
import { handlePlaygroundConfig } from '../src/routes/playground'

const ROUTER = 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV'
const COLLECTOR = 'GBD64XFGJHG42CEVQKH4TYCIAMEHVBMW7A24KS22TKOSSA73IVW3CYIK'
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const FACTORY = 'C' + 'D'.repeat(55)

function env(overrides: Record<string, unknown> = {}) {
  return {
    PLAYGROUND_ENABLED: 'true',
    PLAYGROUND_CHANNEL_ENABLED: 'true',
    PLAYGROUND_CHANNEL_FACTORY: FACTORY,
    PLAYGROUND_CHANNEL_TO: COLLECTOR,
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_ROUTER_PUBLIC: ROUTER,
    STELLAR_RPC_URL: 'https://soroban-rpc.example',
    ...overrides,
  } as any
}

describe('playground config — channel block', () => {
  it('advertises the full open-tx contract', async () => {
    const res = handlePlaygroundConfig(env())
    const body = (await res.json()) as any
    const ch = body.channel
    expect(ch.enabled).toBe(true)
    expect(ch.factory_contract).toBe(FACTORY)
    expect(ch.token_sac).toBe(USDC_SAC)
    // The collector the frontend must use as factory.open `to`.
    expect(ch.channel_to).toBe(COLLECTOR)
    expect(ch.router_recipient).toBe(ROUTER)
    expect(ch.network).toBe('stellar:pubnet')
    expect(ch.network_passphrase).toBe('Public Global Stellar Network ; September 2015')
    expect(ch.soroban_rpc_url).toBe('https://soroban-rpc.example')
    expect(ch.horizon_url).toBe('https://horizon.stellar.org')
    expect(ch.refund_waiting_period).toBe(100)
    expect(ch.deposit_options).toEqual([0.5, 1, 2])
    expect(ch.min_deposit_usd).toBe('0.1')
    expect(ch.max_deposit_usd).toBe('10')
    // Real-cost metering still advertised.
    expect(ch.pricing?.model).toBe('real-cost')
    expect(Array.isArray(ch.models)).toBe(true)
  })

  it('reports factory_contract null and disabled when unset/off', async () => {
    const res = handlePlaygroundConfig(
      env({ PLAYGROUND_CHANNEL_ENABLED: 'false', PLAYGROUND_CHANNEL_FACTORY: '' }),
    )
    const body = (await res.json()) as any
    expect(body.channel.enabled).toBe(false)
    expect(body.channel.factory_contract).toBeNull()
  })

  it('uses the testnet passphrase when the router is on testnet', async () => {
    const res = handlePlaygroundConfig(env({ STELLAR_NETWORK: 'stellar:testnet' }))
    const body = (await res.json()) as any
    expect(body.channel.network_passphrase).toBe('Test SDF Network ; September 2015')
  })
})
