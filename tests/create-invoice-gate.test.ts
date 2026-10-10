import { describe, it, expect } from 'vitest'
import {
  checkCreateInvoiceGate,
  clientIp,
  resolveGateLimits,
  DEFAULT_IP_LIMIT_PER_HOUR,
  DEFAULT_GLOBAL_LIMIT_PER_HOUR,
} from '../src/routes/create-invoice-gate'
import type { Env } from '../src/index'

// Minimal AtomicStoreDO stub speaking the /read + /commit CAS protocol, matching
// the real DO's semantics (optimistic concurrency by version). Shared across all
// keys so global + per-IP counters accumulate like production.
function makeDoStub() {
  const store = new Map<string, string>()
  const versions = new Map<string, number>()
  const stub = {
    async fetch(req: Request) {
      const url = new URL(req.url)
      const b: any = await req.json()
      if (url.pathname === '/read') {
        return Response.json({ value: store.get(b.key) ?? null, version: versions.get(b.key) ?? 0 })
      }
      const cur = versions.get(b.key) ?? 0
      if (cur !== b.expectedVersion) {
        return Response.json({ ok: false, value: store.get(b.key) ?? null, version: cur })
      }
      if (b.op === 'set') store.set(b.key, b.value)
      else store.delete(b.key)
      versions.set(b.key, b.expectedVersion + 1)
      return Response.json({ ok: true })
    },
  }
  return { idFromName: (n: string) => ({ name: n }), get: () => stub }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ATOMIC_STORE: makeDoStub(),
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

  it('trusts only CF-Connecting-IP, never client-settable forwarding headers', () => {
    expect(clientIp(reqFromIp('4.4.4.4'))).toBe('4.4.4.4')
    const xff = new Request('https://x/', { headers: { 'X-Forwarded-For': '8.8.8.8, 9.9.9.9', 'X-Real-IP': '7.7.7.7' } })
    expect(clientIp(xff)).toBe('unknown')
    const both = new Request('https://x/', { headers: { 'CF-Connecting-IP': '4.4.4.4', 'X-Forwarded-For': '8.8.8.8' } })
    expect(clientIp(both)).toBe('4.4.4.4')
    expect(clientIp(new Request('https://x/'))).toBe('unknown')
  })
})
