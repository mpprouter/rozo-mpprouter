import { describe, expect, it } from 'vitest'
import type { Env } from '../src/index'
import {
  readFunderReservedAtomic,
  releaseFunderReservation,
  tryReserveFunder,
} from '../src/routes/funder-reservation'
import { casUpdate } from '../src/routes/stripe-atomic'

class LinearizableAtomicDO {
  private readonly values = new Map<string, string>()
  private readonly versions = new Map<string, number>()

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const body = await request.json() as any
    const version = this.versions.get(body.key) ?? 0
    if (path === '/read') {
      return Response.json({ value: this.values.get(body.key) ?? null, version })
    }
    if (path === '/commit') {
      if (version !== body.expectedVersion) {
        return Response.json({
          ok: false,
          value: this.values.get(body.key) ?? null,
          version,
        })
      }
      this.values.set(body.key, body.value)
      this.versions.set(body.key, version + 1)
      return Response.json({ ok: true })
    }
    return new Response('not found', { status: 404 })
  }
}

function makeAtomicNamespace(): DurableObjectNamespace {
  const instance = new LinearizableAtomicDO()
  return {
    idFromName: () => ({ name: 'stripe-fulfillment' }),
    get: () => ({ fetch: (request: Request) => instance.fetch(request) }),
  } as unknown as DurableObjectNamespace
}

function makeEnv(): Env {
  return {
    ATOMIC_STORE: makeAtomicNamespace(),
  } as unknown as Env
}

describe('shared funder reservation', () => {
  it('linearizes Coinbase and Stripe against the same wallet balance', async () => {
    const env = makeEnv()

    const [coinbase, stripe] = await Promise.all([
      tryReserveFunder(env, {
        reservationId: 'coinbase:pl_one',
        amountAtomic: 20_000_000n,
        balanceAtomic: 30_000_000n,
        nowMs: 1_000,
      }),
      tryReserveFunder(env, {
        reservationId: 'stripe:cpis_two',
        amountAtomic: 20_000_000n,
        balanceAtomic: 30_000_000n,
        nowMs: 1_000,
      }),
    ])

    expect([coinbase.kind, stripe.kind].sort()).toEqual(['acquired', 'insufficient'])
    expect(await readFunderReservedAtomic(env)).toBe(20_000_000n)
  })

  it('treats the same reservation id as already held, never a second acquire', async () => {
    const env = makeEnv()
    const first = await tryReserveFunder(env, {
      reservationId: 'stripe:cpis_same',
      amountAtomic: 10_000_000n,
      balanceAtomic: 100_000_000n,
      nowMs: 1_000,
    })
    const duplicate = await tryReserveFunder(env, {
      reservationId: 'stripe:cpis_same',
      amountAtomic: 10_000_000n,
      balanceAtomic: 100_000_000n,
      nowMs: 2_000,
    })

    expect(first.kind).toBe('acquired')
    expect(duplicate.kind).toBe('already_reserved')
    expect(await readFunderReservedAtomic(env)).toBe(10_000_000n)
  })

  it('releases idempotently so another provider can use the headroom', async () => {
    const env = makeEnv()
    await tryReserveFunder(env, {
      reservationId: 'coupon:attempt_one',
      amountAtomic: 15_000_000n,
      balanceAtomic: 15_000_000n,
      nowMs: 1_000,
    })
    await releaseFunderReservation(env, 'coupon:attempt_one')
    await releaseFunderReservation(env, 'coupon:attempt_one')

    const stripe = await tryReserveFunder(env, {
      reservationId: 'stripe:cpis_after',
      amountAtomic: 15_000_000n,
      balanceAtomic: 15_000_000n,
      nowMs: 2_000,
    })
    expect(stripe.kind).toBe('acquired')
  })

  it('keeps a leaked reservation fail-closed until explicit release', async () => {
    const env = makeEnv()
    await tryReserveFunder(env, {
      reservationId: 'coinbase:pl_crashed',
      amountAtomic: 10_000_000n,
      balanceAtomic: 10_000_000n,
      nowMs: 1_000,
    })

    const later = await tryReserveFunder(env, {
      reservationId: 'stripe:cpis_retry',
      amountAtomic: 10_000_000n,
      balanceAtomic: 10_000_000n,
      nowMs: 1_000 + 24 * 60 * 60 * 1_000,
    })
    expect(later.kind).toBe('insufficient')
  })

  it('fails closed instead of treating corrupt reservation state as zero', async () => {
    const env = makeEnv()
    await casUpdate(env, 'funder-reservations:v1', () => ({
      op: 'set',
      value: '{not-json',
      result: null,
    }))

    await expect(tryReserveFunder(env, {
      reservationId: 'stripe:cpis_corrupt',
      amountAtomic: 1_000_000n,
      balanceAtomic: 100_000_000n,
    })).rejects.toThrow('funder reservation state is invalid JSON')
  })
})
