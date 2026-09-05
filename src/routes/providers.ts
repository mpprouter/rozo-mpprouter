/**
 * `POST /v1/providers/*` — self-serve provider onboarding.
 *
 * The whole surface, in the order a provider meets it:
 *
 *   GET  /v1/providers/challenge   — the exact string to sign, plus a nonce
 *   POST /v1/providers/register    — signed registration; stores `pending`
 *   POST /v1/providers/verify      — runs both gates; publishes on pass
 *   GET  /v1/providers/:id         — public status (no email, no signatures)
 *   POST /v1/providers/sponsor     — offer to open their Stellar account
 *
 * ## Ownership proof: three accepted forms, none of them a ROZO decision
 *
 * Registration must prove the payout address belongs to the party serving
 * the API. Since 2026-09-05 that can be a wallet signature, a challenge
 * token served under the provider's `/.well-known/`, or a match between
 * the registration and the provider's own live 402 `payTo`. The reasoning,
 * and what each form does and does not establish, is in
 * `services/provider-ownership.ts`. A wallet signature is no longer
 * required — the first real provider refused to take their treasury key
 * out for it, and a gate nobody passes protects nobody.
 *
 * No ROZO human appears in any of them. That is SCF Tranche 3's second
 * criterion, and it is why registration cannot be "email us and we will add
 * you to the snapshot" however quickly we answer the email.
 *
 * ## The surface is gated off by default
 *
 * Every route here 404s unless `PROVIDERS_ENDPOINT_ENABLED === 'true'`,
 * matching the coupon/partner/admin surfaces. A 404 rather than a 403: an
 * endpoint that is off should be indistinguishable from an endpoint that
 * does not exist, so probing tells an attacker nothing about what this
 * deployment could do if a flag moved.
 */

import type { Env } from '../index'
import { checkAndBumpWindowLimit } from '../mpp/rate-limit-do'
import {
  getProviderRecord,
  putProviderRecord,
  validateRegistration,
  publicPathFor,
  ProviderValidationError,
  type ProviderRecord,
  type ProviderCheck,
} from '../services/provider-registry'
import {
  buildSignatureMessage,
  registrationDigest,
  isSupportedPayoutNetwork,
  ProviderAuthError,
  SIGNATURE_REALM,
} from '../services/provider-auth'
import {
  resolveOwnershipProof,
  assertNoProofDowngrade,
  OWNERSHIP_PROOF_GUIDE,
} from '../services/provider-ownership'
import {
  chooseVerificationRoute,
  gateProbe402,
  gateRealMoneyCall,
} from '../services/provider-verification'
import { registerWithMppScan } from '../services/provider-listing'
import { submitAndPersistPartnerDiscovery } from '../services/provider-discovery'
import { sponsorStellarAccount } from '../services/provider-sponsor'
import { consumeDomainProof, getDomainProofEvidence, issueDomainProof } from '../services/provider-domain-proof'
import { inspectProviderUrl } from '../services/provider-check'
import { readProviderRevenue } from '../services/provider-revenue'
import { getStats } from '../services/stats'
import { issueDashboardToken, verifyDashboardToken } from '../services/provider-dashboard-auth'
import { runClaimedPaidGate } from '../services/provider-verify-claim'

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function providersEnabled(env: Env): boolean {
  return env.PROVIDERS_ENDPOINT_ENABLED === 'true'
}

/**
 * Registration and verification both write, and verification spends real
 * money, so they are limited harder than the read-only endpoints in this
 * repo: 5 requests per minute per IP. Enforced through the ATOMIC_STORE DO
 * for the same reason `/v1/ledger` is — a KV read-then-put throttle does
 * not bind concurrent callers, and "concurrent callers" is the entire
 * threat model for an unauthenticated endpoint that can make us sign a
 * payment.
 */
const WRITE_WINDOW_MS = 60_000
const WRITE_REQUESTS_PER_WINDOW = 5

