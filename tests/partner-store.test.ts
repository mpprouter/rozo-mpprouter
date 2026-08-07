import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getOrCreatePartnerByEmail,
  getPartner,
  getPartnerIdByEmail,
  issuePartnerCoupon,
  listPartnerCoupons,
  newOpId,
  normalizeEmail,
  partnerKey,
  readLedger,
  reconcilePending,
  topupPartner,
  voidPartnerCoupon,
  PartnerError,
  ledgerKey,
} from '../src/routes/partner-store'
import { casRead, casUpdate, couponKey, generateCouponCode, parseRecord } from '../src/routes/coupon'
import type { Env } from '../src/index'

// ── Fakes ────────────────────────────────────────────────────────────────────

/**
 * Stand-in for AtomicStoreDO. Copied from coupon.test.ts on purpose: a real
 * Durable Object serialises every fetch, and a fake that does NOT model that
 * lets two CAS clients interleave read/commit and both "win" — a bypass that
 * cannot happen in production and would make these tests lie.
 */
class FakeAtomicDO {
  store = new Map<string, { value: string | null; version: number }>()
  private tail: Promise<unknown> = Promise.resolve()

  fetch(req: Request): Promise<Response> {
    const run = this.tail.then(() => this._fetch(req))
    this.tail = run.catch(() => {})
    return run
  }

  private async _fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const body: any = await req.json()
    const cur = this.store.get(body.key) ?? { value: null, version: 0 }
    if (url.pathname === '/read') {
      return Response.json({ value: cur.value, version: cur.version })
    }
    if (url.pathname === '/commit') {
      if (cur.version !== body.expectedVersion) {
        return Response.json({ ok: false, value: cur.value, version: cur.version })
      }
      this.store.set(body.key, { value: body.value, version: cur.version + 1 })
      return Response.json({ ok: true })
    }
    return new Response('Not Found', { status: 404 })
  }
}

class FakeNamespace {
  instances = new Map<string, FakeAtomicDO>()
  idFromName(name: string) {
    return name
  }
  get(id: string) {
    if (!this.instances.has(id)) this.instances.set(id, new FakeAtomicDO())
    return this.instances.get(id)!
  }
}

let env: Env
let ns: FakeNamespace

const USD = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6))

beforeEach(() => {
  ns = new FakeNamespace()
  env = { ATOMIC_STORE: ns } as unknown as Env
})

/** Sum every ledger entry actually stored for a partner. Invariant I2 check. */
async function ledgerSum(partnerId: string): Promise<bigint> {
  const p = await getPartner(env, partnerId)
  let total = 0n
  for (const id of p!.ledgerIndex) {
    const raw = await casRead(env, ledgerKey(partnerId, id))
    if (raw) total += BigInt(JSON.parse(raw).deltaAtomic)
  }
  return total
}

async function seedPartner(email: string, usd: string) {
  const p = await getOrCreatePartnerByEmail(env, email)
  await topupPartner(env, { email, amountAtomic: USD(usd), proof: `seed-${email}` })
  return p.id
}

// ── Accounts ─────────────────────────────────────────────────────────────────

describe('partner accounts', () => {
  it('normalises email so case and whitespace cannot fork one person into two accounts', async () => {
    expect(normalizeEmail('  A@X.com ')).toBe('a@x.com')
    const a = await getOrCreatePartnerByEmail(env, 'A@X.com')
    const b = await getOrCreatePartnerByEmail(env, ' a@x.com ')
    expect(b.id).toBe(a.id)
    expect(await getPartnerIdByEmail(env, 'a@x.com')).toBe(a.id)
  })

  it('converges on one account when two callers register concurrently', async () => {
    const [a, b] = await Promise.all([
      getOrCreatePartnerByEmail(env, 'race@x.com'),
      getOrCreatePartnerByEmail(env, 'race@x.com'),
    ])
    expect(a.id).toBe(b.id)
    expect(a.balanceAtomic).toBe('0')
  })
})

// ── Top-up idempotency ───────────────────────────────────────────────────────

