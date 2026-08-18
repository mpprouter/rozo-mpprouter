import { describe, it, expect } from 'vitest'
import {
  parseXlmToStroops,
  formatStroopsAsXlm,
  classify,
  decideTransition,
  checkGasSponsor,
  GAS_SPONSOR_LOW_THRESHOLD_STROOPS,
  UNREADABLE_ALERT_AFTER,
  type PersistedState,
} from './stellar-gas-balance'

/** Build a persisted state without repeating the defaults everywhere. */
function st(partial: Partial<PersistedState> = {}): PersistedState {
  return { substantive: null, unreadableStreak: 0, unreadableAlerted: false, ...partial }
}

const ADDR = 'GB5LCXFTBHXJ32XQBHX4EQKQPCHZRHU3XXHHN54QE3O3QTAN6RQZ3XEE'

/** Minimal in-memory KV, enough for the state machine. */
function fakeKv(initial?: PersistedState) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set('gas-sponsor:last-alert-state', JSON.stringify(initial))
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
    // Alerts only after the streak threshold, so one blip stays quiet.
    const d = decideTransition(
      st({ substantive: 'ok', unreadableStreak: UNREADABLE_ALERT_AFTER - 1 }),
      { stroops: null, reason: 'horizon returned 503' },
      ADDR,
    )
    expect(d.shouldAlert).toBe(true)
    expect(d.message).toContain('unreadable for')
    expect(d.message).toContain('NOT a report that the balance is low')
    expect(d.message).toContain('503')
    // Must not read as a drain.
    expect(d.message).not.toContain('0 XLM')
  })
})

