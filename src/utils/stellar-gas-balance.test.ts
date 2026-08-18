import { describe, it, expect } from 'vitest'
import {
  parseXlmToStroops,
  formatStroopsAsXlm,
  classify,
  decideTransition,
  checkGasSponsor,
  GAS_SPONSOR_LOW_THRESHOLD_STROOPS,
  type GasSponsorState,
} from './stellar-gas-balance'

const ADDR = 'GB5LCXFTBHXJ32XQBHX4EQKQPCHZRHU3XXHHN54QE3O3QTAN6RQZ3XEE'

/** Minimal in-memory KV, enough for the state machine. */
function fakeKv(initial?: string) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set('gas-sponsor:last-alert-state', initial)
  return {
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace,
    store,
  }
}

describe('parsing balances exactly', () => {
  it('parses whole and fractional XLM without float error', () => {
    expect(parseXlmToStroops('1')).toBe(10_000_000n)
    expect(parseXlmToStroops('0.1')).toBe(1_000_000n)
    expect(parseXlmToStroops('123.4567890')).toBe(1_234_567_890n)
    expect(parseXlmToStroops('0.0000001')).toBe(1n)
  })

  it('round-trips through the formatter', () => {
    for (const v of ['0', '1', '0.1', '123.456789', '9999.9999999']) {
      expect(formatStroopsAsXlm(parseXlmToStroops(v)!)).toBe(v === '0' ? '0' : v.replace(/0+$/, '').replace(/\.$/, ''))
    }
  })

  // The specific bug this guards: `Number(malformed) || 0` once manufactured a
  // legitimate-looking zero from an unreadable value, producing a full-drain
  // alert for an account that had not moved.
  it('returns null — never 0 — for anything malformed', () => {
    for (const bad of ['', ' ', 'abc', '-1', '1.2.3', 'NaN', 'Infinity', '1e7', '0x10', '1.23456789']) {
      expect(parseXlmToStroops(bad)).toBeNull()
    }
  })
})

describe('an unreadable balance is never "low"', () => {
  it('classifies null as its own state', () => {
    expect(classify({ stroops: null, reason: 'horizon returned 503' })).toBe('unreadable')
    expect(classify({ stroops: 0n, reason: '' })).toBe('low')
    expect(classify({ stroops: GAS_SPONSOR_LOW_THRESHOLD_STROOPS, reason: '' })).toBe('ok')
    expect(classify({ stroops: GAS_SPONSOR_LOW_THRESHOLD_STROOPS - 1n, reason: '' })).toBe('low')
  })

  it('says "could not read" rather than implying the account is empty', () => {
    const d = decideTransition('ok', { stroops: null, reason: 'horizon returned 503' }, ADDR)
    expect(d.shouldAlert).toBe(true)
    expect(d.message).toContain('could not be read')
    expect(d.message).toContain('NOT a report that the balance is low')
    expect(d.message).toContain('503')
    // Must not read as a drain.
    expect(d.message).not.toContain('0 XLM')
  })
})

describe('alerts fire on transition, not on level', () => {
  it('stays silent while the condition persists', () => {
    const low = { stroops: 1n, reason: '' }
    expect(decideTransition('low', low, ADDR).shouldAlert).toBe(false)
    expect(decideTransition('ok', { stroops: 999_000_000_000n, reason: '' }, ADDR).shouldAlert).toBe(false)
    expect(decideTransition('unreadable', { stroops: null, reason: 'x' }, ADDR).shouldAlert).toBe(false)
  })

  it('alerts when crossing into low', () => {
    const d = decideTransition('ok', { stroops: 50_000_000n, reason: '' }, ADDR)
    expect(d.shouldAlert).toBe(true)
    expect(d.message).toContain('low balance: 5 XLM')
    expect(d.message).toContain(ADDR)
    // The operator needs to know what breaks, not just that a number is small.
    expect(d.message).toContain('settlement, channel close and refunds')
  })

  it('announces recovery, so nobody has to go and check', () => {
    const d = decideTransition('low', { stroops: 200_000_000n, reason: '' }, ADDR)
    expect(d.shouldAlert).toBe(true)
    expect(d.message).toContain('recovered: 20 XLM')
  })

  it('does not announce a healthy account on first ever observation', () => {
    expect(decideTransition(null, { stroops: 999_000_000n, reason: '' }, ADDR).shouldAlert).toBe(false)
  })

  it('DOES announce a low account on first ever observation', () => {
    expect(decideTransition(null, { stroops: 1n, reason: '' }, ADDR).shouldAlert).toBe(true)
  })

  // The concrete anti-spam property: 720 ticks a day against one unresolved
  // condition must produce exactly one alert.
  it('sends one alert across many ticks of an unchanged condition', async () => {
    const { kv, store } = fakeKv()
    let alerts = 0
    const horizon = 'https://horizon.example.org'
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ balances: [{ asset_type: 'native', balance: '1.0000000' }] }), {
        status: 200,
      })) as typeof fetch

    try {
      for (let i = 0; i < 30; i++) {
        const r = await checkGasSponsor({ kv, horizonUrl: horizon, address: ADDR })
        if (r) alerts++
      }
    } finally {
      globalThis.fetch = realFetch
    }

    expect(alerts).toBe(1)
    expect(store.get('gas-sponsor:last-alert-state')).toBe('low')
  })

  it('alerts again after recovering and dropping a second time', () => {
    const seq: Array<[GasSponsorState | null, bigint | null]> = [
      [null, 1n],            // low      -> alert
      ['low', 1n],           // still low-> silent
      ['low', 500_000_000n], // recovered-> alert
      ['ok', 500_000_000n],  // still ok -> silent
      ['ok', 1n],            // low again-> alert
    ]
    const fired = seq.map(([prev, stroops]) =>
      decideTransition(prev, { stroops, reason: '' }, ADDR).shouldAlert,
    )
    expect(fired).toEqual([true, false, true, false, true])
  })
})

