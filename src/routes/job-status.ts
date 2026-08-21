/**
 * Async job polling with Stellar ownership verification.
 *
 * Two endpoints:
 *
 *   GET /v1/services/:service/jobs/:jobId/challenge
 *     → { nonce, expiresAt }  (no auth — anyone can request a challenge,
 *       but only the true owner can sign it)
 *
 *   GET /v1/services/:service/jobs/:jobId
 *     Headers:
 *       X-Stellar-Owner:     G...                (the agent's G address)
 *       X-Stellar-Nonce:     <hex from challenge endpoint>
 *       X-Stellar-Signature: <base64 ed25519 sig over nonce bytes>
 *
 *     → 401 if any of the three headers is missing
 *     → 401 if the nonce is expired / unknown
 *     → 401 if Keypair.fromPublicKey(G).verify(nonce, sig) fails
 *     → 403 if G !== record.stellarAddress
 *     → 200 with upstream job body (SIWX-proxied) on success
 *
 * Why challenge-response instead of reusing the mppx payment credential:
 *   - mppx Credential.deserialize() only PARSES — it does not verify
 *     signatures. Without a full Method.Server + challenge round-trip,
 *     we cannot cryptographically validate an mppx credential.
 *   - Payment credentials are single-use (nonce-bound) so an agent
 *     cannot reuse their original paying credential to poll.
 *   - A plain Ed25519 signature over a server-issued nonce is the
 *     standard SEP-10 pattern and maps 1:1 onto the Stellar keypair.
 *
 * Nonce lifetime: 2 minutes. Stored at challenge:<jobId>:<G> so an
 * attacker cannot consume the owner's nonce by racing against them.
 *
 * Backwards compatibility: this is a breaking change to the polling
 * contract. No clients have shipped against the old (unverified)
 * extractStellarAddress-only path yet, so no migration is needed.
 */

import { Keypair } from '@stellar/stellar-base'
import { Credential } from 'mppx'
import { fetchWithSiwx } from '../mpp/siwx-signer'
import type { Env } from '../index'
import { enqueueRefund, type PaymentProof, type RefundReason } from '../refund/refund'
import { releaseChannelDeliveryLock, rollbackFailedChannelVoucher } from '../mpp/stellar-channel-dispatch'
import { doAtomicParams } from '../mpp/kv-atomic-store'

/**
 * Extract the Stellar G address from an already-verified mppx payment
 * credential. Used ONLY by proxy.ts when storing a jobAuth record: by
 * that point the credential has already been cryptographically verified
 * by mppx's Method.Server, so we only need to pull the G out.
 *
 * Do NOT use this to authorize a polling request — parsing without
 * verification is not authentication. Use the challenge-response flow
 * in handleJobStatus() for that.
 */
