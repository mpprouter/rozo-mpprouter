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
  let response: Response
  try {
    response = await fetch(`https://${domain}/.well-known/mpp-provider.json`, {
      headers: { Accept: 'application/json', 'User-Agent': 'mpprouter-domain-proof/1' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return { ok: false, detail: 'The well-known domain proof could not be fetched over HTTPS without redirects.' }
  }
  if (!response.ok) return { ok: false, detail: `The well-known domain proof returned HTTP ${response.status}.` }
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > MAX_MANIFEST_BYTES) return { ok: false, detail: 'The well-known domain proof is too large.' }
  let manifest: Record<string, unknown>
  try {
    const text = await readBoundedText(response, MAX_MANIFEST_BYTES)
    manifest = JSON.parse(text) as Record<string, unknown>
  } catch { return { ok: false, detail: 'The well-known domain proof is not valid JSON.' } }
  const token = String(manifest.token ?? '')
  if (
    token !== args.token ||
    String(manifest.domain ?? '').toLowerCase() !== domain ||
    String(manifest.provider_id ?? '') !== args.providerId ||
    String(manifest.pay_to ?? '') !== proof.payTo
  ) return { ok: false, detail: 'The manifest must bind the token, domain, provider ID and payout address.' }

  // Delete before publication. A retry needs a fresh token, making the proof single-use.
  if (!(await deleteProof(env, key, loaded.version))) {
    return { ok: false, detail: 'This domain proof token was already consumed.' }
  }
  await env.MPP_STORE.put(`providerDomainVerified:${args.providerId}`, JSON.stringify({
    domain, payTo: proof.payTo, verifiedAt: new Date().toISOString(),
  }), { expirationTtl: 24 * 60 * 60 })
  return { ok: true, detail: `Domain control confirmed at https://${domain}/.well-known/mpp-provider.json.` }
}

export async function getDomainProofEvidence(env: Env, providerId: string, url: string, payTo: string): Promise<string | null> {
  const raw = await env.MPP_STORE.get(`providerDomainVerified:${providerId}`)
  if (!raw) return null
  try {
    const evidence = JSON.parse(raw) as { domain: string; payTo: string; verifiedAt: string }
    return evidence.domain === new URL(url).hostname.toLowerCase() && evidence.payTo === payTo ? evidence.verifiedAt : null
  } catch { return null }
}