describe('reading from horizon', () => {
  async function withFetch(impl: typeof fetch, fn: () => Promise<void>) {
    const real = globalThis.fetch
    globalThis.fetch = impl
    try { await fn() } finally { globalThis.fetch = real }
  }

  it('distinguishes an unfunded account from a read failure', async () => {
    const { kv } = fakeKv('ok')
    await withFetch((async () => new Response('', { status: 404 })) as typeof fetch, async () => {
      const r = await checkGasSponsor({ kv, horizonUrl: 'https://h.example', address: ADDR })
      expect(r?.state).toBe('unreadable')
      expect(r?.message).toContain('never funded, or wrong network')
    })
  })

  it('treats a 5xx as unreadable, not as zero', async () => {
    const { kv } = fakeKv('ok')
    await withFetch((async () => new Response('upstream down', { status: 503 })) as typeof fetch, async () => {
      const r = await checkGasSponsor({ kv, horizonUrl: 'https://h.example', address: ADDR })
      expect(r?.state).toBe('unreadable')
      expect(r?.message).not.toContain('low balance')
    })
  })

  it('treats a non-JSON body as unreadable', async () => {
    const { kv } = fakeKv('ok')
    await withFetch((async () => new Response('<html>nope</html>', { status: 200 })) as typeof fetch, async () => {
      const r = await checkGasSponsor({ kv, horizonUrl: 'https://h.example', address: ADDR })
      expect(r?.state).toBe('unreadable')
    })
  })

  it('treats a missing native balance line as unreadable', async () => {
    const { kv } = fakeKv('ok')
    const body = JSON.stringify({ balances: [{ asset_type: 'credit_alphanum4', balance: '5.0' }] })
    await withFetch((async () => new Response(body, { status: 200 })) as typeof fetch, async () => {
      const r = await checkGasSponsor({ kv, horizonUrl: 'https://h.example', address: ADDR })
      expect(r?.state).toBe('unreadable')
    })
  })

  it('is unreadable — not low — when nothing is configured', async () => {
    // Separate KVs on purpose: sharing one would have the second call see the
    // first call's 'unreadable' state and correctly stay silent, which would
    // test the dedup rather than the missing-config handling.
    const r = await checkGasSponsor({ kv: fakeKv('ok').kv, horizonUrl: undefined, address: ADDR })
    expect(r?.state).toBe('unreadable')
    expect(r?.message).toContain('horizon url not configured')

    const r2 = await checkGasSponsor({ kv: fakeKv('ok').kv, horizonUrl: 'https://h.example', address: undefined })
    expect(r2?.state).toBe('unreadable')
    expect(r2?.message).toContain('gas sponsor address not configured')
  })

  it('reads a healthy balance and stays quiet', async () => {
    const { kv, store } = fakeKv()
    const body = JSON.stringify({ balances: [{ asset_type: 'native', balance: '250.0000000' }] })
    await withFetch((async () => new Response(body, { status: 200 })) as typeof fetch, async () => {
      const r = await checkGasSponsor({ kv, horizonUrl: 'https://h.example', address: ADDR })
      expect(r).toBeNull()
      expect(store.get('gas-sponsor:last-alert-state')).toBe('ok')
    })
  })
})
