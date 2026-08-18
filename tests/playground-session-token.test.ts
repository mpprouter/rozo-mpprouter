/**
 * Playground session tokens (`src/playground/session-token.ts`) and the model
 * allow-list (`src/playground/models.ts`).
 *
 * The token is the only thing standing between a stranger and someone else's
 * prepaid balance, so the cases that matter are the forgery ones: a tampered
 * payload, a swapped signature, a token minted with a different secret, and an
 * expired token. Fixture addresses are obviously-fake G-addresses.
 */

import { describe, expect, it } from 'vitest'
import {
  KEY_VERSION,
  maskAccount,
  mintSessionToken,
  verifySessionToken,
} from '../src/playground/session-token'
import {
  ModelNotAllowedError,
  PLAYGROUND_MODELS,
  TIER_PRICE_USD,
  assertModelCallable,
  isDepositOption,
} from '../src/playground/models'

const SECRET = 'playground-test-secret-not-a-real-key'
const OTHER_SECRET = 'a-different-playground-test-secret!!'
const ACCOUNT = 'GA6SKSJLJ3E33KKDNB3UDBRIECIBQKGYLGXLCBTXNQ7WWJ27BMDUH6JW'
const NOW = Date.UTC(2026, 7, 12, 12, 0, 0)

async function mint(overrides: { now?: number; ttlSeconds?: number; secret?: string } = {}) {
  return mintSessionToken(overrides.secret ?? SECRET, {
    account: ACCOUNT,
    jti: 'jti-test-1',
    now: overrides.now ?? NOW,
    ttlSeconds: overrides.ttlSeconds ?? 7 * 24 * 3600,
  })
}

