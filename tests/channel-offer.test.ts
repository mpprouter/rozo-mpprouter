/**
 * mpp-spec §3.4 channel offer — the `scheme: "channel"` entry the metered
 * channel endpoints put in their 402 `accepts[]`, and the same object in
 * GET /v1/playground/config for discovery.
 */
import { describe, expect, it } from 'vitest'
import { Transport } from 'mppx/client'
import {
  channelOffer,
  channelOfferEnvelope,
  withChannelOffer,
} from '../src/playground/channel-offer'
import { handlePlaygroundConfig } from '../src/routes/playground'

const COLLECTOR = 'GBD64XFGJHG42CEVQKH4TYCIAMEHVBMW7A24KS22TKOSSA73IVW3CYIK'
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const FACTORY = 'CCR2HE6CAMBYNUQG4N27CH5EAYELGYTQIONTYJ72K63XQZSL23OV7RTX'
const WASM = 'd6717aa80e0a1e6f5e6e6b5a8a4c00219ecbd1d3c5be61a44134324dd56e7df2'

function env(overrides: Record<string, unknown> = {}) {
  return {
    PLAYGROUND_ENABLED: 'true',
    PLAYGROUND_CHANNEL_ENABLED: 'true',
    PLAYGROUND_CHANNEL_FACTORY: FACTORY,
    PLAYGROUND_CHANNEL_TO: COLLECTOR,
    PLAYGROUND_CHANNEL_WASM_HASH: WASM,
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_ROUTER_PUBLIC: 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV',
    STELLAR_RPC_URL: 'https://rpc.example',
    ...overrides,
  } as any
}

describe('channelOffer', () => {
  it('carries every spec field from the same config register enforces', () => {
    const o = channelOffer(env(), 'https://apiserver.mpprouter.dev', 220000n)
    expect(o).toEqual({
      scheme: 'channel',
      network: 'stellar:pubnet',
      asset: USDC_SAC,
      payTo: COLLECTOR, // the channel `to` (collector), not the factory admin
      amount: '220000',
      extra: {
        factory: FACTORY,
        wasmHash: WASM,
        refundWaitingPeriodMinLedgers: 100,
        register: 'https://apiserver.mpprouter.dev/v1/playground/channel/register',
        minDeposit: '0.1',
      },
    })
  })

  it('omits amount on a generic (config) offer', () => {
    expect(channelOffer(env(), 'https://x.test')).not.toHaveProperty('amount')
  })

  it('is null when any trust anchor is missing or the surface is off (fail closed)', () => {
    expect(channelOffer(env({ PLAYGROUND_CHANNEL_FACTORY: '' }), 'https://x.test')).toBeNull()
    expect(channelOffer(env({ PLAYGROUND_CHANNEL_TO: '' }), 'https://x.test')).toBeNull()
    expect(channelOffer(env({ PLAYGROUND_CHANNEL_WASM_HASH: 'zz' }), 'https://x.test')).toBeNull()
    expect(channelOffer(env({ PLAYGROUND_CHANNEL_ENABLED: 'false' }), 'https://x.test')).toBeNull()
  })
})

describe('offer envelope in the 402 body', () => {
  it('is an x402 envelope with the offer as the single accepts[] entry', () => {
    const url = 'https://apiserver.mpprouter.dev/v1/playground/channel/chat?agent=G'
    const body = channelOfferEnvelope(env(), url, 220000n)!
    expect(body.x402Version).toBe(2)
    expect((body.resource as any).url).toBe(url)
    expect(body.accepts).toHaveLength(1)
    expect((body.accepts as any)[0].scheme).toBe('channel')
    expect((body.accepts as any)[0].extra.register).toBe('https://apiserver.mpprouter.dev/v1/playground/channel/register')
  })

  it('merges into an existing JSON 402 body, keeps headers, never adds Payment-Required', async () => {
    const orig = new Response('{"error":"channel_not_registered","hint":"x"}', {
      status: 402,
      headers: { 'WWW-Authenticate': 'Payment abc', 'content-type': 'application/json' },
    })
    const res = await withChannelOffer(orig, env(), 'https://x.test/v1/playground/channel/chat', 1n)
    expect(res.status).toBe(402)
    expect(res.headers.get('WWW-Authenticate')).toBe('Payment abc')
    expect(res.headers.get('Payment-Required')).toBeNull()
    const body = (await res.json()) as any
    expect(body.error).toBe('channel_not_registered')
    expect(body.hint).toBe('x')
    expect(body.accepts[0].scheme).toBe('channel')
    expect(body.accepts[0].amount).toBe('1')
  })

  it('fills an empty body (the mppx first-probe challenge) with the envelope as JSON', async () => {
    const orig = new Response(null, { status: 402, headers: { 'WWW-Authenticate': 'Payment abc' } })
    const res = await withChannelOffer(orig, env(), 'https://x.test/v1/playground/channel/chat', 5n)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('WWW-Authenticate')).toBe('Payment abc')
    expect(((await res.json()) as any).accepts[0].amount).toBe('5')
  })

  it('leaves a non-JSON body alone, and is a no-op with no offer', async () => {
    const html = new Response('<html>pay</html>', { status: 402, headers: { 'content-type': 'text/html' } })
    const res = await withChannelOffer(html, env(), 'https://x.test/a', 1n)
    expect(await res.text()).toBe('<html>pay</html>')
    expect(res.headers.get('content-type')).toBe('text/html')

    const same = new Response('x', { status: 402 })
    expect(await withChannelOffer(same, env({ PLAYGROUND_CHANNEL_FACTORY: '' }), 'https://x.test/a')).toBe(same)
  })

  it("mppx 0.7.0's own client parser still reads our 402 (the regression the header version caused)", async () => {
    // A real mppx WWW-Authenticate challenge line; the parser must find it and
    // must not throw on anything else we add to the response.
    const wwwAuth =
      'Payment id="c1", realm="x.test", method="stellar-channel", intent="charge", request="eyJhbW91bnQiOiIwLjAyIn0", expires="2099-01-01T00:00:00.000Z"'
    const orig = new Response(null, { status: 402, headers: { 'WWW-Authenticate': wwwAuth } })
    const res = await withChannelOffer(orig, env(), 'https://x.test/v1/playground/channel/chat', 220000n)
    const t = Transport.http()
    const challenges = t.getChallenges ? t.getChallenges(res) : [t.getChallenge(res)]
    expect(challenges.length).toBeGreaterThanOrEqual(1)
    expect((challenges[0] as any).method).toBe('stellar-channel')
  })
})

describe('GET /v1/playground/config', () => {
  it('exposes the same offer under channel.offer', async () => {
    const body = (await handlePlaygroundConfig(env(), 'https://apiserver.mpprouter.dev').json()) as any
    expect(body.channel.offer).toEqual(channelOffer(env(), 'https://apiserver.mpprouter.dev'))
    expect(body.channel.offer.extra.register).toBe('https://apiserver.mpprouter.dev/v1/playground/channel/register')
  })
})
