import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'

const paidGate = vi.hoisted(() => vi.fn())

vi.mock('../src/services/provider-verification', () => ({
  chooseVerificationRoute: (record: any) => record.routes[0],
  gateProbe402: vi.fn(async () => ({ ok: true, detail: 'probe passed' })),
  gateRealMoneyCall: paidGate,
  parseProviderChallenge: vi.fn(),
}))

import { handleProviderVerify } from '../src/routes/providers'

function makeEnv() {
  const kv = new Map<string, string>()
  const atomic = new Map<string, { value: string | null; version: number }>()
  const stub = {
    fetch: async (request: Request) => {
      const body = await request.json() as any
      const state = atomic.get(body.key) ?? { value: null, version: 0 }
      if (new URL(request.url).pathname === '/read') return Response.json(state)
      if (body.expectedVersion !== state.version) return Response.json({ ok: false, ...state })
      if (body.op === 'delete') state.value = null
      else state.value = body.value
      state.version += 1
      atomic.set(body.key, state)
      return Response.json({ ok: true })
    },
  }
  return {
    MPP_STORE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value) },
      list: async () => ({ keys: [], list_complete: true }),
    },
    ATOMIC_STORE: { idFromName: () => ({}), get: () => stub },
    STELLAR_NETWORK: 'stellar:pubnet',
  } as any
}

describe('provider verify handler payment idempotency', () => {
  beforeEach(() => paidGate.mockReset())

  it('does not pay twice after an uncertain result updates record.updatedAt', async () => {
    paidGate.mockResolvedValue({ ok: false, code: 'paid_call_failed', detail: 'timeout after submit' })
    const env = makeEnv()
    const providerId = 'handler-test'
    const payout = Keypair.random().publicKey()
    await env.MPP_STORE.put(`provider:${providerId}`, JSON.stringify({
      id: providerId, name: 'Handler Test', email: 'ops@example.com', apiBaseUrl: 'https://api.example.com',
      payouts: [{ network: 'stellar:pubnet', payTo: payout, asset: 'USDC' }],
      routes: [{ operation: 'run', method: 'POST', upstreamPath: '/run', priceUsd: '0.01' }],
      status: 'pending', verification: { domainVerifiedAt: '2026-09-04T00:00:00.000Z' },
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      ownerKey: { network: 'stellar:pubnet', address: payout },
      registrationVersion: 'signed-payload-digest-v1',
    }))
    const request = () => new Request('https://router.test/v1/providers/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.22', 'X-MPP-Client-Id': crypto.randomUUID() },
      body: JSON.stringify({ id: providerId }),
    })
    const ctx = { waitUntil() {} } as any
    expect((await handleProviderVerify(request(), env, ctx)).status).toBe(422)
    const changed = JSON.parse(await env.MPP_STORE.get(`provider:${providerId}`))
    expect(changed.updatedAt).not.toBe('2026-09-04T00:00:00.000Z')
    const retry = await handleProviderVerify(request(), env, ctx)
    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ error: 'payment_outcome_uncertain' })
    expect(paidGate).toHaveBeenCalledTimes(1)
  })
})