describe('session tokens', () => {
  it('round-trips a freshly minted token', async () => {
    const { token, payload } = await mint()
    expect(payload.sub).toBe(ACCOUNT)
    expect(payload.kv).toBe(KEY_VERSION)

    const verified = await verifySessionToken(SECRET, token, NOW)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.payload.sub).toBe(ACCOUNT)
    expect(verified.payload.jti).toBe('jti-test-1')
  })

  it('carries no balance — the ledger is the only source of spendable funds', async () => {
    const { payload } = await mint()
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'kv', 'sub'])
  })

  it('rejects a token whose payload was edited to another account', async () => {
    const { token } = await mint()
    const [, mac] = token.split('.')
    const forgedPayload = btoa(
      JSON.stringify({
        iss: 'mpprouter-playground',
        aud: 'playground',
        sub: 'GDOWC3RXCLSDDY2FKUGRWUNQU25AUK3FFVLHGKRIGGIK2EQ6SRX5A76E',
        jti: 'jti-test-1',
        iat: Math.floor(NOW / 1000),
        exp: Math.floor(NOW / 1000) + 3600,
        kv: KEY_VERSION,
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const verified = await verifySessionToken(SECRET, `${forgedPayload}.${mac}`, NOW)
    expect(verified).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a token minted with a different secret', async () => {
    const { token } = await mint({ secret: OTHER_SECRET })
    const verified = await verifySessionToken(SECRET, token, NOW)
    expect(verified).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects an expired token', async () => {
    const { token } = await mint({ ttlSeconds: 60 })
    expect((await verifySessionToken(SECRET, token, NOW + 59_000)).ok).toBe(true)
    expect(await verifySessionToken(SECRET, token, NOW + 61_000)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('rejects malformed tokens without throwing', async () => {
    for (const bad of ['', 'nodot', 'a.b.c', '.sig', 'payload.', 'not-base64!.also-not!']) {
      const verified = await verifySessionToken(SECRET, bad, NOW)
      expect(verified.ok).toBe(false)
    }
  })

  it('fails closed when the secret is missing or too short to be a secret', async () => {
    // Called directly rather than through `mint()`, whose `?? SECRET` default
    // would paper over exactly the unset-secret case under test.
    const args = { account: ACCOUNT, jti: 'j', now: NOW, ttlSeconds: 60 }
    await expect(mintSessionToken(undefined, args)).rejects.toThrow(/PLAYGROUND_SESSION_SECRET/)
    await expect(mintSessionToken('', args)).rejects.toThrow(/PLAYGROUND_SESSION_SECRET/)
    await expect(mintSessionToken('short', args)).rejects.toThrow(/PLAYGROUND_SESSION_SECRET/)

    // Verification fails closed the same way — an unset secret must never
    // degrade into "accept anything".
    const { token } = await mint()
    await expect(verifySessionToken(undefined, token, NOW)).rejects.toThrow(
      /PLAYGROUND_SESSION_SECRET/,
    )
  })

  it('verification is length-then-content, never a short-circuit on content', async () => {
    // A truncated MAC must be rejected on length, and a same-length MAC with a
    // correct first byte must not fare better than one with a wrong first byte.
    const { token } = await mint()
    const [payload, mac] = token.split('.')
    const truncated = await verifySessionToken(SECRET, `${payload}.${mac.slice(0, -4)}`, NOW)
    expect(truncated.ok).toBe(false)

    const flippedFirst = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`
    const flippedLast = `${mac.slice(0, -1)}${mac.at(-1) === 'A' ? 'B' : 'A'}`
    expect((await verifySessionToken(SECRET, `${payload}.${flippedFirst}`, NOW)).ok).toBe(false)
    expect((await verifySessionToken(SECRET, `${payload}.${flippedLast}`, NOW)).ok).toBe(false)
  })
})

describe('account masking', () => {
  it('masks to first 6 + last 4', () => {
    expect(maskAccount(ACCOUNT)).toBe(`${ACCOUNT.slice(0, 6)}...${ACCOUNT.slice(-4)}`)
    expect(maskAccount('short')).toBe('short')
  })
})

describe('model allow-list', () => {
  it('accepts a charge-verified model', () => {
    // Was claude-haiku-4-5 until the 2026-08-18 anthropic delisting.
    const model = assertModelCallable('llama-3.1-8b-instant')
    expect(model.tier).toBe('cheap')
    expect(TIER_PRICE_USD[model.tier]).toBe('0.02')
  })

  it('rejects a model that is not on the list at all', () => {
    expect(() => assertModelCallable('gpt-4-turbo')).toThrow(ModelNotAllowedError)
    try {
      assertModelCallable('gpt-4-turbo')
    } catch (e) {
      expect((e as ModelNotAllowedError).code).toBe('model_not_allowed')
    }
  })

  it('has no callable flagship model, and says so rather than substituting one', () => {
    // Until 2026-08-18 this asserted that claude-opus-5 was callable. The
    // anthropic route is now delisted (merchant 403s after taking payment)
    // and the only other flagship entry is the openai placeholder that was
    // never verified, so the tier is advertised and entirely uncallable.
    // Deliberately not repaired by promoting some other model into the tier:
    // no flagship model has a paid run behind it right now.
    const flagship = PLAYGROUND_MODELS.filter(m => m.tier === 'flagship')
    expect(flagship.length).toBeGreaterThan(0)
    for (const model of flagship) {
      expect(model.available).toBe(false)
      expect(() => assertModelCallable(model.id)).toThrow(ModelNotAllowedError)
    }
    // The tier itself, and its price, still exist for when one comes back.
    expect(TIER_PRICE_USD.flagship).toBe('0.10')
  })

  it('rejects every listed-but-unavailable model with a distinct code and a reason', () => {
    // Unavailable models stay advertised so the UI can grey them honestly.
    // Asserted over ALL of them rather than the first one: the list order
    // changed under this test on 2026-08-18, and an order-coupled assertion
    // silently tests a different model than the one its comment names.
    const unavailable = PLAYGROUND_MODELS.filter(m => !m.available)
    expect(unavailable.length).toBeGreaterThan(0)
    for (const model of unavailable) {
      expect(model.unavailableReason).toBeTruthy()
      try {
        assertModelCallable(model.id)
        throw new Error(`expected ${model.id} to be rejected`)
      } catch (e) {
        expect((e as ModelNotAllowedError).code).toBe('model_unavailable')
        expect((e as ModelNotAllowedError).message).toBe(model.unavailableReason)
      }
    }
  })

  it('rejects non-string model ids', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(() => assertModelCallable(bad)).toThrow(ModelNotAllowedError)
    }
  })

  it('every available model points at a distinct charge-mode chat route', () => {
    const available = PLAYGROUND_MODELS.filter(m => m.available)
    expect(available.length).toBeGreaterThan(0)
    for (const m of available) {
      expect(m.routePublicPath).toMatch(/^\/v1\/services\//)
      expect(m.routeMethod).toBe('POST')
    }
  })
})

describe('deposit options', () => {
  it('accepts the offered amounts in any equivalent decimal form', () => {
    expect(isDepositOption('1')).toBe(true)
    expect(isDepositOption('1.00')).toBe(true)
    expect(isDepositOption('0.1')).toBe(true)
    expect(isDepositOption('0.10')).toBe(true)
    expect(isDepositOption('10')).toBe(true)
    expect(isDepositOption('100')).toBe(true)
    expect(isDepositOption('100.00')).toBe(true)
  })

  it('refuses amounts we do not offer, including free-form and malformed ones', () => {
    expect(isDepositOption('0.5')).toBe(false)
    expect(isDepositOption('50')).toBe(false)
    expect(isDepositOption('1000')).toBe(false)
    expect(isDepositOption('0')).toBe(false)
    expect(isDepositOption('-1')).toBe(false)
    expect(isDepositOption('abc')).toBe(false)
  })
})
