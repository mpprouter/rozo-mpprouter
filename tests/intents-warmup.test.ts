// Intents payment-api warm-up trial: the 1-minute cron runs ONLY the warm-up,
// the 2-minute cron runs the regular jobs and never the warm-up, the kill
// switch stops it, and nothing is thrown or logged beyond status + ms.
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import {
  INTENTS_WARMUP_CRON,
  INTENTS_WARMUP_URL,
  intentsWarmupEnabled,
  warmIntentsPaymentApi,
} from '../src/utils/intents-warmup'

function urlOf(input: any): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function fakeCtx() {
  const pending: Promise<unknown>[] = []
  return {
    pending,
    ctx: {
      waitUntil: (p: Promise<unknown>) => { pending.push(Promise.resolve(p).catch(() => undefined)) },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  }
}

const controller = (cron: string) => ({ cron, scheduledTime: Date.now(), noRetry() {} }) as ScheduledController

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('intentsWarmupEnabled', () => {
  it('is on unless set to "off"', () => {
    expect(intentsWarmupEnabled({})).toBe(true)
    expect(intentsWarmupEnabled({ INTENTS_WARMUP: 'on' })).toBe(true)
    expect(intentsWarmupEnabled({ INTENTS_WARMUP: 'off' })).toBe(false)
    expect(intentsWarmupEnabled({ INTENTS_WARMUP: ' OFF ' })).toBe(false)
  })
})

describe('warmIntentsPaymentApi', () => {
  it('sends one OPTIONS to the create endpoint, without an API key, and logs status + ms', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 200,
      headers: { 'x-envoy-upstream-service-time': '12', 'x-sb-edge-region': 'eu-west-3' },
    }))
    let t = 1_000
    const out = await warmIntentsPaymentApi({ INTENTS_WARMUP: 'on' }, fetchImpl as any, () => (t += 120))
    expect(out).toEqual({ status: 200, ms: 120 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(INTENTS_WARMUP_URL)
    expect(init.method).toBe('OPTIONS')
    expect(init.headers).toBeUndefined()
    expect(init.signal).toBeDefined()
    expect(log).toHaveBeenCalledWith('[intents-warmup] status=200 ms=120 upstream_ms=12 region=eu-west-3')
  })

  it('targets payment-api on the Supabase host (the intentapiv4 proxy answers OPTIONS itself)', () => {
    expect(INTENTS_WARMUP_URL).toBe('https://aozudqtlykbhzbuzalzz.supabase.co/functions/v1/payment-api/')
  })

  it('logs "-" for missing or odd timing headers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204, headers: { 'x-envoy-upstream-service-time': 'abc' } }))
    let t = 0
    await warmIntentsPaymentApi({}, fetchImpl as any, () => (t += 5))
    expect(log).toHaveBeenCalledWith('[intents-warmup] status=204 ms=5 upstream_ms=- region=-')
  })

  it('does nothing when switched off', async () => {
    const fetchImpl = vi.fn()
    expect(await warmIntentsPaymentApi({ INTENTS_WARMUP: 'off' }, fetchImpl as any)).toEqual({ status: 'off', ms: 0 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never throws on a network error or timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError') })
    const out = await warmIntentsPaymentApi({}, fetchImpl as any)
    expect(out.status).toBe('error')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[intents-warmup\] status=error err=TimeoutError ms=\d+$/)
  })
})

describe('scheduled() cron dispatch', () => {
  it('the 1-minute cron runs only the warm-up', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, pending } = fakeCtx()
    await worker.scheduled(controller(INTENTS_WARMUP_CRON), {} as any, ctx)
    await Promise.all(pending)
    expect(pending).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(urlOf(url)).toBe(INTENTS_WARMUP_URL)
    expect(init.method).toBe('OPTIONS')
  })

  it('the 1-minute cron with the switch off sends nothing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, pending } = fakeCtx()
    await worker.scheduled(controller(INTENTS_WARMUP_CRON), { INTENTS_WARMUP: 'off' } as any, ctx)
    await Promise.all(pending)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the 2-minute cron runs the regular jobs and never the warm-up', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, pending } = fakeCtx()
    await worker.scheduled(controller('*/2 * * * *'), {} as any, ctx)
    expect(pending.length).toBeGreaterThan(1)
    await Promise.all(pending)
    const warmups = fetchMock.mock.calls.filter(([u, init]: any[]) =>
      urlOf(u) === INTENTS_WARMUP_URL && (init?.method ?? 'GET') === 'OPTIONS')
    expect(warmups).toHaveLength(0)
  })
})
