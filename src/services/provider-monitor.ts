import type { Env } from '../index'
import { getProviderRecord, listPublishedProviders, putProviderRecord } from './provider-registry'
import { chooseVerificationRoute, gateProbe402 } from './provider-verification'

const DEGRADED_AFTER = 2
const OFFLINE_AFTER = 5

export async function monitorPublishedProviders(env: Env): Promise<void> {
  const providers = await listPublishedProviders(env)
  if (providers.length === 0) return
  const cursorKey = 'providerMonitorCursor:v1'
  const rawCursor = await env.MPP_STORE.get(cursorKey)
  const start = Math.max(0, Number(rawCursor) || 0) % providers.length
  const batch = Array.from({ length: Math.min(10, providers.length) }, (_, offset) => providers[(start + offset) % providers.length])
  for (const indexed of batch) {
    // The index is derived and may lag a re-registration or suspension. It is
    // only a source of candidate ids; all work starts from the authoritative row.
    const record = await getProviderRecord(env, indexed.id)
    if (!record || record.status !== 'published') continue
    const observedUpdatedAt = record.updatedAt
    const result = await gateProbe402(record, chooseVerificationRoute(record))
    const now = new Date().toISOString()
    const previous = record.verification.consecutiveProbeFailures ?? 0
    if (result.ok) {
      record.verification.lastReachableAt = now
      record.verification.consecutiveProbeFailures = 0
      record.verification.healthStatus = 'healthy'
      record.verification.lastError = undefined
    } else {
      const failures = previous + 1
      record.verification.consecutiveProbeFailures = failures
      record.verification.healthStatus = failures >= OFFLINE_AFTER ? 'offline' : failures >= DEGRADED_AFTER ? 'degraded' : 'healthy'
      record.verification.lastError = `health (${result.code}): ${result.detail}`
    }
    // The probe is an external call. Re-read after it so a concurrent
    // re-registration/suspension is never replaced with the old published row.
    const latest = await getProviderRecord(env, record.id)
    if (!latest || latest.status !== 'published' || latest.updatedAt !== observedUpdatedAt) continue
    latest.verification = record.verification
    latest.updatedAt = now
    await putProviderRecord(env, latest)
  }
  await env.MPP_STORE.put(cursorKey, String((start + batch.length) % providers.length))
}
