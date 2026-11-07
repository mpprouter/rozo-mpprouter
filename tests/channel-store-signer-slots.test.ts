import { describe, expect, it } from 'vitest'
import type { Env } from '../src/index'
import { bumpCumulative, getTempoChannel, listTempoChannels } from '../src/mpp/channel-store'

const OLD = '0xAAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA'
const NEW = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb'

function makeEnv(router: string | undefined, data: Record<string, unknown>) {
  const kv = new Map(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
  const env = {
    TEMPO_ROUTER_ADDRESS: router,
    MPP_STORE: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async ({ prefix }: { prefix: string }) => ({
        keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
    },
  } as unknown as Env
  return { env, kv }
}

const channel = (signer: string, channelId: string, cumulativeRaw = '10') => ({
  channelId,
  authorizedSigner: signer,
  cumulativeRaw,
  depositRaw: '1000',
})

describe('Tempo channel signer slots', () => {
  it('uses the primary slot when the current key signs it', async () => {
    const { env } = makeEnv(OLD, { 'tempoChannel:m': channel(OLD, '0x1'), 'tempoChannelAlt:m': channel(NEW, '0x2') })
    expect((await getTempoChannel(env, 'm'))?.channelId).toBe('0x1')
  })

  it('falls to the alternate slot when only it matches, ignoring address case', async () => {
    const { env } = makeEnv(NEW.toLowerCase(), { 'tempoChannel:m': channel(OLD, '0x1'), 'tempoChannelAlt:m': channel(NEW, '0x2') })
    expect((await getTempoChannel(env, 'm'))?.channelId).toBe('0x2')
  })

  it('reports no channel rather than one the current key cannot sign', async () => {
    const { env } = makeEnv(NEW, { 'tempoChannel:m': channel(OLD, '0x1') })
    expect(await getTempoChannel(env, 'm')).toBeNull()
    await expect(bumpCumulative(env, 'm', '20')).rejects.toThrow('no channel')
  })

  it('trusts the key over a mismatched TEMPO_ROUTER_ADDRESS', async () => {
    const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
    const signer = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    const { env } = makeEnv(OLD, { 'tempoChannel:m': channel(OLD, '0x1'), 'tempoChannelAlt:m': channel(signer, '0x2') })
    ;(env as unknown as { TEMPO_ROUTER_PRIVATE_KEY: string }).TEMPO_ROUTER_PRIVATE_KEY = key
    expect((await getTempoChannel(env, 'm'))?.channelId).toBe('0x2')
  })

  it('rejects an entry with no signer', async () => {
    const { env } = makeEnv(OLD, { 'tempoChannel:m': { channelId: '0x1', cumulativeRaw: '0', depositRaw: '1' } })
    expect(await getTempoChannel(env, 'm')).toBeNull()
  })

  it('keeps old behaviour when no router address is configured', async () => {
    const { env } = makeEnv(undefined, { 'tempoChannel:m': channel(OLD, '0x1') })
    expect((await getTempoChannel(env, 'm'))?.channelId).toBe('0x1')
  })

  it('bumps only the slot it resolved, leaving the other key channel untouched', async () => {
    const { env, kv } = makeEnv(NEW, { 'tempoChannel:m': channel(OLD, '0x1'), 'tempoChannelAlt:m': channel(NEW, '0x2') })
    await bumpCumulative(env, 'm', '20')
    expect(JSON.parse(kv.get('tempoChannelAlt:m')!).cumulativeRaw).toBe('20')
    expect(JSON.parse(kv.get('tempoChannel:m')!).cumulativeRaw).toBe('10')
  })

  it('rolls back with the secrets once the slots are swapped', async () => {
    const data = { 'tempoChannel:m': channel(NEW, '0x2'), 'tempoChannelAlt:m': channel(OLD, '0x1') }
    expect((await getTempoChannel(makeEnv(NEW, data).env, 'm'))?.channelId).toBe('0x2')
    expect((await getTempoChannel(makeEnv(OLD, data).env, 'm'))?.channelId).toBe('0x1')
  })

  it('lists primary entries whatever key is active', async () => {
    const { env } = makeEnv(NEW, { 'tempoChannel:m': channel(OLD, '0x1'), 'tempoChannelAlt:m': channel(NEW, '0x2') })
    expect((await listTempoChannels(env)).map((c) => c.state.channelId)).toEqual(['0x1'])
  })
})
