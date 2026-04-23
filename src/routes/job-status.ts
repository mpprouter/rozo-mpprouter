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
}

const CHALLENGE_TTL_SECONDS = 120
const NONCE_BYTES = 32

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
      instructions:
        'Sign the hex-decoded nonce bytes with your Stellar secret key, ' +
        'then GET /v1/services/<svc>/jobs/<id> with headers ' +
        'X-Stellar-Owner, X-Stellar-Nonce, X-Stellar-Signature (base64).',
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
          'receive a nonce, sign the hex-decoded bytes with your Stellar ' +
          'secret key, then retry this call with headers X-Stellar-Owner, ' +
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
      Buffer.from(nonceBytes),
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
