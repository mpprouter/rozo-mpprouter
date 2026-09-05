import type { Env } from '../index'
import { readBoundedText } from './provider-check'

const PREFIX = 'providerDomainProof:'
const TTL_SECONDS = 10 * 60
const MAX_MANIFEST_BYTES = 32_768

type StoredProof = {
  tokenHash: string
  providerId: string
  domain: string
  payTo: string
  expiresAt: string
}

async function writeProof(env: Env, key: string, value: string): Promise<void> {
  if (!env.ATOMIC_STORE) {
    await env.MPP_STORE.put(key, value, { expirationTtl: TTL_SECONDS })
    return
  }
  const stub = env.ATOMIC_STORE.get(env.ATOMIC_STORE.idFromName('provider-domain-proof'))
  const read = await stub.fetch(new Request('https://provider-domain-proof.internal/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
  }))
  const current = await read.json() as { version: number }
  const committed = await stub.fetch(new Request('https://provider-domain-proof.internal/commit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, expectedVersion: current.version, op: 'set', value }),
  }))
  const result = await committed.json() as { ok: boolean }
  if (!result.ok) throw new Error('A domain proof was issued concurrently; retry.')
}

async function readProof(env: Env, key: string): Promise<{ value: string | null; version?: number }> {
  if (!env.ATOMIC_STORE) return { value: await env.MPP_STORE.get(key) }
  const stub = env.ATOMIC_STORE.get(env.ATOMIC_STORE.idFromName('provider-domain-proof'))
  const response = await stub.fetch(new Request('https://provider-domain-proof.internal/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
  }))
  return response.json() as Promise<{ value: string | null; version: number }>
}

async function deleteProof(env: Env, key: string, version?: number): Promise<boolean> {
  if (!env.ATOMIC_STORE) { await env.MPP_STORE.delete(key); return true }
  const stub = env.ATOMIC_STORE.get(env.ATOMIC_STORE.idFromName('provider-domain-proof'))
  const response = await stub.fetch(new Request('https://provider-domain-proof.internal/commit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, expectedVersion: version, op: 'delete' }),
  }))
  return ((await response.json()) as { ok: boolean }).ok
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function proofKey(providerId: string, domain: string, payTo: string): Promise<string> {
  return PREFIX + await sha256(`${domain}\n${providerId}\n${payTo}`)
}

export async function issueDomainProof(env: Env, args: { providerId: string; url: string; payTo: string }) {
  const random = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  const token = `${random}.${btoa(args.payTo).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
  const domain = new URL(args.url).hostname.toLowerCase()
  const stored: StoredProof = {
    tokenHash: await sha256(token),
    providerId: args.providerId,
    domain,
    payTo: args.payTo,
    expiresAt: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
  }
  const key = await proofKey(args.providerId, domain, args.payTo)
  const existing = await readProof(env, key)
  if (existing.value) {
    try {
      const current = JSON.parse(existing.value) as StoredProof
      if (Date.parse(current.expiresAt) > Date.now()) {
        throw new Error('A domain proof for this provider, domain and payout address is already active. Wait for it to expire.')
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('A domain proof')) throw error
    }
    await deleteProof(env, key, existing.version)
  }
  await writeProof(env, key, JSON.stringify(stored))
  return {
    token,
    expires_at: stored.expiresAt,
    manifest_url: `https://${domain}/.well-known/mpp-provider.json`,
    manifest: { token, domain, provider_id: args.providerId, pay_to: args.payTo },
  }
}