describe('alerts fire on transition, not on level', () => {
  it('stays silent while the condition persists', () => {
    expect(decideTransition(st({ substantive: 'low' }), { stroops: 1n, reason: '' }, ADDR).shouldAlert).toBe(false)
    expect(decideTransition(st({ substantive: 'ok' }), { stroops: 999_000_000_000n, reason: '' }, ADDR).shouldAlert).toBe(false)
    // Already told them it is unreadable → do not repeat.
    expect(decideTransition(
      st({ unreadableStreak: 40, unreadableAlerted: true }), { stroops: null, reason: 'x' }, ADDR,
    ).shouldAlert).toBe(false)
  })

  it('alerts when crossing into low', () => {
    const d = decideTransition(st({ substantive: 'ok' }), { stroops: 50_000_000n, reason: '' }, ADDR)
    expect(d.shouldAlert).toBe(true)
    expect(d.message).toContain('low balance: 5 XLM')
    expect(d.message).toContain(ADDR)
    // The operator needs to know what breaks, not just that a number is small.
    expect(d.message).toContain('settlement, channel close and refunds')
  })

  it('announces recovery, so nobody has to go and check', () => {
    const d = decideTransition(st({ substantive: 'low' }), { stroops: 200_000_000n, reason: '' }, ADDR)
    expect(d.shouldAlert).toBe(true)
    expect(d.message).toContain('recovered: 20 XLM')
  })

  it('does not announce a healthy account on first ever observation', () => {
    expect(decideTransition(st(), { stroops: 999_000_000n, reason: '' }, ADDR).shouldAlert).toBe(false)
  })

  it('DOES announce a low account on first ever observation', () => {
    expect(decideTransition(st(), { stroops: 1n, reason: '' }, ADDR).shouldAlert).toBe(true)
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
        if (r) { alerts++; await r.commit() }   // caller commits after sending
      }
    } finally {
      globalThis.fetch = realFetch
    }

    expect(alerts).toBe(1)
    expect(JSON.parse(store.get('gas-sponsor:last-alert-state')!).substantive).toBe('low')
  })

  it('alerts again after recovering and dropping a second time', () => {
    const seq: Array<[PersistedState, bigint]> = [
      [st(),                        1n],            // low       -> alert
      [st({ substantive: 'low' }),  1n],            // still low -> silent
      [st({ substantive: 'low' }),  500_000_000n],  // recovered -> alert
      [st({ substantive: 'ok' }),   500_000_000n],  // still ok  -> silent
      [st({ substantive: 'ok' }),   1n],            // low again -> alert
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

  /**
   * Run the tick until it produces an alert, up to `max` times, committing as
   * a real caller would. Returns the alert or null.
   *
   * Needed because an unreadable balance no longer alerts on the first failed
   * read — it waits for a streak, so one Horizon blip stays quiet.
   */
  async function tickUntilAlert(kv: KVNamespace, address: string | undefined, horizonUrl: string | undefined, max = UNREADABLE_ALERT_AFTER + 1) {
    for (let i = 0; i < max; i++) {
      const r = await checkGasSponsor({ kv, horizonUrl, address })
      if (r) { await r.commit(); return r }
    }
    return null
  }

  it('distinguishes an unfunded account from a read failure', async () => {
    const { kv } = fakeKv(st({ substantive: 'ok' }))
    await withFetch((async () => new Response('', { status: 404 })) as typeof fetch, async () => {
      const r = await tickUntilAlert(kv, ADDR, 'https://h.example')
      expect(r?.message).toContain('never funded, or wrong network')
    })
  })

  it('treats a 5xx as unreadable, not as zero', async () => {
    const { kv } = fakeKv(st({ substantive: 'ok' }))
    await withFetch((async () => new Response('upstream down', { status: 503 })) as typeof fetch, async () => {
      const r = await tickUntilAlert(kv, ADDR, 'https://h.example')
      expect(r?.message).toContain('503')
      expect(r?.message).not.toContain('low balance')
    })
  })

  it('treats a non-JSON body as unreadable', async () => {
    const { kv } = fakeKv(st({ substantive: 'ok' }))
    await withFetch((async () => new Response('<html>nope</html>', { status: 200 })) as typeof fetch, async () => {
      const r = await tickUntilAlert(kv, ADDR, 'https://h.example')
      expect(r?.message).toContain('not JSON')
    })
  })

  it('treats a missing native balance line as unreadable', async () => {
    const { kv } = fakeKv(st({ substantive: 'ok' }))
    const body = JSON.stringify({ balances: [{ asset_type: 'credit_alphanum4', balance: '5.0' }] })
    await withFetch((async () => new Response(body, { status: 200 })) as typeof fetch, async () => {
      const r = await tickUntilAlert(kv, ADDR, 'https://h.example')
      expect(r?.message).toContain('no native balance line')
    })
  })

  it('is unreadable — not low — when nothing is configured', async () => {
    const r = await tickUntilAlert(fakeKv(st({ substantive: 'ok' })).kv, ADDR, undefined)
    expect(r?.message).toContain('horizon url not configured')

    const r2 = await tickUntilAlert(fakeKv(st({ substantive: 'ok' })).kv, undefined, 'https://h.example')
    expect(r2?.message).toContain('gas sponsor address not configured')
  })

  it('reads a healthy balance and stays quiet', async () => {
    const { kv, store } = fakeKv()
    const body = JSON.stringify({ balances: [{ asset_type: 'native', balance: '250.0000000' }] })
    await withFetch((async () => new Response(body, { status: 200 })) as typeof fetch, async () => {
      const r = await checkGasSponsor({ kv, horizonUrl: 'https://h.example', address: ADDR })
      expect(r).toBeNull()
      expect(JSON.parse(store.get('gas-sponsor:last-alert-state')!).substantive).toBe('ok')
    })
  })

  // Codex review finding: one intermittent Horizon blip must not re-raise an
  // unchanged low balance. low -> unreadable -> low is ONE alert, not three.
  it('does not re-alert a low balance across an intermittent read failure', async () => {
    const { kv } = fakeKv()
    let mode: 'low' | 'fail' = 'low'
    let alerts = 0
    const real = globalThis.fetch
    globalThis.fetch = (async () =>
      mode === 'low'
        ? new Response(JSON.stringify({ balances: [{ asset_type: 'native', balance: '1.0' }] }), { status: 200 })
        : new Response('', { status: 503 })) as typeof fetch

    try {
      for (const m of ['low', 'low', 'fail', 'fail', 'low', 'low', 'fail', 'low'] as const) {
        mode = m
        const r = await checkGasSponsor({ kv, horizonUrl: 'https://h.example', address: ADDR })
        if (r) { alerts++; await r.commit() }
      }
    } finally {
      globalThis.fetch = real
    }

    expect(alerts).toBe(1)
  })

  // Codex review finding: committing before the alert is delivered would dedupe
  // every later attempt and leave the monitor permanently silent.
  it('retries on the next tick when the caller fails to send', async () => {
    const { kv } = fakeKv()
    const real = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ balances: [{ asset_type: 'native', balance: '1.0' }] }), { status: 200 })) as typeof fetch

    try {
      // First tick produces an alert; the caller "fails to send" so never commits.
      const first = await checkGasSponsor({ kv, horizonUrl: 'https://h.example', address: ADDR })
      expect(first).not.toBeNull()

      // Second tick must offer it again rather than treating it as delivered.
      const second = await checkGasSponsor({ kv, horizonUrl: 'https://h.example', address: ADDR })
      expect(second).not.toBeNull()
      await second!.commit()

      // Now it is committed, so it goes quiet.
      const third = await checkGasSponsor({ kv, horizonUrl: 'https://h.example', address: ADDR })
      expect(third).toBeNull()
    } finally {
      globalThis.fetch = real
    }
  })

  it('reports a timeout distinctly from an unreachable host', async () => {
    const { kv } = fakeKv(st({ substantive: 'ok' }))
    const real = globalThis.fetch
    globalThis.fetch = (async () => {
      const e = new Error('The operation was aborted')
      e.name = 'TimeoutError'
      throw e
    }) as typeof fetch
    try {
      const r = await tickUntilAlert(kv, ADDR, 'https://h.example')
      expect(r?.message).toContain('timed out after')
    } finally {
      globalThis.fetch = real
    }
  })
})