describe('topup', () => {
  it('credits once per proof — a retried top-up must not double the balance', async () => {
    await topupPartner(env, { email: 'p@x.com', amountAtomic: USD('100'), proof: 'order-1' })
    const again = await topupPartner(env, {
      email: 'p@x.com',
      amountAtomic: USD('100'),
      proof: 'order-1',
    })
    expect(again.applied).toBe(false)
    expect(again.partner.balanceAtomic).toBe(USD('100').toString())
    expect(await ledgerSum(again.partner.id)).toBe(USD('100'))
  })

  it('a different proof credits again', async () => {
    await topupPartner(env, { email: 'p@x.com', amountAtomic: USD('100'), proof: 'order-1' })
    const r = await topupPartner(env, {
      email: 'p@x.com',
      amountAtomic: USD('5'),
      proof: 'order-2',
    })
    expect(r.partner.balanceAtomic).toBe(USD('105').toString())
  })
})

// ── Issue ────────────────────────────────────────────────────────────────────

describe('issue', () => {
  it('debits exactly the face value and keeps sum(ledger) === balance', async () => {
    const id = await seedPartner('p@x.com', '100')
    // 50 credits x 1.05 = $52.50
    const res = await issuePartnerCoupon(env, {
      partnerId: id,
      amountAtomic: USD('52.50'),
      expiresInMinutes: 720,
      clientKey: 'ck-1',
    })
    // formatUsdc trims trailing zeros ('52.5', not '52.50'). Equal as decimals;
    // rendering to 2dp is the UI's job, and redemption compares atomic units.
    expect(res.amountUsd).toBe('52.5')
    expect(res.balanceAfterAtomic).toBe(USD('47.50').toString())
    expect(await ledgerSum(id)).toBe(USD('47.50'))

    const rec = parseRecord(await casRead(env, couponKey(res.code)))
    expect(rec!.status).toBe('issued')
    expect(rec!.partnerId).toBe(id)
    expect(rec!.issueLedgerId).toBeTruthy()
  })

  it('issues 10-digit codes', async () => {
    const id = await seedPartner('p@x.com', '100')
    const res = await issuePartnerCoupon(env, {
      partnerId: id,
      amountAtomic: USD('1.05'),
      expiresInMinutes: 720,
      clientKey: 'ck-1',
    })
    expect(res.code).toMatch(/^\d{10}$/)
  })

  it('refuses when the balance cannot cover it, and creates NO coupon', async () => {
    const id = await seedPartner('p@x.com', '10')
    // Count coupon keys specifically. applyLedger writes the ledger body before
    // committing the balance, so a rejected issue can leave an orphan `pledger:`
    // draft — unindexed, unread, unsummed. What must NOT appear is a coupon.
    const coupons = () => [...ns.get('coupon').store.keys()].filter((k) => k.startsWith('coupon:'))
    const before = coupons().length
    await expect(
      issuePartnerCoupon(env, {
        partnerId: id,
        amountAtomic: USD('52.50'),
        expiresInMinutes: 720,
        clientKey: 'ck-1',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    expect(coupons().length).toBe(before)
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('10').toString())
  })

  it('replaying the same clientKey does not debit twice', async () => {
    const id = await seedPartner('p@x.com', '100')
    const a = await issuePartnerCoupon(env, {
      partnerId: id,
      amountAtomic: USD('10'),
      expiresInMinutes: 720,
      clientKey: 'same-key',
    })
    const b = await issuePartnerCoupon(env, {
      partnerId: id,
      amountAtomic: USD('10'),
      expiresInMinutes: 720,
      clientKey: 'same-key',
    })
    expect(b.reused).toBe(true)
    expect(b.code).toBe(a.code)
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('90').toString())
    expect(await ledgerSum(id)).toBe(USD('90'))
  })

  it('concurrent issues never overdraw: only what the balance covers succeeds', async () => {
    const id = await seedPartner('p@x.com', '30')
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        issuePartnerCoupon(env, {
          partnerId: id,
          amountAtomic: USD('10'),
          expiresInMinutes: 720,
          clientKey: `ck-${i}`,
        }),
      ),
    )
    const ok = results.filter((r) => r.status === 'fulfilled').length
    expect(ok).toBe(3)
    const p = await getPartner(env, id)
    expect(BigInt(p!.balanceAtomic)).toBe(0n)
    expect(await ledgerSum(id)).toBe(0n)
  })
})

