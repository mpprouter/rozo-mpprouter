import { describe, it, expect, vi, afterEach } from 'vitest'
import { verifyTurnstile, TURNSTILE_ACTION } from '../src/routes/coupon-turnstile'
import type { Env } from '../src/index'

const orig = globalThis.fetch
afterEach(() => { globalThis.fetch = orig; vi.restoreAllMocks() })

function mockSiteverify(resp: any, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(resp), { status, headers: { 'Content-Type': 'application/json' } }),
  ) as any
}

const env = (over: Partial<Env> = {}) =>
  ({ TURNSTILE_SECRET: 'sk_test', ...over }) as unknown as Env

describe('verifyTurnstile', () => {
  it('reports notConfigured when no secret is set (staged rollout)', async () => {
    const r = await verifyTurnstile({} as unknown as Env, 'tok', '1.2.3.4')
    expect(r).toEqual({ ok: false, reason: 'notConfigured' })
  })

  it('rejects a missing token without calling siteverify', async () => {
    const spy = vi.fn()
    globalThis.fetch = spy as any
    const r = await verifyTurnstile(env(), '', '1.2.3.4')
    expect(r).toEqual({ ok: false, reason: 'missingToken' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('accepts a valid token with the correct action', async () => {
    mockSiteverify({ success: true, action: TURNSTILE_ACTION, hostname: 'open.rozo.ai' })
    const r = await verifyTurnstile(env(), 'good-token', '1.2.3.4')
    expect(r).toEqual({ ok: true })
  })

  it('rejects a forged/failed token (success=false)', async () => {
    mockSiteverify({ success: false, 'error-codes': ['invalid-input-response'] })
    const r = await verifyTurnstile(env(), 'bad', '1.2.3.4')
    expect(r).toMatchObject({ ok: false, reason: 'rejected' })
  })

  it('rejects a replayed/duplicate token (timeout-or-duplicate)', async () => {
    mockSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] })
    const r = await verifyTurnstile(env(), 'replayed', '1.2.3.4')
    expect(r).toMatchObject({ ok: false, reason: 'rejected', codes: ['timeout-or-duplicate'] })
  })

  it('rejects a token minted for a different action', async () => {
    mockSiteverify({ success: true, action: 'some_other_form', hostname: 'open.rozo.ai' })
    const r = await verifyTurnstile(env(), 'wrong-action', '1.2.3.4')
    expect(r).toMatchObject({ ok: false, reason: 'rejected', codes: ['action-mismatch'] })
  })

  it('rejects a token from the wrong hostname when a hostname is pinned', async () => {
    mockSiteverify({ success: true, action: TURNSTILE_ACTION, hostname: 'evil.example.com' })
    const r = await verifyTurnstile(env({ TURNSTILE_HOSTNAME: 'open.rozo.ai' }), 'wrong-host', '1.2.3.4')
    expect(r).toMatchObject({ ok: false, reason: 'rejected', codes: ['hostname-mismatch'] })
  })

  it('does not pin hostname when none is configured', async () => {
    mockSiteverify({ success: true, action: TURNSTILE_ACTION, hostname: 'anything.example' })
    const r = await verifyTurnstile(env(), 'tok', '1.2.3.4')
    expect(r).toEqual({ ok: true })
  })

  it('rejects a success response that OMITS the action field (fail closed, P2)', async () => {
    mockSiteverify({ success: true, hostname: 'open.rozo.ai' }) // no action
    const r = await verifyTurnstile(env(), 'no-action', '1.2.3.4')
    expect(r).toMatchObject({ ok: false, reason: 'rejected', codes: ['action-mismatch'] })
  })

  it('rejects a success response that OMITS hostname when a hostname is pinned (P2)', async () => {
    mockSiteverify({ success: true, action: TURNSTILE_ACTION }) // no hostname
    const r = await verifyTurnstile(env({ TURNSTILE_HOSTNAME: 'open.rozo.ai' }), 'no-host', '1.2.3.4')
    expect(r).toMatchObject({ ok: false, reason: 'rejected', codes: ['hostname-mismatch'] })
  })

  it('reports unreachable (fail-closed signal) on a network error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('boom') }) as any
    const r = await verifyTurnstile(env(), 'tok', '1.2.3.4')
    expect(r).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('reports unreachable on a non-200 siteverify response', async () => {
    mockSiteverify({}, 503)
    const r = await verifyTurnstile(env(), 'tok', '1.2.3.4')
    expect(r).toEqual({ ok: false, reason: 'unreachable' })
  })
})