export function extractStellarAddress(authHeader: string | null): string | null {
  if (!authHeader) return null
  const trimmed = authHeader.trim()
  if (!/^Payment\s+/i.test(trimmed)) return null
  try {
    const credential = Credential.deserialize(trimmed) as {
      challenge?: { method?: string }
      source?: string
    }
    if (credential.challenge?.method?.toLowerCase() !== 'stellar') return null
    const source = credential.source
    if (typeof source !== 'string' || source.length === 0) return null
    const match = source.match(/^did:pkh:stellar:[^:]+:(G[A-Z2-7]{55})$/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/** Shape of the KV record stored when an async job is created. */
export interface JobAuthRecord {
  /** Stellar G address of the agent who paid */
  stellarAddress: string
  /** Router service id, e.g. "stablestudio_video_wan-2.6" */
  serviceId: string
  /** Upstream host, e.g. "stablestudio.dev" */
  upstreamHost: string
  /** Upstream polling path, e.g. "/api/jobs/cmnwmr..." */
  upstreamJobPath: string
  /** ISO-8601 timestamp of the initial payment */
  paidAt: string
  /** Present for settled stellar.charge jobs so later non-delivery can refund. */
  paymentProof?: PaymentProof
  channelDelivery?: {
    channelContract: string
    lockId: string
    challengeId: string
    acceptedAmount: string
    previousAmount: string
    action: 'voucher' | 'close'
  }
}

const CHALLENGE_TTL_SECONDS = 120
const NONCE_BYTES = 32

/**
 * Payers prove job ownership by signing with the same Stellar key they pay
 * with, so the bytes they sign must never be usable as a signature over
 * something else. Everything Stellar signs — transactions, Soroban auth
 * entries — is a bare 32-byte hash, which is exactly the size of a raw nonce.
 * Signing the nonce directly would let any service that hands back a chosen
 * "nonce" harvest a valid transaction signature from the payer's wallet.
 *
 * So the signed message is this printable, job-bound preimage instead. It can
 * never equal a 32-byte hash, and it binds the proof to one specific job.
 */
const OWNERSHIP_DOMAIN = 'mpprouter-job-ownership-v1'

export function ownershipMessage(jobId: string, nonceHex: string): Uint8Array {
  return new TextEncoder().encode(`${OWNERSHIP_DOMAIN}:${jobId}:${nonceHex}`)
}

function classifyAsyncFailure(statusCode: number, body: string): RefundReason | undefined {
  if (statusCode >= 400 && statusCode < 500) return 'non_fulfillment'
  if (statusCode >= 500) return 'upstream_5xx'
  if (statusCode >= 200 && statusCode < 300 && body.trim().length === 0) return 'empty_response'
  if (statusCode >= 200 && statusCode < 300) {
    try {
      const status = String(JSON.parse(body).status || '').toLowerCase()
      if (['failed', 'error', 'refused', 'rejected'].includes(status)) return 'non_fulfillment'
    } catch {
      // A non-empty non-JSON success is usable delivery.
    }
  }
  return undefined
}

export async function finishAsyncDelivery(
  env: Env,
  terminalKey: string,
  record: JobAuthRecord,
  outcome: 'delivered' | 'failed',
  reason?: RefundReason,
): Promise<'done' | 'conflict' | 'manual_review'> {
  const store = doAtomicParams(env.ATOMIC_STORE)
  const claimed = await store.update(`refund:async-terminal:${terminalKey}`, (current) => {
    if (current) {
      const value = JSON.parse(current) as { outcome: string; state: string }
      if (value.outcome !== outcome) return { op: 'noop', result: 'conflict' as const }
      if (value.state === 'done') return { op: 'noop', result: 'done' as const }
      return { op: 'noop', result: 'retry' as const }
    }
    return {
      op: 'set',
      value: JSON.stringify({ outcome, state: 'processing', claimedAt: new Date().toISOString() }),
      result: 'claimed' as const,
    }
  })
  if (claimed === 'conflict') return 'conflict'
  if (claimed === 'done') return 'done'

  const channel = record.channelDelivery
  if (outcome === 'failed' && channel?.action === 'voucher') {
    const rolledBack = await rollbackFailedChannelVoucher(
      env, channel.channelContract, channel.acceptedAmount,
      channel.previousAmount, channel.challengeId,
    )
    if (!rolledBack) return 'manual_review'
  } else if (outcome === 'failed' && reason && record.paymentProof) {
    await enqueueRefund(env, {
      proof: record.paymentProof,
      reason,
      merchant: record.upstreamHost,
      routeId: record.serviceId,
    })
  }
  if (channel) await releaseChannelDeliveryLock(env, channel.channelContract, channel.lockId)
  await store.put(`refund:async-terminal:${terminalKey}`, JSON.stringify({
    outcome, state: 'done', completedAt: new Date().toISOString(),
  }))
  return 'done'
}

/** Cron reconciliation so async refunds do not depend on the buyer polling. */
export async function reconcileAsyncRefunds(env: Env): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await env.MPP_STORE.list({ prefix: 'jobAuth:', limit: 100, ...(cursor ? { cursor } : {}) })
    for (const key of page.keys) {
      if (await env.MPP_STORE.get(`jobRefundChecked:${key.name}`)) continue
      const raw = await env.MPP_STORE.get(key.name)
      if (!raw) continue
      let record: JobAuthRecord
      try { record = JSON.parse(raw) } catch { continue }
      if (!record.paymentProof && !record.channelDelivery) continue
      const jobId = key.name.slice('jobAuth:'.length)
      const terminalKey = `${record.serviceId}:${jobId}`
      if (Date.now() - Date.parse(record.paidAt) >= 23 * 60 * 60_000) {
        const result = await finishAsyncDelivery(env, terminalKey, record, 'failed', 'timeout')
        if (result === 'done') {
          await env.MPP_STORE.put(`jobRefundChecked:${key.name}`, 'timeout-refunded', { expirationTtl: 86400 })
        }
        continue
      }
      try {
        const upstreamRes = await fetchWithSiwx(
          `https://${record.upstreamHost}${record.upstreamJobPath}`,
          env.TEMPO_ROUTER_PRIVATE_KEY,
        )
        const body = await upstreamRes.text()
        const reason = classifyAsyncFailure(upstreamRes.status, body)
        if (reason) {
          const result = await finishAsyncDelivery(env, terminalKey, record, 'failed', reason)
          if (result === 'done') {
            await env.MPP_STORE.put(`jobRefundChecked:${key.name}`, 'refunded', { expirationTtl: 86400 })
          }
        } else if (upstreamRes.ok) {
          try {
            const status = String(JSON.parse(body).status || '').toLowerCase()
            if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) {
              const result = await finishAsyncDelivery(env, terminalKey, record, 'delivered')
              if (result === 'done') {
                await env.MPP_STORE.put(`jobRefundChecked:${key.name}`, 'delivered', { expirationTtl: 86400 })
              }
            }
          } catch {
            // Non-JSON async bodies remain eligible for a later poll.
          }
        }
      } catch (error: any) {
        console.error(`[refund-cron] poll failed for ${key.name}: ${error.message}`)
      }
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(s: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0) return null
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16)
  return out
}

function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function isStellarG(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address)
}