describe('codex review regressions', () => {
  it('concurrent same-clientKey issues mint exactly ONE coupon, and it is paid for', async () => {
    // The loss-bearing bug: both callers pass the pre-flight "key unused" check,
    // one debits, the other no-ops on the idempotency key — and the old code
    // then went on to create a second coupon anyway. Free credit.
    const id = await seedPartner('p@x.com', '100')
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        issuePartnerCoupon(env, {
          partnerId: id,
          amountAtomic: USD('10'),
          expiresInMinutes: 720,
          clientKey: 'same-key',
        }),
      ),
    )
    const codes = new Set(
      settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value.code] : [])),
    )
    expect(codes.size).toBeLessThanOrEqual(1)

    const live = [...ns.get('coupon').store.keys()]
      .filter((k) => k.startsWith('coupon:'))
      .map((k) => parseRecord(ns.get('coupon').store.get(k)!.value))
      .filter((r) => r && r.partnerId === id)
    // Exactly one coupon, and the balance shows exactly one debit.
    expect(live).toHaveLength(1)
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('90').toString())
    expect(await ledgerSum(id)).toBe(USD('90'))
  })

  it('a replayed clientKey returns ITS coupon, not merely the newest one', async () => {
    const id = await seedPartner('p@x.com', '100')
    const a = await issuePartnerCoupon(env, {
      partnerId: id, amountAtomic: USD('10'), expiresInMinutes: 720, clientKey: 'A',
    })
    const b = await issuePartnerCoupon(env, {
      partnerId: id, amountAtomic: USD('10'), expiresInMinutes: 720, clientKey: 'B',
    })
    expect(b.code).not.toBe(a.code)
    const replayA = await issuePartnerCoupon(env, {
      partnerId: id, amountAtomic: USD('10'), expiresInMinutes: 720, clientKey: 'A',
    })
    expect(replayA.code).toBe(a.code)
    expect(await ledgerSum(id)).toBe(USD('80'))
  })

  it('refuses a new issue rather than evicting an unsettled recovery breadcrumb', async () => {
    // Dropping the oldest pendingIssue to make room would strand that money:
    // reconcile could no longer find it. Refusing op 51 is recoverable.
    const id = await seedPartner('p@x.com', '1000')
    await casUpdate<void>(env, partnerKey(id), (raw) => {
      const p = JSON.parse(raw!)
      p.pendingIssues = Array.from({ length: 50 }, (_, i) => ({
        opId: `op_${i}`, clientKey: `k${i}`, code: `${1000000000 + i}`,
        amountAtomic: USD('1').toString(), at: Date.now(),
      }))
      return { op: 'set', value: JSON.stringify(p), result: undefined }
    })
    await expect(
      issuePartnerCoupon(env, {
        partnerId: id, amountAtomic: USD('1'), expiresInMinutes: 720, clientKey: 'overflow',
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_PENDING' })
    expect((await getPartner(env, id))!.pendingIssues).toHaveLength(50)
  })

  it('every indexed ledger entry has a readable body (body-first write order)', async () => {
    const id = await seedPartner('p@x.com', '100')
    const r = await issuePartnerCoupon(env, {
      partnerId: id, amountAtomic: USD('10'), expiresInMinutes: 720, clientKey: 'x',
    })
    await voidPartnerCoupon(env, { partnerId: id, code: r.code })
    const p = await getPartner(env, id)
    for (const eid of p!.ledgerIndex) {
      expect(await casRead(env, ledgerKey(id, eid))).not.toBeNull()
    }
    expect((await readLedger(env, id)).length).toBe(p!.ledgerIndex.length)
  })

  it('an evicted topup key still cannot double-credit (ledger scan backstop)', async () => {
    const { partner } = await topupPartner(env, {
      email: 'p@x.com', amountAtomic: USD('100'), proof: 'order-1',
    })
    // Simulate the key having aged out of the bounded `applied` list.
    await casUpdate<void>(env, partnerKey(partner.id), (raw) => {
      const p = JSON.parse(raw!)
      p.applied = p.applied.filter((a: any) => a.k !== 'topup:order-1')
      return { op: 'set', value: JSON.stringify(p), result: undefined }
    })
    const again = await topupPartner(env, {
      email: 'p@x.com', amountAtomic: USD('100'), proof: 'order-1',
    })
    expect(again.applied).toBe(false)
    expect(again.partner.balanceAtomic).toBe(USD('100').toString())
  })
})

// ── The race that matters ────────────────────────────────────────────────────

describe('crash between debit and coupon creation', () => {
  /**
   * Simulates the Worker dying after step 1 (debit + pendingIssue recorded) and
   * before step 2 (coupon created), by making the coupon-key commit throw.
   */
  async function crashAfterDebit(partnerId: string, clientKey: string) {
    const real = ns.get('coupon').fetch.bind(ns.get('coupon'))
    const spy = vi.spyOn(ns.get('coupon'), 'fetch').mockImplementation(async (req: Request) => {
      const url = new URL(req.url)
      const body = await req.clone().json<any>()
      if (url.pathname === '/commit' && String(body.key).startsWith('coupon:')) {
        throw new Error('simulated worker death before coupon creation')
      }
      return real(req)
    })
    await expect(
      issuePartnerCoupon(env, {
        partnerId,
        amountAtomic: USD('10'),
        expiresInMinutes: 720,
        clientKey,
      }),
    ).rejects.toThrow(/simulated worker death/)
    spy.mockRestore()
  }

  it('leaves money debited, then reconcile refunds it', async () => {
    const id = await seedPartner('p@x.com', '100')
    await crashAfterDebit(id, 'ck-crash')

    let p = await getPartner(env, id)
    expect(p!.balanceAtomic).toBe(USD('90').toString()) // debited, coupon absent
    expect(p!.pendingIssues).toHaveLength(1)

    // Age the pending op past the stale window, then repair.
    await casUpdate<void>(env, partnerKey(id), (raw) => {
      const rec = JSON.parse(raw!)
      rec.pendingIssues[0].at = Date.now() - 120_000
      return { op: 'set', value: JSON.stringify(rec), result: undefined }
    })
    await reconcilePending(env, id)

    p = await getPartner(env, id)
    expect(p!.balanceAtomic).toBe(USD('100').toString())
    expect(p!.pendingIssues).toHaveLength(0)
    expect(await ledgerSum(id)).toBe(USD('100'))
  })

  it('reconcile is idempotent — running it repeatedly refunds once', async () => {
    const id = await seedPartner('p@x.com', '100')
    await crashAfterDebit(id, 'ck-crash')
    await casUpdate<void>(env, partnerKey(id), (raw) => {
      const rec = JSON.parse(raw!)
      rec.pendingIssues[0].at = Date.now() - 120_000
      return { op: 'set', value: JSON.stringify(rec), result: undefined }
    })
    await reconcilePending(env, id)
    await reconcilePending(env, id)
    await reconcilePending(env, id)
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('100').toString())
    expect(await ledgerSum(id)).toBe(USD('100'))
  })

  it('once reconcile tombstones the code, that code can never be created', async () => {
    const id = await seedPartner('p@x.com', '100')
    await crashAfterDebit(id, 'ck-crash')
    const stranded = (await getPartner(env, id))!.pendingIssues[0].code

    await casUpdate<void>(env, partnerKey(id), (raw) => {
      const rec = JSON.parse(raw!)
      rec.pendingIssues[0].at = Date.now() - 120_000
      return { op: 'set', value: JSON.stringify(rec), result: undefined }
    })
    await reconcilePending(env, id)

    // The tombstone holds the key: a late "resumed" issuer loses the CAS.
    const created = await casUpdate<boolean>(env, couponKey(stranded), (cur) =>
      cur !== null
        ? { op: 'noop', result: false }
        : { op: 'set', value: JSON.stringify({ code: stranded }), result: true },
    )
    expect(created).toBe(false)

    // And the tombstone reads as a dead coupon, not as something redeemable.
    const rec = parseRecord(await casRead(env, couponKey(stranded)))
    expect(rec!.status).toBe('void')
    expect((rec as any).tombstone).toBe(true)
  })

  it('a coupon that DOES exist is confirmed, not refunded (the TOCTOU case)', async () => {
    // The exact scenario the naive "absent -> refund" design got wrong: the
    // issuer was merely slow, so the coupon shows up. Reconcile must confirm.
    const id = await seedPartner('p@x.com', '100')
    const res = await issuePartnerCoupon(env, {
      partnerId: id,
      amountAtomic: USD('10'),
      expiresInMinutes: 720,
      clientKey: 'ck-slow',
    })
    // Re-open a pending op for that same, already-created coupon.
    const rec = parseRecord(await casRead(env, couponKey(res.code)))!
    await casUpdate<void>(env, partnerKey(id), (raw) => {
      const p = JSON.parse(raw!)
      p.pendingIssues.push({
        opId: rec.issueLedgerId,
        clientKey: 'ck-slow',
        code: res.code,
        amountAtomic: USD('10').toString(),
        at: Date.now() - 120_000,
      })
      return { op: 'set', value: JSON.stringify(p), result: undefined }
    })

    await reconcilePending(env, id)

    // Confirmed: no refund, coupon still alive.
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('90').toString())
    expect((await getPartner(env, id))!.pendingIssues).toHaveLength(0)
    expect(parseRecord(await casRead(env, couponKey(res.code)))!.status).toBe('issued')
  })

  it('a code collision with another partner refunds instead of confirming', async () => {
    const mine = await seedPartner('me@x.com', '100')
    const theirCode = generateCouponCode()
    // Someone else's coupon already sits on that key.
    await casUpdate<boolean>(env, couponKey(theirCode), () => ({
      op: 'set',
      value: JSON.stringify({
        code: theirCode,
        status: 'issued',
        amountAtomic: USD('999').toString(),
        amountUsd: '999.00',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3.6e6).toISOString(),
        events: [],
        partnerId: 'ptn_someone_else',
        issueLedgerId: 'op_theirs',
      }),
      result: true,
    }))
    // Strand a pending op pointing at it.
    await casUpdate<void>(env, partnerKey(mine), (raw) => {
      const p = JSON.parse(raw!)
      p.balanceAtomic = USD('90').toString()
      p.pendingIssues.push({
        opId: newOpId(),
        clientKey: 'ck-collide',
        code: theirCode,
        amountAtomic: USD('10').toString(),
        at: Date.now() - 120_000,
      })
      return { op: 'set', value: JSON.stringify(p), result: undefined }
    })

    await reconcilePending(env, mine)

    // Refunded — we must NOT claim someone else's coupon as ours.
    expect((await getPartner(env, mine))!.balanceAtomic).toBe(USD('100').toString())
    expect(parseRecord(await casRead(env, couponKey(theirCode)))!.partnerId).toBe(
      'ptn_someone_else',
    )
  })
})

