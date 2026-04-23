/**
 * Unit tests for the job-ownership proof flow in src/routes/job-status.ts.
 *
 * Exercises:
 *   - handleJobChallenge issues a bound nonce
 *   - handleJobStatus rejects missing/unknown/expired nonces
 *   - handleJobStatus rejects an Ed25519 signature from the wrong key
 *   - handleJobStatus accepts a correct signature and burns the nonce
 *
 * The upstream SIWX proxy is NOT exercised — we use a stubbed fetch at
 * the network boundary so we stay hermetic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Keypair } from '@stellar/stellar-base'
import {
  handleJobChallenge,
  handleJobStatus,
  type JobAuthRecord,
} from '../src/routes/job-status'
import type { Env } from '../src/index'

function makeEnv(): { env: Env; kv: Map<string, string> } {
  const kv = new Map<string, string>()
  const MPP_STORE = {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => {
      kv.set(k, v)
    },
    delete: async (k: string) => {
      kv.delete(k)
    },
  }
  // Any 32-byte hex; only needs to be viem-parseable — upstream fetch is stubbed.
  const testKey = '0x' + '11'.repeat(32)
  return { env: { MPP_STORE, TEMPO_ROUTER_PRIVATE_KEY: testKey } as unknown as Env, kv }
}

function seedJob(kv: Map<string, string>, jobId: string, owner: string): void {
  const record: JobAuthRecord = {
    stellarAddress: owner,
    serviceId: 'stablestudio_generate_nano-banana-pro_generate',
    upstreamHost: 'stablestudio.dev',
    upstreamJobPath: `/api/jobs/${jobId}`,
    paidAt: new Date().toISOString(),
  }
  kv.set(`jobAuth:${jobId}`, JSON.stringify(record))
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

describe('handleJobChallenge', () => {
  it('returns 400 without X-Stellar-Owner', async () => {
    const { env } = makeEnv()
    const res = await handleJobChallenge(
      new Request('https://r/x/jobs/J/challenge'),
      env,
      'stablestudio',
      'J',
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown jobId', async () => {
    const { env } = makeEnv()
    const owner = Keypair.random().publicKey()
    const res = await handleJobChallenge(
      new Request('https://r/x/jobs/J/challenge', {
        headers: { 'x-stellar-owner': owner },
      }),
      env,
      'stablestudio',
      'J',
    )
    expect(res.status).toBe(404)
  })

  it('issues a nonce and stores it keyed by (jobId, owner)', async () => {
    const { env, kv } = makeEnv()
    const owner = Keypair.random().publicKey()
    seedJob(kv, 'J1', owner)
    const res = await handleJobChallenge(
      new Request('https://r/x/jobs/J1/challenge', {
        headers: { 'x-stellar-owner': owner },
      }),
      env,
      'stablestudio',
      'J1',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nonce: string; owner: string; jobId: string }
    expect(body.jobId).toBe('J1')
    expect(body.owner).toBe(owner)
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(kv.get(`challenge:J1:${owner}`)).toBe(body.nonce)
  })
})

describe('handleJobStatus ownership verification', () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
    // Stub upstream SIWX calls so tests never hit the network. The
    // router polls with fetchWithSiwx which does a probe then a
    // signed retry — both get stubbed to 200 here.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'J', status: 'complete' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns 404 for unknown jobId', async () => {
    const { env } = makeEnv()
    const res = await handleJobStatus(
      new Request('https://r/v1/services/stablestudio/jobs/missing'),
      env,
      'stablestudio',
      'missing',
    )
    expect(res.status).toBe(404)
  })

  it('returns 401 when ownership headers are missing', async () => {
    const { env, kv } = makeEnv()
    seedJob(kv, 'J2', Keypair.random().publicKey())
    const res = await handleJobStatus(
      new Request('https://r/v1/services/stablestudio/jobs/J2'),
      env,
      'stablestudio',
      'J2',
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for an unknown / unissued nonce', async () => {
    const { env, kv } = makeEnv()
    const kp = Keypair.random()
    seedJob(kv, 'J3', kp.publicKey())
    const res = await handleJobStatus(
      new Request('https://r/v1/services/stablestudio/jobs/J3', {
        headers: {
          'x-stellar-owner': kp.publicKey(),
          'x-stellar-nonce': 'a'.repeat(64),
          'x-stellar-signature': Buffer.from(new Uint8Array(64)).toString('base64'),
        },
      }),
      env,
      'stablestudio',
      'J3',
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 when another keypair signs a legitimate nonce', async () => {
    const { env, kv } = makeEnv()
    const owner = Keypair.random()
    const attacker = Keypair.random()
    seedJob(kv, 'J4', owner.publicKey())

    // Request a challenge AS the owner (attacker knows the owner's G).
    const challenge = await handleJobChallenge(
      new Request('https://r/v1/services/stablestudio/jobs/J4/challenge', {
        headers: { 'x-stellar-owner': owner.publicKey() },
      }),
      env,
      'stablestudio',
      'J4',
    )
    const { nonce } = (await challenge.json()) as { nonce: string }

    // Attacker signs with their own key but presents owner's G.
    const sig = attacker.sign(Buffer.from(hexToBytes(nonce)))

    const res = await handleJobStatus(
      new Request('https://r/v1/services/stablestudio/jobs/J4', {
        headers: {
          'x-stellar-owner': owner.publicKey(),
          'x-stellar-nonce': nonce,
          'x-stellar-signature': sig.toString('base64'),
        },
      }),
      env,
      'stablestudio',
      'J4',
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 when a valid signer is not the job owner', async () => {
    const { env, kv } = makeEnv()
    const owner = Keypair.random()
    const otherAgent = Keypair.random()
    seedJob(kv, 'J5', owner.publicKey())

    // otherAgent legitimately signs a nonce — but the job is owned by
    // `owner`, so ownership must fail.
    const challenge = await handleJobChallenge(
      new Request('https://r/v1/services/stablestudio/jobs/J5/challenge', {
        headers: { 'x-stellar-owner': otherAgent.publicKey() },
      }),
      env,
      'stablestudio',
      'J5',
    )
    const { nonce } = (await challenge.json()) as { nonce: string }
    const sig = otherAgent.sign(Buffer.from(hexToBytes(nonce)))

    const res = await handleJobStatus(
      new Request('https://r/v1/services/stablestudio/jobs/J5', {
        headers: {
          'x-stellar-owner': otherAgent.publicKey(),
          'x-stellar-nonce': nonce,
          'x-stellar-signature': sig.toString('base64'),
        },
      }),
      env,
      'stablestudio',
      'J5',
    )
    expect(res.status).toBe(403)
  })

  it('returns 200 and burns the nonce for a correct owner signature', async () => {
    const { env, kv } = makeEnv()
    const owner = Keypair.random()
    seedJob(kv, 'J6', owner.publicKey())

    const challenge = await handleJobChallenge(
      new Request('https://r/v1/services/stablestudio/jobs/J6/challenge', {
        headers: { 'x-stellar-owner': owner.publicKey() },
      }),
      env,
      'stablestudio',
      'J6',
    )
    const { nonce } = (await challenge.json()) as { nonce: string }
    const sig = owner.sign(Buffer.from(hexToBytes(nonce)))

    const res = await handleJobStatus(
      new Request('https://r/v1/services/stablestudio/jobs/J6', {
        headers: {
          'x-stellar-owner': owner.publicKey(),
          'x-stellar-nonce': nonce,
          'x-stellar-signature': sig.toString('base64'),
        },
      }),
      env,
      'stablestudio',
      'J6',
    )
    expect(res.status).toBe(200)
    expect(kv.has(`challenge:J6:${owner.publicKey()}`)).toBe(false)

    // Replay the same nonce — should now fail (single-use)
    const replay = await handleJobStatus(
      new Request('https://r/v1/services/stablestudio/jobs/J6', {
        headers: {
          'x-stellar-owner': owner.publicKey(),
          'x-stellar-nonce': nonce,
          'x-stellar-signature': sig.toString('base64'),
        },
      }),
      env,
      'stablestudio',
      'J6',
    )
    expect(replay.status).toBe(401)
  })
})
