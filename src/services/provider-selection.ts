/**
 * Minimal quality-based selection between self-serve provider routes.
 *
 * ## What "quality routing" means here, and what it does not
 *
 * The router picks, before any payment challenge is issued, which of
 * several EXPLICITLY interchangeable provider routes a buyer should call.
 * The pick is a recommendation the buyer then acts on by calling that
 * route's public path; the 402 they receive comes from that provider and
 * pays that provider's registered address. Nothing here runs after money
 * moves, so nothing here can switch the recipient mid-payment or pay
 * twice — the selection is bound to the quote by construction, because
 * the quote is issued by the selected route and by nobody else.
 *
 * "Explicitly interchangeable" is decided by `provider-capabilities.ts`:
 * two routes are candidates for the same request only when both declared
 * the same capability contract id. Nothing is inferred from names.
 *
 * A buyer who names a provider gets that provider or an error. They are
 * never handed a substitute, however much better the substitute scores.
 *
 * ## The ranking, in words
 *
 *   1. Offline providers (5 consecutive failed health probes) are excluded.
 *   2. Healthy providers with enough recent, fresh, provider-attributable
 *      samples rank first: higher success rate, then lower p50 latency,
 *      then lower price, then id — every tie broken deterministically.
 *   3. Healthy providers whose metrics are missing, too few or stale rank
 *      next, by price then id. "Unknown" is never scored as good or bad;
 *      it is scored as unknown and said so.
 *   4. Degraded providers rank last, ordered as in (2).
 *
 * `MIN_SAMPLES` and `STALE_AFTER_MS` are the two judgement calls, and both
 * are published in the response so a reader can see why a provider with
 * three perfect calls is still "insufficient".
 */

import type { Env } from '../index'
import { getCapability, type CapabilityContract } from './provider-capabilities'
import { listPublishedProviders, publicPathFor, type ProviderRecord, type ProviderRouteSpec } from './provider-registry'
import { getRouteQualityWithAvailability, isMetricsWindow, type MetricsWindow, type QualityAvailability } from './route-metrics'

/** Provider-attributable calls (ok + provider_fault) needed before a rate counts. */
export const MIN_SAMPLES = 5
/** Metrics whose newest call is older than this describe the past, not the present. */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000
export const DEFAULT_WINDOW: MetricsWindow = '7d'

export type SampleStatus = 'sufficient' | 'insufficient' | 'stale' | 'none' | 'unavailable'

export interface CandidateMetrics {
  window: MetricsWindow
  calls: number
  attributable: number
  provider_success_rate: number | null
  latency_p50_ms: number | null
  last_call_at: string | null
  sample_status: SampleStatus
}

export interface Candidate {
  provider_id: string
  provider_name: string
  route_id: string
  operation: string
  public_path: string
  method: 'GET' | 'POST'
  price_usd: string
  health_status: 'pending' | 'healthy' | 'degraded' | 'offline'
  dialect: 'x402' | 'mppx' | null
  pay_to: { network: string; address: string } | null
  metrics: CandidateMetrics
  eligible: boolean
  /** Why it ranks where it does, or why it was excluded. */
  reason: string
  /** Lower is better; only meaningful among eligible candidates. */
  tier: 0 | 1 | 2 | 3
}

export interface SelectionResult {
  capability: CapabilityContract
  window: MetricsWindow
  metrics_availability: QualityAvailability
  pinned_provider: string | null
  selected: Candidate | null
  candidates: Candidate[]
  policy: {
    min_samples: number
    stale_after_ms: number
    order: string[]
    note: string
  }
  error?: { code: string; detail: string }
}

function sampleStatus(m: { calls: number; ok: number; provider_fault: number; last_call_at: number | null }, availability: QualityAvailability, now: number): SampleStatus {
  if (availability !== 'ok') return 'unavailable'
  if (m.calls === 0) return 'none'
  if (m.last_call_at !== null && now - m.last_call_at > STALE_AFTER_MS) return 'stale'
  if (m.ok + m.provider_fault < MIN_SAMPLES) return 'insufficient'
  return 'sufficient'
}

function candidateFor(
  record: ProviderRecord,
  spec: ProviderRouteSpec,
  metrics: CandidateMetrics,
): Candidate {
  const health = record.verification.healthStatus ?? 'pending'
  const stellar = record.payouts.find(p => p.network.startsWith('stellar:')) ?? record.payouts[0]
  const base: Omit<Candidate, 'eligible' | 'reason' | 'tier'> = {
    provider_id: record.id,
    provider_name: record.name,
    route_id: `${record.id}_${spec.operation.replace(/-/g, '_')}`,
    operation: spec.operation,
    public_path: publicPathFor(record.id, spec.operation),
    method: spec.method,
    price_usd: spec.priceUsd,
    health_status: health,
    dialect: record.verification.challengeDialect ?? null,
    pay_to: stellar ? { network: stellar.network, address: stellar.payTo } : null,
    metrics,
  }
  if (health === 'offline') {
    return { ...base, eligible: false, tier: 3, reason: 'Excluded: health probes have failed 5 times in a row (offline).' }
  }
  const known = metrics.sample_status === 'sufficient'
  if (health === 'degraded') {
    return {
      ...base, eligible: true, tier: 2,
      reason: known
        ? `Ranked last: degraded (recent probe failures); ${pct(metrics.provider_success_rate)} success over ${metrics.attributable} calls.`
        : `Ranked last: degraded (recent probe failures); metrics ${metrics.sample_status}.`,
    }
  }
  if (known) {
    return {
      ...base, eligible: true, tier: 0,
      reason: `${pct(metrics.provider_success_rate)} success over ${metrics.attributable} provider-attributable calls in ${metrics.window}` +
        (metrics.latency_p50_ms !== null ? `, p50 ${metrics.latency_p50_ms} ms.` : '.'),
    }
  }
  return {
    ...base, eligible: true, tier: 1,
    reason: {
      none: `No calls recorded in ${metrics.window}; ranked after providers with data, by price.`,
      insufficient: `Only ${metrics.attributable} provider-attributable calls in ${metrics.window} (need ${MIN_SAMPLES}); ranked after providers with data, by price.`,
      stale: `Newest call is older than ${STALE_AFTER_MS / 3_600_000} h; ranked after providers with fresh data, by price.`,
      unavailable: 'Quality metrics are not readable on this deployment; ranked by price.',
      sufficient: '',
    }[metrics.sample_status],
  }
}