// ── Void / refund ────────────────────────────────────────────────────────────

describe('void', () => {
  async function issueOne(id: string, usd = '10', key = 'ck-1') {
    return issuePartnerCoupon(env, {
      partnerId: id,
      amountAtomic: USD(usd),
      expiresInMinutes: 720,
      clientKey: key,
    })
  }

  it('refunds an unused coupon and records an audit trail', async () => {
    const id = await seedPartner('p@x.com', '100')
    const res = await issueOne(id)
    const out = await voidPartnerCoupon(env, {
      partnerId: id,
      code: res.code,
      audit: { ip: 'ipx', confirmInput: res.code.slice(-4), statusBefore: 'issued' },
    })
    expect(out.balanceAfterAtomic).toBe(USD('100').toString())
    expect(await ledgerSum(id)).toBe(USD('100'))

    const rec = parseRecord(await casRead(env, couponKey(res.code)))!
    expect(rec.status).toBe('void')
    expect((rec as any).refundPending).toBe(false)
    expect(rec.refundLedgerId).toBeTruthy()
    const ev = rec.events.find((e) => e.kind === 'partner_void') as any
    expect(ev.detail.confirmInput).toBe(res.code.slice(-4))
    expect(ev.detail.ip).toBe('ipx')
  })

  it('double-clicking void credits exactly once (idempotent, not an error)', async () => {
    // A double-click resolves both times with the same numbers rather than
    // erroring on the second: the second call recognises its own refundOpId and
    // replays the result. The credit itself is keyed on that op id, so the
    // ledger gains exactly one refund row.
    const id = await seedPartner('p@x.com', '100')
    const res = await issueOne(id)
    const first = await voidPartnerCoupon(env, { partnerId: id, code: res.code })
    const second = await voidPartnerCoupon(env, { partnerId: id, code: res.code })
    expect(second.balanceAfterAtomic).toBe(first.balanceAfterAtomic)
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('100').toString())
    expect(await ledgerSum(id)).toBe(USD('100'))
    const refunds = (await readLedger(env, id)).filter((e) => e.kind === 'void_refund')
    expect(refunds).toHaveLength(1)
  })

  it('concurrent double void credits exactly once', async () => {
    const id = await seedPartner('p@x.com', '100')
    const res = await issueOne(id)
    await Promise.allSettled([
      voidPartnerCoupon(env, { partnerId: id, code: res.code }),
      voidPartnerCoupon(env, { partnerId: id, code: res.code }),
    ])
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('100').toString())
    expect(await ledgerSum(id)).toBe(USD('100'))
  })

  it.each(['redeeming', 'paying', 'redeemed', 'manual_review'])(
    'refuses to refund a coupon in status=%s',
    async (status) => {
      const id = await seedPartner('p@x.com', '100')
      const res = await issueOne(id)
      await casUpdate<void>(env, couponKey(res.code), (raw) => {
        const rec = JSON.parse(raw!)
        rec.status = status
        return { op: 'set', value: JSON.stringify(rec), result: undefined }
      })
      await expect(
        voidPartnerCoupon(env, { partnerId: id, code: res.code }),
      ).rejects.toMatchObject({ code: 'COUPON_NOT_REFUNDABLE' })
      expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('90').toString())
    },
  )

  it('does NOT refund a coupon an admin voided out of `paying` (money already left)', async () => {
    // The admin void path has no status check, so a pre-existing `void` says
    // nothing about whether we paid. Only OUR refundOpId authorises a credit.
    const id = await seedPartner('p@x.com', '100')
    const res = await issueOne(id)
    await casUpdate<void>(env, couponKey(res.code), (raw) => {
      const rec = JSON.parse(raw!)
      rec.status = 'paying'
      return { op: 'set', value: JSON.stringify(rec), result: undefined }
    })
    // Admin stamps void over `paying`, exactly as /admin/coupon/resolve does.
    await casUpdate<void>(env, couponKey(res.code), (raw) => {
      const rec = JSON.parse(raw!)
      rec.status = 'void'
      rec.attemptId = null
      return { op: 'set', value: JSON.stringify(rec), result: undefined }
    })

    await expect(
      voidPartnerCoupon(env, { partnerId: id, code: res.code }),
    ).rejects.toMatchObject({ code: 'COUPON_NOT_REFUNDABLE' })
    // Still debited — we do not hand back money for a coupon we may have paid.
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('90').toString())
  })

  it('crash after the void transition but before the credit still pays out, once', async () => {
    const id = await seedPartner('p@x.com', '100')
    const res = await issueOne(id)

    // Flip issued -> void with a refundOpId, then stop (no credit) — exactly
    // the state a mid-refund crash leaves behind.
    const refundOpId = newOpId()
    await casUpdate<void>(env, couponKey(res.code), (raw) => {
      const rec = JSON.parse(raw!)
      rec.status = 'void'
      rec.refundOpId = refundOpId
      rec.refundPending = true
      return { op: 'set', value: JSON.stringify(rec), result: undefined }
    })
    await casUpdate<void>(env, partnerKey(id), (raw) => {
      const p = JSON.parse(raw!)
      p.pendingRefunds.push({
        refundOpId,
        code: res.code,
        amountAtomic: USD('10').toString(),
        kind: 'void_refund',
        at: Date.now() - 120_000,
      })
      return { op: 'set', value: JSON.stringify(p), result: undefined }
    })

    await reconcilePending(env, id)
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('100').toString())

    // And not twice.
    await reconcilePending(env, id)
    await reconcilePending(env, id)
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('100').toString())
    expect(await ledgerSum(id)).toBe(USD('100'))
  })

  it('refuses to void another partner’s coupon', async () => {
    const mine = await seedPartner('me@x.com', '100')
    const yours = await seedPartner('you@x.com', '100')
    const res = await issuePartnerCoupon(env, {
      partnerId: yours,
      amountAtomic: USD('10'),
      expiresInMinutes: 720,
      clientKey: 'ck-y',
    })
    await expect(
      voidPartnerCoupon(env, { partnerId: mine, code: res.code }),
    ).rejects.toMatchObject({ code: 'NOT_YOUR_COUPON' })
    expect((await getPartner(env, yours))!.balanceAtomic).toBe(USD('90').toString())
  })
})

