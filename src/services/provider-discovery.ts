import type { Env } from '../index'
import type { ProviderDiscovery, ProviderRecord } from './provider-registry'
import { getProviderRecord, listPublishedProviders, publicPathFor, putProviderRecord } from './provider-registry'

export async function submitPartnerDiscovery(env: Env, record: ProviderRecord): Promise<ProviderDiscovery> {
  const attemptedAt = new Date().toISOString()
  if (!env.PROVIDER_DISCOVERY_SUBMIT_URL) {
    return { submissionStatus: 'not_submitted', lastAttemptAt: attemptedAt, lastError: 'Partner discovery adapter is not configured.' }
  }
  try {
    const response = await fetch(env.PROVIDER_DISCOVERY_SUBMIT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Concurrent verify/cron attempts describe the same provider version.
        // Partners that honor idempotency keys will create one submission.
        'Idempotency-Key': `mpprouter-provider-${record.id}-${record.updatedAt}`,
        ...(env.PROVIDER_DISCOVERY_API_KEY ? { Authorization: `Bearer ${env.PROVIDER_DISCOVERY_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        provider_id: record.id,
        name: record.name,
        routes: record.routes.map(route => ({
          url: `https://apiserver.mpprouter.dev${publicPathFor(record.id, route.operation)}`,
          method: route.method,
          price_usd: route.priceUsd,
        })),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return failedDiscovery(attemptedAt, `Partner returned HTTP ${response.status}.`)
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    return {
      submissionStatus: 'submitted', submittedAt: attemptedAt, lastAttemptAt: attemptedAt,
      ...(body.submission_id ? { submissionId: String(body.submission_id) } : {}),
      ...(body.resource_id ? { resourceId: String(body.resource_id) } : {}),
      ...(body.discovery_url ? { discoveryUrl: String(body.discovery_url) } : {}),
    }
  } catch (error) {
    return failedDiscovery(attemptedAt, error instanceof Error ? error.message : 'Partner submission failed.')
  }
}

function failedDiscovery(attemptedAt: string, lastError: string): ProviderDiscovery {
  return {
    submissionStatus: 'failed', lastAttemptAt: attemptedAt, lastError,
    nextAttemptAt: new Date(Date.parse(attemptedAt) + 5 * 60_000).toISOString(),
  }
}

/** Submit using a fresh authoritative row, then merge only discovery evidence. */
export async function submitAndPersistPartnerDiscovery(env: Env, providerId: string): Promise<void> {
  const record = await getProviderRecord(env, providerId)
  if (!record || record.status !== 'published' || record.discovery?.submissionStatus === 'submitted') return
  if (record.discovery?.nextAttemptAt && Date.parse(record.discovery.nextAttemptAt) > Date.now()) return
  const observedUpdatedAt = record.updatedAt
  const discovery = await submitPartnerDiscovery(env, record)
  const latest = await getProviderRecord(env, providerId)
  if (!latest || latest.status !== 'published' || latest.updatedAt !== observedUpdatedAt) return
  latest.discovery = discovery
  latest.updatedAt = new Date().toISOString()
  await putProviderRecord(env, latest)
}

export async function retryPartnerDiscoveries(env: Env): Promise<void> {
  if (!env.PROVIDER_DISCOVERY_SUBMIT_URL) return
  const providers = await listPublishedProviders(env)
  if (providers.length === 0) return
  const cursorKey = 'providerDiscoveryCursor:v1'
  const start = Math.max(0, Number(await env.MPP_STORE.get(cursorKey)) || 0) % providers.length
  const ordered = Array.from({ length: providers.length }, (_, offset) => providers[(start + offset) % providers.length])
  const due = ordered.filter(item =>
    item.discovery?.submissionStatus !== 'submitted' &&
    (!item.discovery?.nextAttemptAt || Date.parse(item.discovery.nextAttemptAt) <= Date.now()),
  ).slice(0, 5)
  for (const indexed of due) {
    await submitAndPersistPartnerDiscovery(env, indexed.id)
  }
  await env.MPP_STORE.put(cursorKey, String((start + Math.max(1, due.length)) % providers.length))
}
