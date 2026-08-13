/**
 * Turnstile gate on `POST /v1/playground/session/intent`.
 *
 * The gate stands in front of an on-chain deposit, so the property that
 * matters most is FAIL-CLOSED: an unconfigured or unreachable Turnstile must
 * block the request, never wave it through. The verifier itself is exercised
 * against a mocked Cloudflare siteverify, and the route is checked end-to-end.
 *
 * Fixture addresses are real checksummed Stellar public keys with no funds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/index'
import { handlePlaygroundConfig, handlePlaygroundIntent } from '../src/routes/playground'
import {
  PLAYGROUND_TURNSTILE_ACTION,
  PLAYGROUND_TURNSTILE_HOSTNAME,
  verifyPlaygroundTurnstile,
} from '../src/playground/turnstile'
import { makePlaygroundLedgerMock } from './helpers/playground-ledger-mock'

const ALICE = 'GA6SKSJLJ3E33KKDNB3UDBRIECIBQKGYLGXLCBTXNQ7WWJ27BMDUH6JW'
const ROUTER = 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV'
const SECRET = 'playground-test-secret-not-a-real-key'

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    PLAYGROUND_LEDGER: makePlaygroundLedgerMock(),
    PLAYGROUND_ENABLED: 'true',
    PLAYGROUND_SESSION_SECRET: SECRET,
    STELLAR_ROUTER_PUBLIC: ROUTER,
    ...overrides,
  } as unknown as Env
}

/** Stub Cloudflare siteverify with a fixed response body. */
function stubSiteverify(body: Record<string, unknown>) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
}

function intentRequest(token?: string): Request {
  return new Request('https://apiserver.example/v1/playground/session/intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
    body: JSON.stringify({ account: ALICE, amount_usd: '1', ...(token ? { turnstile_token: token } : {}) }),
  })
}

afterEach(() => vi.restoreAllMocks())

describe('verifyPlaygroundTurnstile', () => {
  it('fails closed when the secret is unset and not explicitly disabled', async () => {
    const result = await verifyPlaygroundTurnstile(makeEnv(), 'tok', null)
    expect(result).toEqual({ ok: false, reason: 'not_configured' })
  })

  it('passes only when explicitly disabled', async () => {
    const result = await verifyPlaygroundTurnstile(
      makeEnv({ PLAYGROUND_TURNSTILE_DISABLED: 'true' }),
      null,
      null,
    )
    expect(result).toEqual({ ok: true, mode: 'disabled' })
  })

  it('treats any value other than the exact string "true" as still-enabled', async () => {
    for (const v of ['false', 'TRUE', '1', 'yes', '']) {
      const result = await verifyPlaygroundTurnstile(
        makeEnv({ PLAYGROUND_TURNSTILE_DISABLED: v }),
        'tok',
        null,
      )
      // Secret is unset, so a non-"true" disable value must fail closed.
      expect(result).toEqual({ ok: false, reason: 'not_configured' })
    }
  })

  it('rejects a missing token when configured', async () => {
    const result = await verifyPlaygroundTurnstile(
      makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk' }),
      '',
      null,
    )
    expect(result).toEqual({ ok: false, reason: 'missing_token' })
  })

  it('accepts a token with the right action and hostname', async () => {
    stubSiteverify({
      success: true,
      action: PLAYGROUND_TURNSTILE_ACTION,
      hostname: PLAYGROUND_TURNSTILE_HOSTNAME,
    })
    const result = await verifyPlaygroundTurnstile(
      makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk' }),
      'tok',
      '203.0.113.7',
    )
    expect(result).toEqual({ ok: true, mode: 'verified' })
  })

  it('rejects a token minted for a different action', async () => {
    // e.g. lifted from the coupon widget.
    stubSiteverify({ success: true, action: 'coupon_redeem', hostname: PLAYGROUND_TURNSTILE_HOSTNAME })
    const result = await verifyPlaygroundTurnstile(
      makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk' }),
      'tok',
      null,
    )
    expect(result).toMatchObject({ ok: false, reason: 'rejected', codes: ['action-mismatch'] })
  })

  it('rejects a token minted for a different hostname', async () => {
    stubSiteverify({
      success: true,
      action: PLAYGROUND_TURNSTILE_ACTION,
      hostname: 'evil.example.com',
    })
    const result = await verifyPlaygroundTurnstile(
      makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk' }),
      'tok',
      null,
    )
    expect(result).toMatchObject({ ok: false, reason: 'rejected', codes: ['hostname-mismatch'] })
  })

  it('rejects when siteverify reports failure', async () => {
    stubSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] })
    const result = await verifyPlaygroundTurnstile(
      makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk' }),
      'tok',
      null,
    )
    expect(result).toMatchObject({ ok: false, reason: 'rejected', codes: ['timeout-or-duplicate'] })
  })

  it('rejects a success response missing the hostname field entirely', async () => {
    stubSiteverify({ success: true, action: PLAYGROUND_TURNSTILE_ACTION })
    const result = await verifyPlaygroundTurnstile(
      makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk' }),
      'tok',
      null,
    )
    expect(result).toMatchObject({ ok: false, reason: 'rejected' })
  })

  it('collapses a network failure to unreachable, never to a pass', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    const result = await verifyPlaygroundTurnstile(
      makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk' }),
      'tok',
      null,
    )
    expect(result).toEqual({ ok: false, reason: 'unreachable' })
  })
})

