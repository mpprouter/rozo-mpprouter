import { describe, it, expect } from 'vitest'
import {
  evaluateTraffic,
  readCircuit,
  reopenCircuit,
  checkFreezes,
  bumpFailure,
  auditEvent,
  maybePruneAudit,
  WARN_THRESHOLD,
  CIRCUIT_THRESHOLD,
  FAIL_THRESHOLD,
  PAIR_FREEZE_MS,
  AUDIT_RETENTION_MS,
  type CasClient,
} from '../src/routes/coupon-security'
import type { Env } from '../src/index'

// ── In-memory CasClient (models the coupon DO's linearizable CAS) ────────────
function makeCas(): CasClient {
  const store = new Map<string, { value: string; version: number }>()
  return {
    async casUpdate(key, fn, maxRetries = 25) {
      for (let i = 0; i < maxRetries; i++) {
        const cur = store.get(key) ?? { value: null as string | null, version: 0 }
        const change = fn(cur.value)
        if (change.op === 'noop') return change.result
        // Single-threaded here, so the version always matches — commit.
        store.set(key, { value: change.value, version: cur.version + 1 })
        return change.result
      }
      throw new Error('cas exhausted')
    },
    async casRead(key) {
      return store.get(key)?.value ?? null
    },
  }
}

const IDS = (n: number) => ({
  code: `code${n}`,
  paymentId: `pid${n}`,
  pair: `pair${n}`,
  ipPrefix: `ip${n}`,
})

// ── FakeD1 for audit tests ───────────────────────────────────────────────────
function makeD1() {
  const rows: any[] = []
  const db: any = {
    prepare(sql: string) {
      let args: any[] = []
      return {
        bind(...a: any[]) { args = a; return this },
        async run() {
          if (/INSERT/i.test(sql)) {
            const [request_id, created_at, result, failure_reason, code_hash, payment_id_hash, pair_hash, ip_prefix_hash, turnstile_passed] = args
            if (rows.some((r) => r.request_id === request_id)) return { success: true }
            rows.push({ request_id, created_at, result, failure_reason, code_hash, payment_id_hash, pair_hash, ip_prefix_hash, turnstile_passed })
          } else if (/DELETE/i.test(sql)) {
            const cutoff = args[0]
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i].created_at < cutoff) rows.splice(i, 1)
          }
          return { success: true }
        },
      }
    },
  }
  return { db, rows }
}

describe('rolling-window traffic gate', () => {
  it('allows up to the warn threshold in 1 min, warns on the next', async () => {
    const cas = makeCas()
    const now = 1_000_000
    // WARN_THRESHOLD allowed with no warn.
    for (let i = 0; i < WARN_THRESHOLD; i++) {
      const d = await evaluateTraffic(cas, now + i) // distinct ts within 1 min
      expect(d.action).toBe('proceed')
      if (d.action === 'proceed') expect(d.warnFired).toBe(false)
    }
    // The threshold+1'th request in the window fires the warning exactly once.
    const warn = await evaluateTraffic(cas, now + WARN_THRESHOLD)
    expect(warn.action).toBe('proceed')
    if (warn.action === 'proceed') expect(warn.warnFired).toBe(true)
    // A subsequent over-threshold request in the same 1-min window does NOT
    // re-fire the warning (deduped).
    const warn2 = await evaluateTraffic(cas, now + WARN_THRESHOLD + 1)
    if (warn2.action === 'proceed') expect(warn2.warnFired).toBe(false)
  })

  it('the rolling 1-min window slides — old requests age out', async () => {
    const cas = makeCas()
    // Fill the window, then jump >1 min forward: the counter resets, no warn.
    for (let i = 0; i < WARN_THRESHOLD; i++) await evaluateTraffic(cas, 1_000 + i)
    const later = await evaluateTraffic(cas, 1_000 + 61_000)
    expect(later.action).toBe('proceed')
    if (later.action === 'proceed') expect(later.warnFired).toBe(false)
  })

  it('opens the circuit on the 101st request in 10 min, before any payment', async () => {
    const cas = makeCas()
    const now = 5_000_000
    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
      const d = await evaluateTraffic(cas, now + i)
      expect(d.action).toBe('proceed')
    }
    const open = await evaluateTraffic(cas, now + CIRCUIT_THRESHOLD)
    expect(open.action).toBe('circuit_open')
    if (open.action === 'circuit_open') expect(open.justOpened).toBe(true)
  })
})