async function throttleRequest(request: Request, env: Env, bucket: string, clientLimit = WRITE_REQUESTS_PER_WINDOW, ipLimit = 30): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const rawClientId = request.headers.get('X-MPP-Client-Id') ?? ''
  const clientId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawClientId)
    ? rawClientId.toLowerCase() : 'anonymous'
  try {
    const ipVerdict = await checkAndBumpWindowLimit(
      env,
      `ratelimit:providers:${bucket}:ip:${ip}`,
      ipLimit,
      WRITE_WINDOW_MS,
    )
    const clientVerdict = ipVerdict.ok ? await checkAndBumpWindowLimit(
      env,
      `ratelimit:providers:${bucket}:client:${ip}:${clientId}`,
      clientLimit,
      WRITE_WINDOW_MS,
    ) : ipVerdict
    if (!ipVerdict.ok || !clientVerdict.ok) {
      return json(429, {
        error: 'rate_limited',
        detail: 'Too many requests for this onboarding step. Retry in one minute.',
      })
    }
    return null
  } catch {
    // Fail CLOSED. The other direction would mean a platform hiccup on the
    // limiter unlocks the one endpoint in this router that signs a payment
    // to an address a stranger supplied.
    return json(503, { error: 'rate_limiter_unavailable' })
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  // 64 KB. A registration is a few hundred bytes; anything approaching this
  // is someone testing what we will parse.
  if (text.length > 65_536) throw new ProviderValidationError('body', 'Request body too large.')
  try {
    return JSON.parse(text)
  } catch {
    throw new ProviderValidationError('body', 'Body is not valid JSON.')
  }
}

/** Public view of a record. Email, signatures and owner key never appear. */
function publicView(record: ProviderRecord) {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    api_base_url: record.apiBaseUrl,
    settlement: 'direct',
    payouts: record.payouts.map(p => ({ network: p.network, pay_to: p.payTo, asset: p.asset })),
    routes: record.routes.map(r => ({
      operation: r.operation,
      method: r.method,
      price_usd: r.priceUsd,
      public_path: publicPathFor(record.id, r.operation),
    })),
    verification: {
      probe_402_at: record.verification.probe402At ?? null,
      paid_call_at: record.verification.paidCallAt ?? null,
      paid_call_tx: record.verification.paidCallTxHash ?? null,
      paid_call_network: record.verification.paidCallNetwork ?? null,
      last_error: record.verification.lastError ?? null,
      last_attempt_at: record.verification.lastAttemptAt ?? null,
      domain_verified_at: record.verification.domainVerifiedAt ?? null,
      ownership_proof: record.verification.ownershipProof ?? record.ownerKey.proof ?? null,
      last_reachable_at: record.verification.lastReachableAt ?? null,
      health_status: record.verification.healthStatus ?? 'pending',
      checks: record.verification.checks ?? [],
    },
    labels: {
      endpoint_and_settlement: record.status === 'published' ? 'Endpoint and settlement checked' : null,
      router_listing: record.status === 'published' ? 'Listed on MPP Router' : null,
      partner_submission: record.discovery?.submissionStatus === 'submitted' ? 'Submitted to partner discovery' : null,
      partner_discovery: record.discovery?.resourceId && record.discovery?.discoveryUrl ? 'Discoverable on partner' : null,
      degraded: ['degraded', 'offline'].includes(record.verification.healthStatus ?? '') ? 'Service degraded' : null,
    },
    discovery: record.discovery ?? { submissionStatus: 'not_submitted' },
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}

// ---------------------------------------------------------------------
// GET /v1/providers/challenge
// ---------------------------------------------------------------------

/**
 * Hand back the exact bytes to sign.
 *
 * The provider could assemble this themselves from the docs, and the ones
 * who do will get an identical string — the format is deterministic. It
 * exists because "your signature did not verify" is a miserable error to
 * debug against a message you rebuilt by hand, and a mismatched newline
 * would otherwise be indistinguishable from a wrong key.
 */
