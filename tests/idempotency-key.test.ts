/**
 * Unit tests for src/mpp/idempotency.ts — the scoped cache key that
 * replaced the bare `idempotency:<x-request-id>` namespace.
 *
 * The properties under test are exactly the ones the old key lacked: the
 * same request id must NOT collide across payers, routes, upstream
 * targets, or request bodies; the key must not carry the payer account in
 * the clear; and the encoding must be injective so a caller-controlled
 * field cannot impersonate its neighbour.
 */

import { describe, it, expect } from 'vitest'
import { buildIdempotencyKey } from '../src/mpp/idempotency'

const BASE = {
  requestId: 'req-12345',
  routeId: 'openrouter',
  payer: 'GAK67E2ZPVO7S2ALE3M6RT5HKWLKOMWIYNCOIKIMXSBUV5RRRQI7B7K7',
  method: 'POST',
  upstreamPath: '/api/v1/chat/completions',
  forwardedSearch: '',
  body: '{"model":"claude-opus-5","prompt":"hi"}',
}

describe('buildIdempotencyKey', () => {
  it('is deterministic for identical inputs', async () => {
    expect(await buildIdempotencyKey(BASE)).toBe(await buildIdempotencyKey({ ...BASE }))
  })

  it('lands in the v2 namespace, away from legacy idempotency:* entries', async () => {
    const key = await buildIdempotencyKey(BASE)
    expect(key.startsWith('idempotency:v2:')).toBe(true)
    // The pre-fix key was literally `idempotency:<requestId>`; the new one
    // must not be reachable by anyone replaying that shape.
    expect(key).not.toBe(`idempotency:${BASE.requestId}`)
  })

  it('separates two payers replaying the same request id', async () => {
    const attacker = await buildIdempotencyKey({
      ...BASE,
      payer: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    })
    expect(attacker).not.toBe(await buildIdempotencyKey(BASE))
  })

  it('separates the same payer across routes', async () => {
    expect(await buildIdempotencyKey({ ...BASE, routeId: 'firecrawl' }))
      .not.toBe(await buildIdempotencyKey(BASE))
  })

  it('separates different upstream paths on one route', async () => {
    // Routes resolve `:placeholder` segments, so one route id addresses
    // many merchant resources — the key has to see the resolved path.
    expect(await buildIdempotencyKey({ ...BASE, upstreamPath: '/api/v1/embeddings' }))
      .not.toBe(await buildIdempotencyKey(BASE))
  })

  it('separates different forwarded query strings', async () => {
    expect(await buildIdempotencyKey({ ...BASE, forwardedSearch: '?model=gemini-2.0-flash' }))
      .not.toBe(await buildIdempotencyKey({ ...BASE, forwardedSearch: '?model=gpt-4o' }))
  })

  it('separates different HTTP methods', async () => {
    expect(await buildIdempotencyKey({ ...BASE, method: 'GET' }))
      .not.toBe(await buildIdempotencyKey(BASE))
  })

  it('separates the same payer and id across different request bodies', async () => {
    expect(await buildIdempotencyKey({ ...BASE, body: '{"model":"claude-opus-5","prompt":"bye"}' }))
      .not.toBe(await buildIdempotencyKey(BASE))
  })

  it('treats a missing body and an empty body as the same request', async () => {
    expect(await buildIdempotencyKey({ ...BASE, body: undefined }))
      .toBe(await buildIdempotencyKey({ ...BASE, body: '' }))
  })

  it('does not leak the payer account or request id into the key', async () => {
    const key = await buildIdempotencyKey(BASE)
    expect(key).not.toContain(BASE.payer)
    expect(key).not.toContain(BASE.requestId)
  })

  it('is injective: a field cannot absorb a delimiter to impersonate the next one', async () => {
    // Under the old `payer=..\nroute=..\nrequest=..` join these two tuples
    // serialize to *byte-identical* material: the route id carries its own
    // `\nrequest=` and the real request id is appended after it, which is
    // indistinguishable from a route with no smuggling whose request id
    // happens to contain the same suffix. Length prefixes break the tie.
    const smuggled = await buildIdempotencyKey({
      ...BASE,
      routeId: 'openrouter\nrequest=req-12345',
      requestId: 'victim-request',
    })
    const honest = await buildIdempotencyKey({
      ...BASE,
      routeId: 'openrouter',
      requestId: 'req-12345\nrequest=victim-request',
    })
    expect(smuggled).not.toBe(honest)
  })

  it('is injective across a payer/route boundary too', async () => {
    const smuggled = await buildIdempotencyKey({ ...BASE, payer: `${BASE.payer}openrouter`, routeId: '' })
    expect(smuggled).not.toBe(await buildIdempotencyKey(BASE))
  })
})