describe('POST /v1/playground/session/intent — Turnstile gate', () => {
  it('503s (fail closed) when Turnstile is unconfigured, before minting anything', async () => {
    const env = makeEnv()
    const r = await handlePlaygroundIntent(intentRequest('tok'), env)
    expect(r.status).toBe(503)
    expect((await r.json()).error).toBe('turnstile_not_configured')
  })

  it('403s a request with no token when Turnstile is configured', async () => {
    const env = makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk' })
    const r = await handlePlaygroundIntent(intentRequest(), env)
    expect(r.status).toBe(403)
    expect((await r.json()).error).toBe('turnstile_missing_token')
  })

  it('403s a forged/wrong-host token', async () => {
    stubSiteverify({ success: true, action: PLAYGROUND_TURNSTILE_ACTION, hostname: 'evil.example.com' })
    const env = makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk' })
    const r = await handlePlaygroundIntent(intentRequest('tok'), env)
    expect(r.status).toBe(403)
    expect((await r.json()).error).toBe('turnstile_rejected')
  })

  it('mints an intent once Turnstile passes', async () => {
    stubSiteverify({
      success: true,
      action: PLAYGROUND_TURNSTILE_ACTION,
      hostname: PLAYGROUND_TURNSTILE_HOSTNAME,
    })
    const env = makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk' })
    const r = await handlePlaygroundIntent(intentRequest('tok'), env)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.intent_id).toBeDefined()
    expect(body.destination).toBe(ROUTER)
  })

  it('mints without a token when explicitly disabled (staged rollout)', async () => {
    const env = makeEnv({ PLAYGROUND_TURNSTILE_DISABLED: 'true' })
    const r = await handlePlaygroundIntent(intentRequest(), env)
    expect(r.status).toBe(200)
  })
})

describe('GET /v1/playground/config — Turnstile advertisement', () => {
  it('exposes the site key and marks Turnstile required when enabled', async () => {
    const env = makeEnv({ PLAYGROUND_TURNSTILE_SECRET: 'sk', PLAYGROUND_TURNSTILE_SITE_KEY: '0xSITEKEY' })
    const body = await handlePlaygroundConfig(env).json()
    expect(body.turnstile).toEqual({
      required: true,
      site_key: '0xSITEKEY',
      action: PLAYGROUND_TURNSTILE_ACTION,
    })
  })

  it('marks Turnstile not required when explicitly disabled', async () => {
    const env = makeEnv({ PLAYGROUND_TURNSTILE_DISABLED: 'true' })
    const body = await handlePlaygroundConfig(env).json()
    expect(body.turnstile.required).toBe(false)
    expect(body.turnstile.site_key).toBeNull()
  })
})