export async function handleProviderChallenge(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const providerId = (url.searchParams.get('id') ?? '').trim().toLowerCase()
  const network = (url.searchParams.get('network') ?? '').trim()
  const address = (url.searchParams.get('address') ?? '').trim()
  const digest = (url.searchParams.get('digest') ?? '').trim()

  if (!providerId || !network || !address) {
    return json(400, {
      error: 'missing_parameter',
      detail: 'id, network and address are required.',
      example: '/v1/providers/challenge?id=acme&network=stellar:pubnet&address=G...',
    })
  }
  if (!isSupportedPayoutNetwork(network)) {
    return json(400, {
      error: 'unsupported_network',
      detail: `Cannot verify a signature on "${network}".`,
      supported: ['stellar:pubnet', 'eip155:<chainId>', 'solana:mainnet'],
    })
  }

  const nonce = crypto.randomUUID().replace(/-/g, '')
  const issuedAt = new Date().toISOString()
  const message = buildSignatureMessage({
    providerId,
    network,
    address,
    // Empty until the caller has a registration to digest; the register
    // endpoint recomputes it from the submitted body and will reject a
    // signature over a placeholder. Documented rather than silently
    // tolerated, because a provider who signs this without the digest
    // gets a clear failure instead of a published-but-unbound record.
    digest: digest || '<compute with POST /v1/providers/register dry_run=true>',
    issuedAt,
    nonce,
  })

  return json(200, {
    realm: SIGNATURE_REALM,
    message,
    nonce,
    issued_at: issuedAt,
    expires_in_seconds: 600,
    signature_encoding: network.startsWith('eip155:') ? '0x-hex (EIP-191 personal_sign)' : 'base64 (ed25519)',
    note:
      'Sign this exact string, newlines included. Submit it with the same nonce and issued_at. ' +
      'Get the registration digest first with POST /v1/providers/register {"dry_run": true, ...}.',
    // A signature is one of three accepted proofs, not the only one. A
    // provider whose payout address is a treasury key should not have to
    // take it out to list a service.
    alternatives: [OWNERSHIP_PROOF_GUIDE.well_known, OWNERSHIP_PROOF_GUIDE.x402_pay_to],
  })
}

// ---------------------------------------------------------------------
// POST /v1/providers/register
// ---------------------------------------------------------------------

