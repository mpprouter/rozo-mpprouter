/**
 * GET /v1/services/:service/jobs/:jobId — Poll async job status.
 *
 * Some upstream services (StableStudio video generation, etc.) return
 * 202 + jobId instead of an immediate result. Polling requires SIWX
 * authentication that the Stellar wallet cannot produce. The Router
 * acts as a SIWX signing proxy using its Tempo EVM wallet.
 *
 * Flow:
 * 1. Look up jobAuth:<jobId> in KV (stored during the initial paid request)
 * 2. Verify the caller is the same agent who paid (Stellar address match)
 * 3. Proxy the poll to the upstream service with SIWX auth
 * 4. Return the upstream response to the agent
 *
 * No payment required — matches upstream behavior where polling is free.
 */

import { Credential } from 'mppx'
import { fetchWithSiwx } from '../mpp/siwx-signer'
import type { Env } from '../index'

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

/**
 * Extract Stellar G address from any mppx credential (charge or channel).
 * Returns null if the header is missing, malformed, or non-Stellar.
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
    // did:pkh:stellar:<network>:G... — accept any network
    const match = source.match(/^did:pkh:stellar:[^:]+:(G[A-Z2-7]{55})$/)
    return match ? match[1] : null
  } catch {
    return null
  }
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

  // 2. Verify agent identity
  const authHeader = request.headers.get('authorization')
  const callerAddress = extractStellarAddress(authHeader)
  if (!callerAddress) {
    return new Response(
      JSON.stringify({
        error: 'Stellar credential required',
        hint: 'Send Authorization: Payment <base64> with a valid Stellar mppx credential',
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (callerAddress !== record.stellarAddress) {
    return new Response(
      JSON.stringify({ error: 'Forbidden — credential does not match job owner' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // 3. Proxy poll to upstream with SIWX auth
  const upstreamUrl = `https://${record.upstreamHost}${record.upstreamJobPath}`
  console.log(`[job-status] Polling ${upstreamUrl} for job ${jobId} (agent=${callerAddress})`)

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