function pct(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`
}

function compare(a: Candidate, b: Candidate): number {
  if (a.tier !== b.tier) return a.tier - b.tier
  if (a.tier === 0 || a.tier === 2) {
    const ra = a.metrics.provider_success_rate ?? -1
    const rb = b.metrics.provider_success_rate ?? -1
    if (ra !== rb) return rb - ra
    const la = a.metrics.latency_p50_ms ?? Number.MAX_SAFE_INTEGER
    const lb = b.metrics.latency_p50_ms ?? Number.MAX_SAFE_INTEGER
    if (la !== lb) return la - lb
  }
  const pa = Number(a.price_usd)
  const pb = Number(b.price_usd)
  if (pa !== pb) return pa - pb
  return a.provider_id < b.provider_id ? -1 : a.provider_id > b.provider_id ? 1 : 0
}

/** Pure ranking over already-built candidates. Exported for the tests. */
export function rankCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(compare)
}

const POLICY_ORDER = [
  'exclude offline',
  'healthy + sufficient fresh samples: success rate desc, p50 latency asc, price asc, id asc',
  'healthy + none/insufficient/stale/unavailable samples: price asc, id asc',
  'degraded: success rate desc, p50 latency asc, price asc, id asc',
]

export async function selectProvider(
  env: Env,
  args: { capability: string; provider?: string; window?: string; now?: number },
): Promise<SelectionResult | { error: { code: string; detail: string; status: number } }> {
  const contract = getCapability(args.capability)
  if (!contract) {
    return { error: { status: 404, code: 'unknown_capability', detail: `No capability contract "${args.capability}".` } }
  }
  const window: MetricsWindow = args.window && isMetricsWindow(args.window) ? args.window : DEFAULT_WINDOW
  const now = args.now ?? Date.now()
  const pinned = args.provider ? args.provider.trim().toLowerCase() : null

  const providers = (await listPublishedProviders(env)).filter(p => p.status === 'published')
  const candidates: Candidate[] = []
  let availability: QualityAvailability = 'ok'
  for (const record of providers) {
    for (const spec of record.routes) {
      if (spec.capability !== contract.id) continue
      const quality = await getRouteQualityWithAvailability(env, record.id)
      if (quality.availability !== 'ok') availability = quality.availability
      const stats = quality.stats[window]
      const metrics: CandidateMetrics = {
        window,
        calls: stats.calls,
        attributable: stats.ok + stats.provider_fault,
        provider_success_rate: stats.provider_success_rate,
        latency_p50_ms: stats.latency_p50_ms,
        last_call_at: stats.last_call_at === null ? null : new Date(stats.last_call_at).toISOString(),
        sample_status: sampleStatus(stats, quality.availability, now),
      }
      candidates.push(candidateFor(record, spec, metrics))
    }
  }

  const ranked = rankCandidates(candidates)
  const base: SelectionResult = {
    capability: contract,
    window,
    metrics_availability: availability,
    pinned_provider: pinned,
    selected: null,
    candidates: ranked,
    policy: {
      min_samples: MIN_SAMPLES,
      stale_after_ms: STALE_AFTER_MS,
      order: POLICY_ORDER,
      note:
        'Capability contracts are declared by providers and not certified by the router. ' +
        'The selected route\'s 402 is issued by that provider and pays that provider\'s registered address; ' +
        'the router issues no challenge and never changes the recipient after selection. ' +
        'A pinned provider is returned or refused, never substituted.',
    },
  }

  if (pinned) {
    const mine = ranked.find(c => c.provider_id === pinned)
    if (!mine) {
      return { ...base, error: { code: 'pinned_provider_not_found', detail: `Provider "${pinned}" has no published route declaring ${contract.id}.` } }
    }
    if (!mine.eligible) {
      return { ...base, error: { code: 'pinned_provider_offline', detail: `Provider "${pinned}" is offline. No substitute is chosen for a pinned provider.` } }
    }
    return { ...base, selected: mine }
  }

  const first = ranked.find(c => c.eligible) ?? null
  return first
    ? { ...base, selected: first }
    : { ...base, error: { code: 'no_eligible_provider', detail: `No published, non-offline provider declares ${contract.id}.` } }
}
