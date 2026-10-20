import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/utils/alert', () => ({
  alertSinkConfigured: vi.fn(() => true),
  sendAlert: vi.fn(async () => true),
}))

import {
  checkCreateInvoiceGate,
  clientIp,
  resolveGateLimits,
  DEFAULT_IP_LIMIT_PER_HOUR,
  DEFAULT_GLOBAL_LIMIT_PER_HOUR,
} from '../src/routes/create-invoice-gate'
import type { Env } from '../src/index'
import { sendAlert } from '../src/utils/alert'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

beforeEach(() => {
  vi.mocked(sendAlert).mockClear()
})

function badDoEnv(fetch: () => Promise<Response>): Env {
  return {
    ATOMIC_STORE: { idFromName: () => ({}), get: () => ({ fetch }) },
  } as unknown as Env
}

const HOUR_MS = 3_600_000
const bucketNow = () => String(Math.floor(Date.now() / HOUR_MS))

async function doJson(store: ReturnType<typeof makeDoStub>, path: string, body: unknown): Promise<any> {
  const res = await store.stub.fetch(
    new Request(`https://atomic-store.internal${path}`, { method: 'POST', body: JSON.stringify(body) }),
  )
  return { status: res.status, body: res.ok ? await res.json() : await res.text() }
}

// The real AtomicStoreDO over in-memory storage, with a counter on stub.fetch
// so tests can pin the one-round-trip contract. One DO shared across all keys
// so global + per-IP counters accumulate like production.
function makeDoStub() {
  const ns = makeAtomicStoreMock()
  const inner = ns.get(ns.idFromName('coupon'))
  const calls: string[] = []
  const stub = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init)
      calls.push(new URL(req.url).pathname)
      return inner.fetch(req)
    },
  }
  return Object.assign({ idFromName: (n: string) => ({ name: n }), get: () => stub }, { calls, stub })
}

function makeEnv(overrides: Partial<Env> = {}, store = makeDoStub()): Env {
  return {
    ATOMIC_STORE: store,
    ...overrides,
  } as unknown as Env
}

function reqFromIp(ip: string): Request {
  return new Request('https://apiserver.mpprouter.dev/v1/services/pay/create-invoice', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
  })
}