describe('concurrency cannot bypass the rolling windows', () => {
  // A serialized (single-threaded, like the real DO) CAS store: concurrent
  // evaluateTraffic calls must NOT both read the same count and each think they
  // are under the threshold. Exactly one call may cross the boundary.
  function serialCas(): CasClient {
    const store = new Map<string, { value: string; version: number }>()
    let tail: Promise<unknown> = Promise.resolve()
    const readWrite = async <R>(key: string, fn: (v: string | null) => any): Promise<R> => {
      const cur = store.get(key) ?? { value: null as string | null, version: 0 }
      const change = fn(cur.value)
      if (change.op === 'set') store.set(key, { value: change.value, version: cur.version + 1 })
      return change.result
    }
    return {
      casUpdate(key, fn) {
        const run = tail.then(() => readWrite(key, fn as any))
        tail = run.catch(() => {})
        return run as any
      },
      async casRead(key) {
        const run = tail.then(() => store.get(key)?.value ?? null)
        tail = run.catch(() => {})
        return run
      },
    }
  }

  it('opens the circuit exactly once even when all requests fire concurrently', async () => {
    const cas = serialCas()
    const now = 12_000_000
    // Fire CIRCUIT_THRESHOLD + 30 requests concurrently at distinct timestamps.
    const results = await Promise.all(
      Array.from({ length: CIRCUIT_THRESHOLD + 30 }, (_, i) => evaluateTraffic(cas, now + i)),
    )
    const opens = results.filter((r) => r.action === 'circuit_open')
    const justOpened = opens.filter((r) => r.action === 'circuit_open' && r.justOpened)
    // The breaker opens exactly once, and everything past the threshold is blocked.
    expect(justOpened.length).toBe(1)
    expect(opens.length).toBeGreaterThanOrEqual(30)
    // No more than CIRCUIT_THRESHOLD requests were allowed to proceed.
    const proceeded = results.filter((r) => r.action === 'proceed')
    expect(proceeded.length).toBeLessThanOrEqual(CIRCUIT_THRESHOLD)
  })
})

describe('circuit breaker persistence + admin recovery', () => {
  it('an open circuit stays open across a fresh evaluation (new isolate) and blocks', async () => {
    const cas = makeCas()
    // Trip it.
    for (let i = 0; i <= CIRCUIT_THRESHOLD; i++) await evaluateTraffic(cas, 6_000_000 + i)
    expect((await readCircuit(cas)).open).toBe(true)
    // A brand-new evaluation (simulating a fresh Worker isolate — state read
    // from the durable store, not process memory) still sees it open and
    // blocks WITHOUT counting/paying.
    const d = await evaluateTraffic(cas, 6_100_000)
    expect(d.action).toBe('circuit_open')
    if (d.action === 'circuit_open') expect(d.justOpened).toBe(false)
  })

  it('only justOpened fires once; subsequent circuit-open requests do not', async () => {
    const cas = makeCas()
    let opens = 0
    for (let i = 0; i <= CIRCUIT_THRESHOLD + 5; i++) {
      const d = await evaluateTraffic(cas, 7_000_000 + i)
      if (d.action === 'circuit_open' && d.justOpened) opens++
    }
    expect(opens).toBe(1)
  })

  it('admin reopen clears the circuit and reports the prior state', async () => {
    const cas = makeCas()
    for (let i = 0; i <= CIRCUIT_THRESHOLD; i++) await evaluateTraffic(cas, 8_000_000 + i)
    const prior = await reopenCircuit(cas, 8_500_000)
    expect(prior.open).toBe(true)
    expect((await readCircuit(cas)).open).toBe(false)
    // After reopen, traffic proceeds again.
    const d = await evaluateTraffic(cas, 8_600_000)
    expect(d.action).toBe('proceed')
  })

  it('reopen on an already-closed circuit reports wasOpen=false (auditable no-op)', async () => {
    const cas = makeCas()
    const prior = await reopenCircuit(cas, 9_000_000)
    expect(prior.open).toBe(false)
  })
})