export async function handleProviderRegister(request: Request, env: Env): Promise<Response> {
  const throttled = await throttleRequest(request, env, 'register')
  if (throttled) return throttled

  let body: any
  try {
    body = await readJson(request)
  } catch (err: any) {
    return json(400, { error: 'invalid_body', field: err.field, detail: err.message })
  }

  let validated
  try {
    validated = validateRegistration(body)
  } catch (err: any) {
    if (err instanceof ProviderValidationError) {
      return json(400, { error: 'invalid_registration', field: err.field, detail: err.message })
    }
    throw err
  }

  for (const payout of validated.payouts) {
    if (!isSupportedPayoutNetwork(payout.network)) {
      return json(400, {
        error: 'unsupported_network',
        field: 'payouts',
        detail:
          `We cannot verify ownership of an address on "${payout.network}", so we will not ` +
          'publish it as a payout destination. Supported: stellar:*, eip155:*, solana:*.',
      })
    }
  }

  const digest = await registrationDigest(validated)

  // Dry run: hand back the digest so the provider can build the exact
  // message to sign. Nothing is stored and no signature is required.
  if (body?.dry_run === true) {
    return json(200, {
      dry_run: true,
      digest,
      messages: validated.payouts.map(p => ({
        network: p.network,
        address: p.payTo,
        note: 'Fetch /v1/providers/challenge with this digest to get the exact string, or build it from the docs.',
      })),
      ownership_proofs: Object.values(OWNERSHIP_PROOF_GUIDE),
    })
  }

  const existing = await getProviderRecord(env, validated.id)
  if (existing) {
    // Re-registration is allowed only by the key that owns the record, and
    // only against a signature over the NEW payload. Without the ownership
    // check, whoever registers a popular-sounding id first can be displaced
    // by anyone; with it, the record belongs to a key, not to a name.
    if (existing.status === 'suspended') {
      return json(403, {
        error: 'suspended',
        detail: 'This provider id is suspended. Contact support.',
      })
    }
    const ownerStillDeclared = validated.payouts.some(
      p => p.network === existing.ownerKey.network && p.payTo === existing.ownerKey.address,
    )
    if (!ownerStillDeclared) {
      return json(403, {
        error: 'not_owner',
        detail:
          `Provider id "${validated.id}" is registered to a different key. ` +
          'An update must keep, and re-sign with, the address that first registered it.',
      })
    }
  }

  let auth
  try {
    auth = await resolveOwnershipProof(env, {
      providerId: validated.id,
      digest,
      apiBaseUrl: validated.apiBaseUrl,
      payouts: validated.payouts,
      routes: validated.routes,
      body: (body ?? {}) as Record<string, unknown>,
    })
    // A record established by a signature cannot be re-pointed by a weaker
    // proof. Checked after the proof runs so the caller learns their proof
    // was valid AND insufficient, rather than guessing.
    assertNoProofDowngrade(existing?.ownerKey.proof, auth.proof)
  } catch (err: any) {
    if (err instanceof ProviderAuthError) {
      return json(401, {
        error: 'ownership_proof_rejected',
        code: err.code,
        detail: err.message,
        accepted_proofs: Object.values(OWNERSHIP_PROOF_GUIDE),
      })
    }
    throw err
  }

  const now = new Date().toISOString()
  const dashboardCredential = await issueDashboardToken()
  // A proof that already demonstrated control of the origin carries its own
  // timestamp; a wallet signature does not, and still relies on a separately
  // completed domain proof exactly as before.
  const domainVerifiedAt =
    auth.domainVerifiedAt ??
    (await getDomainProofEvidence(env, validated.id, validated.apiBaseUrl, auth.ownerKey.address))
  const record: ProviderRecord = {
    id: validated.id,
    name: validated.name,
    email: validated.email,
    apiBaseUrl: validated.apiBaseUrl,
    payouts: validated.payouts,
    routes: validated.routes,
    // Always `pending`, including on re-registration of a published
    // provider: the new payload may name a new address or a new origin, and
    // the old verification says nothing about either. Re-verifying is the
    // point — a published record must never describe an unverified claim.
    status: 'pending',
    verification: {
      domainVerifiedAt: domainVerifiedAt ?? undefined,
      ownershipProof: auth.proof,
      healthStatus: 'pending',
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ownerKey: existing?.ownerKey ?? auth.ownerKey,
    registrationVersion: digest,
    dashboardTokenHash: dashboardCredential.hash,
  }
  await putProviderRecord(env, record)

  return json(201, {
    ...publicView(record),
    ownership_proof: { type: auth.proof, detail: auth.detail },
    dashboard_token: dashboardCredential.token,
    next_step: {
      endpoint: 'POST /v1/providers/verify',
      body: { id: record.id },
      detail:
        'Deploy your endpoint, then call verify. We probe your 402 for free, then pay one ' +
        'minimal call for real and confirm on-chain that the money reached your address. ' +
        'On success your routes appear in /services with no further action.',
    },
  })
}

// ---------------------------------------------------------------------
// POST /v1/providers/verify
// ---------------------------------------------------------------------

export async function handleProviderVerify(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const throttled = await throttleRequest(request, env, 'verify')
  if (throttled) return throttled

  let body: any
  try {
    body = await readJson(request)
  } catch (err: any) {
    return json(400, { error: 'invalid_body', detail: err.message })
  }

  const id = String(body?.id ?? '').trim().toLowerCase()
  if (!id) return json(400, { error: 'missing_parameter', detail: 'id is required.' })

  const record = await getProviderRecord(env, id)
  if (!record) return json(404, { error: 'not_found', detail: `No registration for "${id}".` })
  if (record.status === 'published') {
    return json(200, { ...publicView(record), published: true, idempotent: true, evidence: {
      settlement_tx: record.verification.paidCallTxHash ?? null,
      paid_call_at: record.verification.paidCallAt ?? null,
    } })
  }
  if (record.status === 'suspended') {
    return json(403, { error: 'suspended', detail: 'This provider is suspended.' })
  }
  const observedUpdatedAt = record.updatedAt
  // Records created before registrationVersion shipped derive the exact same
  // canonical signed-payload digest. No random initialization race is possible.
  const verificationEpoch = record.registrationVersion ?? await registrationDigest({
    id: record.id,
    name: record.name,
    email: record.email,
    apiBaseUrl: record.apiBaseUrl,
    payouts: record.payouts,
    routes: record.routes,
  })
  if (!record.verification.domainVerifiedAt) {
    record.verification.checks = buildChecks(record, undefined, undefined, 'Domain control has not been confirmed.')
    return json(422, { error: 'verification_failed', gate: 'ownership', detail: 'Domain control and settlement-wallet control must both pass.', checks: record.verification.checks })
  }

  const spec = chooseVerificationRoute(record)
  const attemptAt = new Date().toISOString()

  const probe = await gateProbe402(record, spec)
  if (!probe.ok) {
    record.verification = {
      ...record.verification,
      lastError: `probe-402 (${probe.code}): ${probe.detail}`,
      lastAttemptAt: attemptAt,
      checks: buildChecks(record, probe),
    }
    const latest = await getProviderRecord(env, id)
    if (!latest || latest.status !== record.status || latest.updatedAt !== observedUpdatedAt) {
      return json(409, { error: 'registration_changed', detail: 'Registration changed during verification. Retry against the latest version.' })
    }
    latest.verification = record.verification
    latest.updatedAt = attemptAt
    await putProviderRecord(env, latest)
    return json(422, {
      error: 'verification_failed',
      gate: 'probe-402',
      code: probe.code,
      detail: probe.detail,
      probed: { operation: spec.operation, method: spec.method },
      checks: buildChecks(record, probe),
    })
  }

  const claimed = await runClaimedPaidGate(env, record.id, verificationEpoch, () => gateRealMoneyCall(env, record, spec))
  if (claimed.status === 'in_progress') {
    return json(202, { status: 'verification_in_progress', retry_after_seconds: claimed.retryAfterSeconds })
  }
  if (claimed.status === 'uncertain') {
    return json(409, { error: 'payment_outcome_uncertain', detail: claimed.detail, retry: 'manual_status_check_required' })
  }
  const paid = claimed.result
  if (!paid.ok) {
    record.verification = {
      ...record.verification,
      probe402At: attemptAt,
      lastError: `real-money (${paid.code}): ${paid.detail}`,
      lastAttemptAt: attemptAt,
      checks: buildChecks(record, probe, paid),
    }
    const latest = await getProviderRecord(env, id)
    if (!latest || latest.status !== record.status || latest.updatedAt !== observedUpdatedAt) {
      return json(409, { error: 'registration_changed', detail: 'Registration changed during verification. Retry against the latest version.' })
    }
    latest.verification = record.verification
    latest.updatedAt = attemptAt
    await putProviderRecord(env, latest)
    // `gate_unavailable` is our missing configuration, not their failure,
    // so it reads as 503 rather than as a rejection of their endpoint.
    const status = paid.code === 'gate_unavailable' ? 503 : 422
    return json(status, {
      error: 'verification_failed',
      gate: 'real-money',
      code: paid.code,
      detail: paid.detail,
      probe_402: 'passed',
      checks: buildChecks(record, probe, paid),
    })
  }

  const publishedAt = new Date().toISOString()
  record.verification = {
    probe402At: attemptAt,
    ownershipProof: record.verification.ownershipProof,
    paidCallAt: publishedAt,
    paidCallTxHash: paid.txHash,
    paidCallNetwork: paid.network,
    domainVerifiedAt: record.verification.domainVerifiedAt,
    lastReachableAt: publishedAt,
    healthStatus: 'healthy',
    consecutiveProbeFailures: 0,
    checks: buildChecks(record, probe, paid),
  }
  const latest = await getProviderRecord(env, id)
  if (!latest || latest.status !== record.status || latest.updatedAt !== observedUpdatedAt) {
    return json(409, { error: 'registration_changed', detail: 'Registration changed during verification. The paid probe was not used to publish stale configuration; retry.' })
  }
  latest.verification = record.verification
  latest.status = 'published'
  latest.updatedAt = publishedAt
  await putProviderRecord(env, latest)

  // External listing is best-effort and deliberately off the critical
  // path: MPPScan being down must not un-publish a provider who has
  // already proven a paid call settled to their own key.
  ctx.waitUntil(registerWithMppScan(env, latest).catch(() => {}))
  ctx.waitUntil(submitAndPersistPartnerDiscovery(env, latest.id))

  return json(200, {
    ...publicView(latest),
    published: true,
    evidence: {
      probe_402: probe.detail,
      real_money: paid.detail,
      settlement_tx: paid.txHash,
      settled_to: latest.payouts.find(p => p.network.startsWith('stellar:'))?.payTo,
    },
    catalog: latest.routes.map(r => publicPathFor(latest.id, r.operation)),
  })
}

function buildChecks(record: ProviderRecord, probe?: { ok: boolean; detail: string; code?: string }, paid?: { ok: boolean; detail: string }, ownershipError?: string): ProviderCheck[] {
  const checkedAt = new Date().toISOString()
  const unreachable = probe?.ok === false && probe.code === 'unreachable'
  const serviceFailure = probe?.ok === false && ['not_402', 'unparseable_challenge'].includes(probe.code ?? '')
  const websitePassed = probe ? !unreachable : false
  const servicePassed = probe?.ok === true || (probe?.ok === false && !unreachable && !serviceFailure)
  return [
    { key: 'website_reachable', label: 'Website reachable', status: probe ? websitePassed ? 'passed' : 'failed' : 'pending', detail: websitePassed ? 'The HTTPS endpoint responded.' : probe?.detail ?? 'Not checked.', checkedAt },
    { key: 'service_discovered', label: 'Service discovered', status: probe ? servicePassed ? 'passed' : 'failed' : 'pending', detail: probe?.detail ?? 'Not checked.', checkedAt },
    { key: 'payment_configured', label: 'Payment configured', status: probe?.ok ? 'passed' : probe ? 'failed' : 'pending', detail: probe?.detail ?? 'Not checked.', checkedAt },
    { key: 'ownership_confirmed', label: 'Ownership confirmed', status: record.verification.domainVerifiedAt && !ownershipError ? 'passed' : 'failed', detail: ownershipError ?? 'Domain and settlement-wallet control confirmed.', checkedAt },
    { key: 'paid_call_works', label: 'Paid call works', status: paid?.ok ? 'passed' : paid ? 'failed' : 'pending', detail: paid?.detail ?? 'Not checked.', checkedAt },
  ]
}

export async function handleProviderCheck(request: Request, env: Env): Promise<Response> {
  const throttled = await throttleRequest(request, env, 'check')
  if (throttled) return throttled
  try {
    const body = await readJson(request) as Record<string, unknown>
    const url = String(body.url ?? '').trim()
    const inspected = await inspectProviderUrl(url)
    const host = new URL(url).hostname.toLowerCase()
    const providerId = host.replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
    const payTo = inspected.draft?.payouts[0]?.pay_to
    const domainProof = inspected.draft && payTo && providerId.length >= 3
      ? await issueDomainProof(env, { providerId, url, payTo }) : null
    const registration = inspected.draft ? {
      id: providerId,
      name: host.replace(/^www\./, ''),
      email: '',
      ...inspected.draft,
    } : null
    return json(200, { provider_id: providerId || null, registration, checks: inspected.checks, domain_proof: domainProof })
  } catch (error) {
    return json(422, { error: 'check_failed', detail: error instanceof Error ? error.message : 'Service check failed.' })
  }
}

export async function handleProviderDomainVerify(request: Request, env: Env): Promise<Response> {
  const throttled = await throttleRequest(request, env, 'domain-verify')
  if (throttled) return throttled
  try {
    const body = await readJson(request) as Record<string, unknown>
    const result = await consumeDomainProof(env, {
      providerId: String(body.provider_id ?? '').trim().toLowerCase(), url: String(body.url ?? '').trim(), token: String(body.token ?? ''),
    })
    return json(result.ok ? 200 : 422, result)
  } catch (error) {
    return json(400, { error: 'invalid_domain_proof', detail: error instanceof Error ? error.message : 'Invalid domain proof.' })
  }
}

export async function handleProviderDashboard(request: Request, env: Env, id: string): Promise<Response> {
  const throttled = await throttleRequest(request, env, 'dashboard', 30, 120)
  if (throttled) return throttled
  const record = await getProviderRecord(env, id.trim().toLowerCase())
  if (!record) return json(404, { error: 'not_found' })
  if (!(await verifyDashboardToken(request.headers.get('authorization'), record.dashboardTokenHash))) {
    return json(401, { error: 'unauthorized', detail: 'Valid dashboard credentials are required.' })
  }
  const cacheKey = `providerDashboardCache:${id}`
  const cached = await env.MPP_STORE.get(cacheKey)
  if (cached) return json(200, JSON.parse(cached))
  const revenue = await readProviderRevenue(env, record)
  let activity: unknown
  try {
    const stats = await getStats(env, '30d')
    const service = stats.services.find(item => item.service_id === record.id)
    activity = {
      status: stats.coverage.quality_availability === 'ok' ? 'available' : 'unavailable',
      window: stats.window,
      coverage: stats.coverage,
      truncated: stats.truncated,
      service: service ?? null,
    }
  } catch {
    activity = { status: 'unavailable', window: '30d', detail: 'Paid-call metrics could not be read; no zero values are substituted.' }
  }
  const payload = { provider: publicView(record), revenue, activity }
  await env.MPP_STORE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 })
  return json(200, payload)
}

