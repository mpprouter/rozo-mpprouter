import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { rpc } from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/index'
import { checkAndBumpWindowLimit } from '../src/mpp/rate-limit-do'
import { scrubSettleResult } from '../src/mpp/stellar-x402-server'
import { handlePlaygroundConfig } from '../src/routes/playground'
import { settleAndRecordX402 } from '../src/services/x402-settlement'
import { sendAlert } from '../src/utils/alert'
import { redactForAlert } from '../src/utils/alert-redaction'
import { forgetStellarRpcSecret, safeLogArg, scrubErrorResponse, scrubRpcSecret, stellarRpcUrl } from '../src/utils/stellar-rpc'

vi.mock('../src/mpp/rate-limit-do', () => ({ checkAndBumpWindowLimit: vi.fn() }))
vi.mock('../src/utils/alert', async (original) => ({
  ...(await original<typeof import('../src/utils/alert')>()),
  alertSinkConfigured: () => true,
  sendAlert: vi.fn(async () => true),
}))

const PUBLIC = 'https://public-rpc.example'
const KEY = 'fakeKeyNotReal1234567890abcdef'
const KEYED = `https://stellar-mainnet.g.alchemy.com/v2/${KEY}`
const OTHER_KEY = 'otherVendorFakeKey0987654321'
const OTHER_KEYED = `https://rpc.vendor.example/api/${OTHER_KEY}`

const keyed = { STELLAR_RPC_URL: PUBLIC, STELLAR_RPC_URL_PRIMARY: KEYED }

beforeEach(() => forgetStellarRpcSecret())
afterEach(() => {
  forgetStellarRpcSecret()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('stellarRpcUrl', () => {
  it('uses the public URL when the secret is absent or blank', () => {
    expect(stellarRpcUrl({ STELLAR_RPC_URL: PUBLIC })).toBe(PUBLIC)
    expect(stellarRpcUrl({ STELLAR_RPC_URL: PUBLIC, STELLAR_RPC_URL_PRIMARY: '  ' })).toBe(PUBLIC)
  })

  it('uses the secret when set', () => {
    expect(stellarRpcUrl(keyed)).toBe(KEYED)
  })
})

const ROOT = join(__dirname, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
  })
}