describe('per-identifier freezes (temporary, no permanent void)', () => {
  it('freezes a pair for 1h after 5 failures but NOT before', async () => {
    const cas = makeCas()
    const ids = IDS(1)
    const t0 = 10_000_000
    for (let i = 0; i < FAIL_THRESHOLD - 1; i++) await bumpFailure(cas, ids, t0 + i)
    // 4 failures → still clear.
    expect(await checkFreezes(cas, ids, t0 + 100)).toBeNull()
    const fifthAt = t0 + 5
    await bumpFailure(cas, ids, fifthAt) // 5th
    expect(await checkFreezes(cas, ids, fifthAt + 200)).toBe('pair')
    // Freeze is temporary — it lifts PAIR_FREEZE_MS after it was set.
    expect(await checkFreezes(cas, ids, fifthAt + PAIR_FREEZE_MS + 1)).toBeNull()
  })

  it('an attacker cannot prolong a victim identifier freeze by hammering it', async () => {
    const cas = makeCas()
    const ids = IDS(2)
    const t0 = 20_000_000
    for (let i = 0; i < FAIL_THRESHOLD; i++) await bumpFailure(cas, ids, t0 + i)
    const setAt = t0 + (FAIL_THRESHOLD - 1) // freeze set on the 5th bump (i=4)
    const frozenAt = t0 + 10
    expect(await checkFreezes(cas, ids, frozenAt)).toBe('pair')
    // Keep hammering DURING the freeze — must not extend frozenUntil.
    for (let i = 0; i < 20; i++) await bumpFailure(cas, ids, frozenAt + i)
    // Still lifts at the ORIGINAL deadline (set on the 5th bump), not later.
    expect(await checkFreezes(cas, ids, setAt + PAIR_FREEZE_MS + 1)).toBeNull()
  })

  it('reports the most specific frozen dimension (pair before ip)', async () => {
    const cas = makeCas()
    const ids = IDS(3)
    const t0 = 30_000_000
    for (let i = 0; i < FAIL_THRESHOLD; i++) await bumpFailure(cas, ids, t0 + i)
    expect(await checkFreezes(cas, ids, t0 + 1)).toBe('pair')
  })
})

describe('D1 audit writer', () => {
  const env = (db: any) => ({ COUPON_SECURITY_DB: db }) as unknown as Env

  it('appends a redacted row and is idempotent on request_id', async () => {
    const { db, rows } = makeD1()
    const ev = {
      requestId: 'req-1', createdAt: 1, result: 'failure' as const, failureReason: 'invalid_coupon',
      codeHash: 'ch', paymentIdHash: 'ph', pairHash: 'prh', ipPrefixHash: 'iph', turnstilePassed: false,
    }
    await auditEvent(env(db), ev)
    await auditEvent(env(db), ev) // duplicate → INSERT OR IGNORE
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ result: 'failure', code_hash: 'ch', turnstile_passed: 0 })
  })

  it('is a silent no-op when no D1 binding is configured', async () => {
    await expect(
      auditEvent({} as unknown as Env, {
        requestId: 'x', createdAt: 1, result: 'success', failureReason: null,
        codeHash: null, paymentIdHash: null, pairHash: null, ipPrefixHash: 'iph', turnstilePassed: true,
      }),
    ).resolves.toBeUndefined()
  })

  it('prune deletes rows older than the retention window when sampled', async () => {
    const { db, rows } = makeD1()
    const now = 100_000_000
    rows.push({ request_id: 'old', created_at: now - AUDIT_RETENTION_MS - 1 })
    rows.push({ request_id: 'new', created_at: now })
    await maybePruneAudit(env(db), now, 0.0) // force the sample to run
    expect(rows.map((r) => r.request_id)).toEqual(['new'])
  })

  it('prune does nothing when the sample misses (common path pays nothing)', async () => {
    const { db, rows } = makeD1()
    rows.push({ request_id: 'old', created_at: 0 })
    await maybePruneAudit(env(db), 1e12, 0.99) // sample >= 0.01 → skip
    expect(rows.length).toBe(1)
  })
})