// ---------------------------------------------------------------------
// GET /v1/providers/:id
// ---------------------------------------------------------------------

export async function handleProviderGet(env: Env, id: string): Promise<Response> {
  const record = await getProviderRecord(env, id.trim().toLowerCase())
  if (!record) return json(404, { error: 'not_found' })
  return json(200, publicView(record))
}

// ---------------------------------------------------------------------
// POST /v1/providers/sponsor
// ---------------------------------------------------------------------

/**
 * Open a Stellar account for a provider who does not have one.
 *
 * The offer in §1 of the spec, made concrete: a Base-native provider's only
 * friction to settling on Stellar is the ~1.5 XLM account reserve and a
 * USDC trustline, and we already run a gas sponsor. Funding somebody's
 * account reserve does not put us anywhere near their money path — we
 * create the account and never hold a key to it, so the payout gate is
 * untouched. The outward phrasing is "we'll open the address for you", not
 * "we'll hold it for you", because the second one would be false.
 */
export async function handleProviderSponsor(request: Request, env: Env): Promise<Response> {
  const throttled = await throttleRequest(request, env, 'sponsor')
  if (throttled) return throttled

  let body: any
  try {
    body = await readJson(request)
  } catch (err: any) {
    return json(400, { error: 'invalid_body', detail: err.message })
  }

  const address = String(body?.address ?? '').trim()
  if (!address) {
    return json(400, { error: 'missing_parameter', detail: 'address (G…) is required.' })
  }

  const result = await sponsorStellarAccount(env, address)
  if (!result.ok) {
    return json(result.status, { error: result.code, detail: result.detail })
  }
  return json(200, {
    sponsored: true,
    address,
    funded_xlm: result.fundedXlm,
    tx_hash: result.txHash,
    next_step:
      'Add a USDC trustline from your own wallet — the reserve for it is already funded. ' +
      'The account is yours; we hold no key to it.',
  })
}