describe('readers of the RPC URL', () => {
  // Each exception is a decision, not a convenience.
  const ALLOWED = new Set([
    'utils/stellar-rpc.ts', // the resolver
    'routes/playground.ts', // public config: must never carry the key
    'refund-signer-core.ts', // separate Worker with its own wrangler config
  ])

  it('all go through the resolver', () => {
    const offenders = sourceFiles(ROOT)
      .map((path) => [relative(ROOT, path), readFileSync(path, 'utf8')] as const)
      .filter(([rel]) => !ALLOWED.has(rel))
      .filter(([, text]) =>
        /\.[ \t]*STELLAR_RPC_URL\b|\[\s*['"]STELLAR_RPC_URL['"]\s*\]|\bSTELLAR_RPC_URL\b[^}\n]*\}\s*=\s*\w*env\b/.test(text))
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })
})

describe('key containment', () => {
  it('scrubs the URL and the bare key, including an unknown vendor once registered', () => {
    stellarRpcUrl({ STELLAR_RPC_URL: PUBLIC, STELLAR_RPC_URL_PRIMARY: OTHER_KEYED })
    const out = scrubRpcSecret(`POST ${OTHER_KEYED} failed, key ${OTHER_KEY}`)
    expect(out).not.toContain(OTHER_KEY)
  })

  it('scrubs an Alchemy URL before the secret is registered', () => {
    expect(scrubRpcSecret(`failed: ${KEYED}`)).not.toContain(KEY)
  })

  it('scrubs every settlement field that reaches a 200 response or the replay cache', () => {
    stellarRpcUrl(keyed)
    const out = scrubSettleResult({
      success: false,
      outcome: 'failed',
      errorReason: `reason ${KEYED}`,
      errorMessage: `message ${KEYED}`,
      attemptedTxs: [],
      causes: [`cause ${KEYED}`],
    })
    expect(JSON.stringify(out)).not.toContain(KEY)
  })

  it('scrubs log arguments, including SDK error config', () => {
    stellarRpcUrl(keyed)
    const err = Object.assign(new Error('Request failed with status code 429'), { config: { url: KEYED } })
    expect(String(safeLogArg(err))).not.toContain(KEY)
    expect(String(safeLogArg(`POST ${KEYED}`))).not.toContain(KEY)
    expect(String(safeLogArg({ url: KEYED }))).not.toContain(KEY)
    const plain = { ok: true }
    expect(safeLogArg(plain)).toBe(plain)
  })

  it('does not advertise the key in the public playground config', async () => {
    const res = handlePlaygroundConfig({
      ...keyed,
      PLAYGROUND_ENABLED: 'true',
      PLAYGROUND_CHANNEL_ENABLED: 'true',
      STELLAR_NETWORK: 'stellar:pubnet',
    } as never, 'https://api.test')
    const text = await res.text()
    expect(text).not.toContain(KEY)
  })

  it('keeps a real SDK RPC error out of alerts and logs', async () => {
    stellarRpcUrl(keyed)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))
    const err = await new rpc.Server(KEYED).getLatestLedger().catch((e: unknown) => e)
    expect(err).toBeTruthy()
    expect(String(redactForAlert(err))).not.toContain(KEY)
    expect(String(redactForAlert({ config: { url: KEYED } }))).not.toContain(KEY)
  })

  it('removes the key from error responses but leaves success responses alone', async () => {
    stellarRpcUrl(keyed)
    const bad = await scrubErrorResponse(new Response(JSON.stringify({ detail: `POST ${KEYED} failed` }), {
      status: 402,
      headers: { 'content-type': 'application/problem+json', 'x-debug': KEYED },
    }))
    expect(bad.status).toBe(402)
    expect(await bad.text()).not.toContain(KEY)
    expect(bad.headers.get('x-debug')).not.toContain(KEY)

    const ok = new Response('fine', { status: 200 })
    expect(await scrubErrorResponse(ok)).toBe(ok)
  })

  it('returns the same response object when no secret is configured', async () => {
    const res = new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } })
    expect(await scrubErrorResponse(res)).toBe(res)
  })

  it('sends an oversized or locked error body unscanned rather than failing', async () => {
    stellarRpcUrl(keyed)
    const big = new Response('x'.repeat(300 * 1024), { status: 502, headers: { 'content-type': 'text/plain' } })
    expect(await scrubErrorResponse(big)).toBe(big)
    expect((await big.text()).length).toBe(300 * 1024)

    const locked = new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } })
    locked.body!.getReader()
    expect(await scrubErrorResponse(locked)).toBe(locked)
  })

  it('does not wait on a stalled error stream', async () => {
    stellarRpcUrl(keyed)
    vi.useFakeTimers()
    try {
      const stalled = new Response(new ReadableStream({ start() {} }), {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      })
      const pending = scrubErrorResponse(stalled)
      await vi.advanceTimersByTimeAsync(2_100)
      expect(await pending).toBe(stalled)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not rewrite a streamed error body', async () => {
    stellarRpcUrl(keyed)
    const res = new Response('data: x\n\n', { status: 500, headers: { 'content-type': 'text/event-stream' } })
    expect(await scrubErrorResponse(res)).toBe(res)
  })
})

describe('settlement persistence', () => {
  it('stores and alerts a URL-bearing failure without the key', async () => {
    stellarRpcUrl(keyed)
    vi.mocked(checkAndBumpWindowLimit).mockResolvedValue({ ok: true, used: 1, limit: 1 })
    vi.mocked(sendAlert).mockClear()
    const store = new Map<string, string>()
    const env = {
      ...keyed,
      MPP_STORE: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
      },
    } as unknown as Env
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext

    await settleAndRecordX402({
      env,
      ctx,
      payload: {} as never,
      requirements: {} as never,
      routeId: 'deepseek_chat',
      payer: 'GPAYER',
      amountUsd: '0.035',
      requestPath: '/chat',
      upstreamStatus: 200,
      latencyMs: 10,
      settle: async () => ({
        success: false,
        outcome: 'failed',
        errorReason: 'unexpected_settle_error',
        errorMessage: `POST ${KEYED} returned 429`,
        attemptedTxs: [],
        causes: [`Error: request to ${KEYED} failed`],
      }),
    })
    await Promise.all(pending)

    const rows = [...store.values()].join('\n')
    expect(rows).toContain('unexpected_settle_error')
    expect(rows).not.toContain(KEY)
    const alerts = vi.mocked(sendAlert).mock.calls.map((call) => String(call[1])).join('\n')
    expect(alerts).not.toContain(KEY)
  })
})
