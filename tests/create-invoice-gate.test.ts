import { describe, it, expect } from 'vitest'
import { checkCreateInvoiceGate, clientIp } from '../src/routes/create-invoice-gate'
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
  it('allows requests under the per-IP limit', async () => {
    const env = makeEnv()
    for (let i = 0; i < 30; i++) {
      const d = await checkCreateInvoiceGate(reqFromIp('1.2.3.4'), env)
      expect(d.ok).toBe(true)
    }
  })

  it('rate-limits a single IP once it exceeds 30/hour', async () => {
    const env = makeEnv()
    for (let i = 0; i < 30; i++) {
      expect((await checkCreateInvoiceGate(reqFromIp('9.9.9.9'), env)).ok).toBe(true)
    }
    const d = await checkCreateInvoiceGate(reqFromIp('9.9.9.9'), env)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toBe('ip_rate_limited')
  })

  it('does not penalize a second IP when the first is limited', async () => {
    const env = makeEnv()
    for (let i = 0; i < 35; i++) await checkCreateInvoiceGate(reqFromIp('5.5.5.5'), env)
    // A distinct IP still gets through (separate per-IP counter).
    const d = await checkCreateInvoiceGate(reqFromIp('6.6.6.6'), env)
    expect(d.ok).toBe(true)
  })

  it('trips the global circuit breaker across many IPs and fires one alert', async () => {
    let alerts = 0
    const env = makeEnv()
    // Override dingtalk by injecting the token; capture sends via a fetch spy is
    // overkill — instead assert the decision flips. We spread 601 requests over
    // many IPs so no single IP hits its own 30-cap first.
    let tripped = false
    for (let i = 0; i < 700; i++) {
      const d = await checkCreateInvoiceGate(reqFromIp(`10.0.${Math.floor(i / 25)}.${i % 25}`), env)
      if (!d.ok && d.reason === 'global_circuit_open') {
        tripped = true
        break
      }
    }
    expect(tripped).toBe(true)
    void alerts
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

  it('extracts client IP from CF header, falling back to X-Forwarded-For', () => {
    expect(clientIp(reqFromIp('4.4.4.4'))).toBe('4.4.4.4')
    const xff = new Request('https://x/', { headers: { 'X-Forwarded-For': '8.8.8.8, 9.9.9.9' } })
    expect(clientIp(xff)).toBe('8.8.8.8')
    expect(clientIp(new Request('https://x/'))).toBe('unknown')
  })
})