// ── Listing / tenancy ────────────────────────────────────────────────────────

describe('listing', () => {
  it('returns only my coupons, newest first, and flags expiry', async () => {
    const mine = await seedPartner('me@x.com', '100')
    const yours = await seedPartner('you@x.com', '100')
    const a = await issuePartnerCoupon(env, {
      partnerId: mine,
      amountAtomic: USD('10'),
      expiresInMinutes: 720,
      clientKey: 'a',
    })
    await issuePartnerCoupon(env, {
      partnerId: yours,
      amountAtomic: USD('10'),
      expiresInMinutes: 720,
      clientKey: 'b',
    })
    // Age one of mine past its expiry.
    await casUpdate<void>(env, couponKey(a.code), (raw) => {
      const rec = JSON.parse(raw!)
      rec.expiresAt = new Date(Date.now() - 1000).toISOString()
      return { op: 'set', value: JSON.stringify(rec), result: undefined }
    })

    const list = await listPartnerCoupons(env, mine)
    expect(list).toHaveLength(1)
    expect(list[0].code).toBe(a.code)
    expect(list[0].status).toBe('expired')
    expect(list[0].refundable).toBe(true) // expired-but-unused is reclaimable
  })

  it('an expired coupon can be reclaimed and the money returns', async () => {
    const id = await seedPartner('p@x.com', '100')
    const res = await issuePartnerCoupon(env, {
      partnerId: id,
      amountAtomic: USD('10'),
      expiresInMinutes: 720,
      clientKey: 'a',
    })
    await casUpdate<void>(env, couponKey(res.code), (raw) => {
      const rec = JSON.parse(raw!)
      rec.expiresAt = new Date(Date.now() - 1000).toISOString()
      return { op: 'set', value: JSON.stringify(rec), result: undefined }
    })
    await voidPartnerCoupon(env, { partnerId: id, code: res.code, kind: 'expire_refund' })
    expect((await getPartner(env, id))!.balanceAtomic).toBe(USD('100').toString())
    const led = await readLedger(env, id)
    expect(led.some((e) => e.kind === 'expire_refund')).toBe(true)
  })
})

// ── Backwards compatibility ──────────────────────────────────────────────────

describe('legacy coupons', () => {
  it('a pre-partner coupon record (no partner fields) still parses', async () => {
    const legacy = {
      code: '12345678',
      amountUsd: '20.00',
      amountAtomic: '20000000',
      status: 'issued',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3.6e6).toISOString(),
      paymentProof: null,
      redeemingAt: null,
      attemptId: null,
      plId: null,
      redeemedAt: null,
      coinbaseResult: null,
      failureReason: null,
      events: [],
    }
    await casUpdate<boolean>(env, couponKey('12345678'), () => ({
      op: 'set',
      value: JSON.stringify(legacy),
      result: true,
    }))
    const rec = parseRecord(await casRead(env, couponKey('12345678')))
    expect(rec).not.toBeNull()
    expect(rec!.partnerId ?? null).toBeNull()
    expect(rec!.status).toBe('issued')
  })
})