/**
 * Issue a fresh nonce for (jobId, owner). Anyone can request — ownership
 * is only enforced when the signed nonce is presented on the poll call.
 */
export async function handleJobChallenge(
  request: Request,
  env: Env,
  _service: string,
  jobId: string,
): Promise<Response> {
  const owner = request.headers.get('x-stellar-owner')?.trim() || ''
  if (!isStellarG(owner)) {
    return new Response(
      JSON.stringify({
        error: 'X-Stellar-Owner header required (must be a G... address)',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // Confirm the job exists so we don't leak that unknown jobIds differ
  // from jobs owned by someone else — both return the same 404 shape.
  const rawJob = await env.MPP_STORE.get(`jobAuth:${jobId}`)
  if (!rawJob) {
    return new Response(
      JSON.stringify({ error: 'Job not found', jobId }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const nonceBytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const nonce = hex(nonceBytes)
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString()

  await env.MPP_STORE.put(`challenge:${jobId}:${owner}`, nonce, {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  })

  return new Response(
    JSON.stringify({
      jobId,
      owner,
      nonce,
      expiresAt,
      signedMessage: `${OWNERSHIP_DOMAIN}:${jobId}:<nonce>`,
      instructions:
        `Sign the UTF-8 bytes of "${OWNERSHIP_DOMAIN}:${jobId}:${nonce}" ` +
        'with your Stellar secret key, then GET /v1/services/<svc>/jobs/<id> ' +
        'with headers X-Stellar-Owner, X-Stellar-Nonce, X-Stellar-Signature ' +
        '(base64 ed25519). Never sign the bare nonce bytes: a 32-byte ' +
        'payload is indistinguishable from a Stellar transaction hash.',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

export async function handleJobStatus(
  request: Request,
  env: Env,
  service: string,
  jobId: string,
): Promise<Response> {
  // 1. Look up the job auth record
  const raw = await env.MPP_STORE.get(`jobAuth:${jobId}`)
  if (!raw) {
    return new Response(
      JSON.stringify({ error: 'Job not found', jobId }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )
  }

  let record: JobAuthRecord
  try {
    record = JSON.parse(raw)
  } catch {
    return new Response(
      JSON.stringify({ error: 'Corrupt job record' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // 2. Read ownership proof headers
  const owner = request.headers.get('x-stellar-owner')?.trim() || ''
  const nonceHex = request.headers.get('x-stellar-nonce')?.trim() || ''
  const signatureB64 = request.headers.get('x-stellar-signature')?.trim() || ''

  if (!owner || !nonceHex || !signatureB64) {
    return new Response(
      JSON.stringify({
        error: 'Ownership proof required',
        hint:
          'GET /v1/services/<svc>/jobs/<id>/challenge with X-Stellar-Owner to ' +
          'receive a nonce, sign the UTF-8 bytes of ' +
          `"${OWNERSHIP_DOMAIN}:<jobId>:<nonce>" with your Stellar secret ` +
          'key, then retry this call with headers X-Stellar-Owner, ' +
          'X-Stellar-Nonce, X-Stellar-Signature (base64 ed25519).',
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (!isStellarG(owner)) {
    return new Response(
      JSON.stringify({ error: 'X-Stellar-Owner must be a G... address' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // 3. Validate nonce is fresh and bound to this owner
  const storedNonce = await env.MPP_STORE.get(`challenge:${jobId}:${owner}`)
  if (!storedNonce || storedNonce !== nonceHex) {
    return new Response(
      JSON.stringify({
        error: 'Unknown or expired nonce',
        hint: 'Request a new challenge before retrying.',
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const nonceBytes = fromHex(nonceHex)
  const signatureBytes = fromBase64(signatureB64)
  if (!nonceBytes || !signatureBytes) {
    return new Response(
      JSON.stringify({ error: 'Malformed nonce or signature' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // 4. Verify Ed25519 signature over the nonce bytes with the G public key
  let sigOk = false
  try {
    sigOk = Keypair.fromPublicKey(owner).verify(
      Buffer.from(ownershipMessage(jobId, nonceHex)),
      Buffer.from(signatureBytes),
    )
  } catch {
    sigOk = false
  }

  if (!sigOk) {
    return new Response(
      JSON.stringify({ error: 'Invalid signature over challenge nonce' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // 5. Burn the nonce — single-use
  await env.MPP_STORE.delete(`challenge:${jobId}:${owner}`)

  // 6. Authorization check — caller proved ownership of G, now make sure
  // G actually owns this job.
  if (owner !== record.stellarAddress) {
    return new Response(
      JSON.stringify({ error: 'Forbidden — signer does not own this job' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // 7. Proxy poll to upstream with SIWX auth
  const upstreamUrl = `https://${record.upstreamHost}${record.upstreamJobPath}`
  console.log(
    `[job-status] Polling ${upstreamUrl} for job ${jobId} (verified agent=${owner})`,
  )

  try {
    const upstreamRes = await fetchWithSiwx(upstreamUrl, env.TEMPO_ROUTER_PRIVATE_KEY)
    const body = await upstreamRes.text()
    const contentType = upstreamRes.headers.get('content-type') || 'application/json'

    const refundReason = classifyAsyncFailure(upstreamRes.status, body)

    if (refundReason && record.paymentProof) {
      const terminal = await finishAsyncDelivery(
        env, `${record.serviceId}:${jobId}`, record, 'failed', refundReason,
      )
      if (terminal !== 'done') {
        return new Response(JSON.stringify({ error: 'Async terminal outcome requires manual review' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json', 'Refund-Status': 'manual-review' },
        })
      }
      // Idempotent second call retrieves the stable public capability created
      // by finishAsyncDelivery without creating another refund.
      const refund = await enqueueRefund(env, {
        proof: record.paymentProof, reason: refundReason,
        merchant: record.upstreamHost, routeId: record.serviceId,
      })
      const response = new Response(body, {
        status: upstreamRes.ok ? 502 : upstreamRes.status,
        headers: { 'Content-Type': contentType },
      })
      response.headers.set('Refund-Id', refund.publicId)
      response.headers.set('Refund-Status', 'pending')
      response.headers.set('Refund-Status-Url', `${new URL(request.url).origin}/v1/refunds/${refund.publicId}`)
      return response
    }

    if (refundReason && record.channelDelivery?.action === 'voucher') {
      const result = await finishAsyncDelivery(env, `${record.serviceId}:${jobId}`, record, 'failed', refundReason)
      const response = new Response(body, {
        status: upstreamRes.ok ? 502 : upstreamRes.status,
        headers: {
          'Content-Type': contentType,
          'Refund-Status': result === 'done' ? 'voucher-not-consumed' : 'manual-review',
        },
      })
      return response
    }

    if (upstreamRes.ok) {
      try {
        const status = String(JSON.parse(body).status || '').toLowerCase()
        if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) {
          await finishAsyncDelivery(env, `${record.serviceId}:${jobId}`, record, 'delivered')
        }
      } catch {
        // Keep pending when the upstream did not provide a terminal status.
      }
    }

    return new Response(body, {
      status: upstreamRes.status,
      headers: { 'Content-Type': contentType },
    })
  } catch (err: any) {
    console.error(`[job-status] SIWX proxy error for job ${jobId}: ${err.message}`)
    return new Response(
      JSON.stringify({
        error: 'Failed to poll upstream service',
        detail: err.message,
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