describe('create-invoice anti-abuse gate', () => {
  it('defaults to 200 per IP and 1500 global per hour, above the upstream tier1 (180/hour)', () => {
    expect(DEFAULT_IP_LIMIT_PER_HOUR).toBe(200)
    expect(DEFAULT_GLOBAL_LIMIT_PER_HOUR).toBe(1500)
    expect(resolveGateLimits({})).toEqual({ ipPerHour: 200, globalPerHour: 1500 })
  })

  it('reads limits from env and falls back per key on malformed values', () => {
    expect(
      resolveGateLimits({ CREATE_INVOICE_IP_LIMIT_PER_HOUR: '250', CREATE_INVOICE_GLOBAL_LIMIT_PER_HOUR: ' 2000 ' }),
    ).toEqual({ ipPerHour: 250, globalPerHour: 2000 })
    for (const bad of ['', '0', '-5', '1.5', 'abc', '1e3']) {
      expect(
        resolveGateLimits({ CREATE_INVOICE_IP_LIMIT_PER_HOUR: bad, CREATE_INVOICE_GLOBAL_LIMIT_PER_HOUR: bad }),
      ).toEqual({ ipPerHour: 200, globalPerHour: 1500 })
    }
  })

  it('allows a single IP up to the default per-IP limit (old cap of 30 no longer applies)', async () => {
    const env = makeEnv()
    for (let i = 0; i < DEFAULT_IP_LIMIT_PER_HOUR; i++) {
      const d = await checkCreateInvoiceGate(reqFromIp('1.2.3.4'), env)
      expect(d.ok).toBe(true)
    }
    const d = await checkCreateInvoiceGate(reqFromIp('1.2.3.4'), env)
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.reason).toBe('ip_rate_limited')
      expect(d.limit).toBe(DEFAULT_IP_LIMIT_PER_HOUR)
      expect(d.retryAfterSeconds).toBeGreaterThan(0)
      expect(d.retryAfterSeconds).toBeLessThanOrEqual(3600)
    }
  })

  it('applies the per-IP limit from env', async () => {
    const env = makeEnv({ CREATE_INVOICE_IP_LIMIT_PER_HOUR: '3' })
    for (let i = 0; i < 3; i++) {
      expect((await checkCreateInvoiceGate(reqFromIp('9.9.9.9'), env)).ok).toBe(true)
    }
    const d = await checkCreateInvoiceGate(reqFromIp('9.9.9.9'), env)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toBe('ip_rate_limited')
  })

  it('does not penalize a second IP when the first is limited', async () => {
    const env = makeEnv({ CREATE_INVOICE_IP_LIMIT_PER_HOUR: '3' })
    for (let i = 0; i < 5; i++) await checkCreateInvoiceGate(reqFromIp('5.5.5.5'), env)
    // A distinct IP still gets through (separate per-IP counter).
    const d = await checkCreateInvoiceGate(reqFromIp('6.6.6.6'), env)
    expect(d.ok).toBe(true)
  })

  it('trips the global circuit breaker at the env limit across many IPs', async () => {
    const env = makeEnv({ CREATE_INVOICE_GLOBAL_LIMIT_PER_HOUR: '50' })
    let trippedAt = -1
    for (let i = 0; i < 100; i++) {
      const d = await checkCreateInvoiceGate(reqFromIp(`10.0.${Math.floor(i / 25)}.${i % 25}`), env)
      if (!d.ok && d.reason === 'global_circuit_open') {
        trippedAt = i
        expect(d.limit).toBe(50)
        break
      }
    }
    expect(trippedAt).toBe(50)
  })

  it('global default is 1500: 1500 creations across IPs pass, the 1501st trips', async () => {
    const env = makeEnv()
    for (let i = 0; i < 1500; i++) {
      const d = await checkCreateInvoiceGate(reqFromIp(`10.${Math.floor(i / 250)}.${Math.floor(i / 25) % 10}.${i % 25}`), env)
      expect(d.ok).toBe(true)
    }
    const d = await checkCreateInvoiceGate(reqFromIp('172.16.0.1'), env)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toBe('global_circuit_open')
  })

  it('fails OPEN when the Durable Object is unreachable', async () => {
    const badEnv = {
      ATOMIC_STORE: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }),
      },
    } as unknown as Env
    const d = await checkCreateInvoiceGate(reqFromIp('1.1.1.1'), badEnv)
    expect(d.ok).toBe(true) // gate never blocks create-invoice on infra error
  })

  it('makes exactly one Durable Object round trip per gate check', async () => {
    const store = makeDoStub()
    const env = makeEnv({ CREATE_INVOICE_GLOBAL_LIMIT_PER_HOUR: '2' }, store)
    await checkCreateInvoiceGate(reqFromIp('1.2.3.4'), env) // allowed
    expect(store.calls).toEqual(['/gate'])
    await checkCreateInvoiceGate(reqFromIp('1.2.3.4'), env) // allowed
    await checkCreateInvoiceGate(reqFromIp('1.2.3.4'), env) // global trip
    expect(store.calls).toEqual(['/gate', '/gate', '/gate'])
  })

  it('does not bump the per-IP counter once the global breaker has tripped', async () => {
    const store = makeDoStub()
    const env = makeEnv({ CREATE_INVOICE_GLOBAL_LIMIT_PER_HOUR: '1' }, store)
    expect((await checkCreateInvoiceGate(reqFromIp('1.2.3.4'), env)).ok).toBe(true)
    for (let i = 0; i < 3; i++) {
      const d = await checkCreateInvoiceGate(reqFromIp('1.2.3.4'), env)
      expect(!d.ok && d.reason).toBe('global_circuit_open')
    }
    const b = bucketNow()
    const read = await doJson(store, '/read', { key: `ci:ip:1.2.3.4:${b}` })
    expect(JSON.parse(read.body.value)).toEqual({ count: 1, bucket: b })
    const g = await doJson(store, '/read', { key: `ci:global:${b}` })
    expect(JSON.parse(g.body.value)).toEqual({ count: 4, bucket: b })
  })

  it('alerts only on the crossing call (limit+1), not on limit+2', async () => {
    const env = makeEnv({ CREATE_INVOICE_GLOBAL_LIMIT_PER_HOUR: '2' })
    await checkCreateInvoiceGate(reqFromIp('1.1.1.1'), env)
    await checkCreateInvoiceGate(reqFromIp('1.1.1.2'), env)
    expect(sendAlert).not.toHaveBeenCalled()
    await checkCreateInvoiceGate(reqFromIp('1.1.1.3'), env) // count 3 = limit+1
    expect(sendAlert).toHaveBeenCalledTimes(1)
    const d = await checkCreateInvoiceGate(reqFromIp('1.1.1.4'), env) // count 4 = limit+2
    expect(!d.ok && d.reason).toBe('global_circuit_open')
    expect(sendAlert).toHaveBeenCalledTimes(1)
  })

  it('fails OPEN on a malformed DO body (invalid JSON or wrong shape)', async () => {
    const notJson = badDoEnv(async () => new Response('not json', { status: 200 }))
    expect((await checkCreateInvoiceGate(reqFromIp('1.1.1.1'), notJson)).ok).toBe(true)
    const wrongShape = badDoEnv(async () => Response.json({ ok: true }))
    expect((await checkCreateInvoiceGate(reqFromIp('1.1.1.1'), wrongShape)).ok).toBe(true)
    const missingIp = badDoEnv(async () => Response.json({ globalCount: 1, ipCount: null }))
    expect((await checkCreateInvoiceGate(reqFromIp('1.1.1.1'), missingIp)).ok).toBe(true)
  })

  it('fails OPEN when the Durable Object throws', async () => {
    const env = badDoEnv(async () => {
      throw new Error('DO unavailable')
    })
    expect((await checkCreateInvoiceGate(reqFromIp('1.1.1.1'), env)).ok).toBe(true)
  })

  it('/gate counters are interchangeable with the old /read + /commit CAS counters', async () => {
    const store = makeDoStub()
    const b = bucketNow()
    const key = `ci:global:${b}`
    // Old Worker writes count 1 via CAS.
    expect((await doJson(store, '/commit', { key, expectedVersion: 0, op: 'set', value: JSON.stringify({ count: 1, bucket: b }) })).body).toEqual({ ok: true })
    // New Worker continues from it.
    const env = makeEnv({}, store)
    expect((await checkCreateInvoiceGate(reqFromIp('2.2.2.2'), env)).ok).toBe(true)
    const after = await doJson(store, '/read', { key })
    expect(JSON.parse(after.body.value)).toEqual({ count: 2, bucket: b })
    expect(after.body.version).toBe(2)
    // A counter from a previous bucket under the same key resets (old parseCounter semantics).
    const stale = makeDoStub()
    await doJson(stale, '/commit', { key, expectedVersion: 0, op: 'set', value: JSON.stringify({ count: 99, bucket: 'old' }) })
    const res = await doJson(stale, '/gate', { globalKey: key, ipKey: 'ci:ip:x:' + b, bucket: b, globalLimit: 10, ipLimit: 10 })
    expect(res.body).toEqual({ globalCount: 1, ipCount: 1 })
  })

  it('a stale old /commit racing a /gate loses the CAS and cannot overwrite the /gate increment', async () => {
    const store = makeDoStub()
    const b = bucketNow()
    const key = `ci:global:${b}`
    // Old Worker: /read (version 0, empty) ...
    const read = await doJson(store, '/read', { key })
    expect(read.body).toEqual({ value: null, version: 0 })
    // ... new Worker's /gate lands in between ...
    const gate = await doJson(store, '/gate', { globalKey: key, ipKey: `ci:ip:3.3.3.3:${b}`, bucket: b, globalLimit: 10, ipLimit: 10 })
    expect(gate.body).toEqual({ globalCount: 1, ipCount: 1 })
    // ... old Worker's /commit with the version it read is rejected.
    const commit = await doJson(store, '/commit', { key, expectedVersion: 0, op: 'set', value: JSON.stringify({ count: 1, bucket: b }) })
    expect(commit.body.ok).toBe(false)
    expect(commit.body.version).toBe(1)
    expect(JSON.parse(commit.body.value)).toEqual({ count: 1, bucket: b })
    // Its retry (as bumpCounter would) builds on the /gate count.
    const retry = await doJson(store, '/commit', { key, expectedVersion: 1, op: 'set', value: JSON.stringify({ count: 2, bucket: b }) })
    expect(retry.body).toEqual({ ok: true })
  })

  it('/gate rejects malformed bodies with 400', async () => {
    const store = makeDoStub()
    const ok = { globalKey: 'g', ipKey: 'i', bucket: '1', globalLimit: 5, ipLimit: 5 }
    for (const bad of [
      { ...ok, globalKey: '' },
      { ...ok, ipKey: 3 },
      { ...ok, bucket: '' },
      { ...ok, globalLimit: 0 },
      { ...ok, ipLimit: 1.5 },
      { ...ok, globalLimit: Number.POSITIVE_INFINITY },
      { ...ok, ipLimit: '5' },
    ]) {
      expect((await doJson(store, '/gate', bad)).status).toBe(400)
    }
    expect((await doJson(store, '/gate', ok)).status).toBe(200)
  })

  it('trusts only CF-Connecting-IP, never client-settable forwarding headers', () => {
    expect(clientIp(reqFromIp('4.4.4.4'))).toBe('4.4.4.4')
    const xff = new Request('https://x/', { headers: { 'X-Forwarded-For': '8.8.8.8, 9.9.9.9', 'X-Real-IP': '7.7.7.7' } })
    expect(clientIp(xff)).toBe('unknown')
    const both = new Request('https://x/', { headers: { 'CF-Connecting-IP': '4.4.4.4', 'X-Forwarded-For': '8.8.8.8' } })
    expect(clientIp(both)).toBe('4.4.4.4')
    expect(clientIp(new Request('https://x/'))).toBe('unknown')
  })
})