export async function consumeDomainProof(
  env: Env,
  args: { providerId: string; url: string; token: string },
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  const domain = new URL(args.url).hostname.toLowerCase()
  let payTo = ''
  try {
    const encoded = args.token.split('.')[1] ?? ''
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    payTo = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  } catch { /* Invalid token is handled as a missing binding below. */ }
  if (!payTo) return { ok: false, detail: 'Domain proof token is malformed.' }
  const key = await proofKey(args.providerId, domain, payTo)
  const loaded = await readProof(env, key)
  const raw = loaded.value
  if (!raw) return { ok: false, detail: 'Issue a fresh domain proof token and publish the manifest.' }
  let proof: StoredProof
  try { proof = JSON.parse(raw) as StoredProof } catch { return { ok: false, detail: 'Stored domain proof is invalid.' } }
  if (Date.parse(proof.expiresAt) <= Date.now()) {
    await deleteProof(env, key, loaded.version)
    return { ok: false, detail: 'Domain proof expired; issue a fresh token.' }
  }
  if (proof.providerId !== args.providerId || proof.domain !== domain || await sha256(args.token) !== proof.tokenHash) {
    return { ok: false, detail: 'Domain proof expired or no longer matches this registration.' }
  }
  // Two accepted locations, tried in order. The plain-text file exists
  // because it is the smallest thing a provider can serve — the first real
  // provider to reach this step asked for a challenge file rather than a
  // wallet signature, and "echo one token into a static file" is a request
  // an ops team says yes to. The JSON manifest stays supported and binds
  // more fields; both are equivalent proofs, because the token itself is
  // what we issued against this provider id, domain and payout address.
  // JSON first because it is the documented default and binds every field;
  // the plain-text file is the fallback for a provider who would rather
  // publish one opaque token than a manifest.
  const attempts: Array<{ url: string; kind: 'txt' | 'json' }> = [
    { url: `https://${domain}/.well-known/mpp-provider.json`, kind: 'json' },
    { url: `https://${domain}/.well-known/mpprouter-verify.txt`, kind: 'txt' },
  ]
  const failures: string[] = []
  for (const attempt of attempts) {
    let response: Response
    try {
      response = await fetch(attempt.url, {
        headers: { Accept: attempt.kind === 'txt' ? 'text/plain' : 'application/json', 'User-Agent': 'mpprouter-domain-proof/1' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      failures.push(`${attempt.url} could not be fetched over HTTPS without redirects`)
      continue
    }
    if (!response.ok) {
      failures.push(`${attempt.url} returned HTTP ${response.status}`)
      continue
    }
    const length = Number(response.headers.get('content-length') ?? '0')
    if (length > MAX_MANIFEST_BYTES) {
      failures.push(`${attempt.url} is too large`)
      continue
    }
    let text: string
    try {
      text = await readBoundedText(response, MAX_MANIFEST_BYTES)
    } catch {
      failures.push(`${attempt.url} could not be read`)
      continue
    }

    if (attempt.kind === 'txt') {
      // The token is the whole binding: it was issued for this provider
      // id, this domain and this payout address, and is hashed in KV. A
      // file containing it, served from the domain, is the assertion.
      if (text.trim() !== args.token) {
        failures.push(`${attempt.url} does not contain the issued token`)
        continue
      }
    } else {
      let manifest: Record<string, unknown>
      try {
        manifest = JSON.parse(text) as Record<string, unknown>
      } catch {
        failures.push(`${attempt.url} is not valid JSON`)
        continue
      }
      if (
        String(manifest.token ?? '') !== args.token ||
        String(manifest.domain ?? '').toLowerCase() !== domain ||
        String(manifest.provider_id ?? '') !== args.providerId ||
        String(manifest.pay_to ?? '') !== proof.payTo
      ) {
        failures.push(`${attempt.url} must bind the token, domain, provider ID and payout address`)
        continue
      }
    }

    return await finishProof(env, key, loaded.version, args.providerId, domain, proof.payTo, attempt.url)
  }
  return { ok: false, detail: `No usable domain proof was found. Tried: ${failures.join('; ')}.` }
}

/**
 * Consume the token and record the evidence.
 *
 * Split out so both accepted file formats share one single-use path: the
 * token is deleted before publication, so a retry needs a fresh one.
 */
async function finishProof(
  env: Env,
  key: string,
  version: number | undefined,
  providerId: string,
  domain: string,
  payTo: string,
  sourceUrl: string,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  // Delete before publication. A retry needs a fresh token, making the proof single-use.
  if (!(await deleteProof(env, key, version))) {
    return { ok: false, detail: 'This domain proof token was already consumed.' }
  }
  await env.MPP_STORE.put(`providerDomainVerified:${providerId}`, JSON.stringify({
    domain, payTo, verifiedAt: new Date().toISOString(),
  }), { expirationTtl: 24 * 60 * 60 })
  return { ok: true, detail: `Domain control confirmed at ${sourceUrl}.` }
}

export async function getDomainProofEvidence(env: Env, providerId: string, url: string, payTo: string): Promise<string | null> {
  const raw = await env.MPP_STORE.get(`providerDomainVerified:${providerId}`)
  if (!raw) return null
  try {
    const evidence = JSON.parse(raw) as { domain: string; payTo: string; verifiedAt: string }
    return evidence.domain === new URL(url).hostname.toLowerCase() && evidence.payTo === payTo ? evidence.verifiedAt : null
  } catch { return null }
}
