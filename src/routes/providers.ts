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
import { readClaimState, reconcileUncertainClaim, runClaimedPaidGate } from '../services/provider-verify-claim'
import { assertSettledToProvider, MAX_VERIFY_PAYMENT_USD, verifyWalletPaidProviderSince, verifyWalletPublicKey, type GateResult } from '../services/provider-verification'
import { CAPABILITY_CONTRACTS } from '../services/provider-capabilities'
import {
  hostedOriginFor,
  hostedProviderIdFor,
  hostingAvailable,
  sealHosting,
  validateHosting,
  type StoredHosting,
} from '../services/provider-hosting'

/**
 * fetch for verification probes: a hosted hostname is this Worker, and the
 * platform refuses a Worker's network request to itself, so those go
 * through the SELF service binding. Everything else is a normal fetch.
 */
function routerFetch(env: Env): typeof fetch {
  return (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (env.SELF && hostedProviderIdFor(env, new URL(url).hostname)) return env.SELF.fetch(new Request(url, init))
    return fetch(input, init)
  }
}

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

/**
 * Claim a provider id for a first registration, atomically.
 *
 * Two concurrent registrations for the same id can both read
 * `existing === null`, and the second would then overwrite the first
 * without ever facing the dashboard-token check that guards an update. The
 * ATOMIC_STORE compare-and-set is the repo's existing answer to exactly
 * this shape of race (see `provider-verify-claim.ts`); with no DO bound —
 * unit tests, a stripped environment — it degrades to the re-read the
 * caller already did, which is weaker but no worse than before.
 *
 * Returns false when someone else got there first; the caller answers 409.
 */
async function claimProviderIdForCreate(env: Env, id: string): Promise<boolean> {
  if (!env.ATOMIC_STORE) return (await getProviderRecord(env, id)) === null
  const key = `providerIdClaim:${id}`
  const stub = env.ATOMIC_STORE.get(env.ATOMIC_STORE.idFromName('provider-id-claim'))
  const read = await stub.fetch(new Request('https://provider-id-claim.internal/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
  }))
  const current = await read.json() as { value: string | null; version: number }
  if (current.value) return false
  const committed = await stub.fetch(new Request('https://provider-id-claim.internal/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key, expectedVersion: current.version, op: 'set', value: new Date().toISOString(),
    }),
  }))
  return ((await committed.json()) as { ok: boolean }).ok
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

/**
 * Ownership for a hosted record: nothing to prove up front. The paid gate
 * is the proof — the origin either serves the gateway's authenticated call
 * or it does not. Recorded as `hosted_origin_auth`; describeProof states
 * exactly what that means.
 */
async function resolveHostedOwnership(validated: { payouts: Array<{ network: string; payTo: string }> }) {
  const first = validated.payouts[0]
  return {
    proof: 'hosted_origin_auth' as const,
    ownerKey: { network: first.network, address: first.payTo, proof: 'hosted_origin_auth' as const },
    domainVerifiedAt: new Date().toISOString(),
    detail: 'Router-hosted paywall: origin authentication is proven by the paid verification call.',
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
    ...(record.hosting ? { hosting: { mode: 'router', origin_host: new URL(record.hosting.originUrl).host, auth_header: record.hosting.auth.header } } : {}),
    payouts: record.payouts.map(p => ({ network: p.network, pay_to: p.payTo, asset: p.asset })),
    routes: record.routes.map(r => ({
      operation: r.operation,
      method: r.method,
      price_usd: r.priceUsd,
      public_path: publicPathFor(record.id, r.operation),
      ...(r.capability ? { capability: r.capability } : {}),
      ...(r.verifyWith ? { verify_with: true } : {}),
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
      ownership_proof_means: describeProof(record.verification.ownershipProof ?? record.ownerKey.proof),
      challenge_dialect: record.verification.challengeDialect ?? null,
      unlisted_networks: record.verification.unlistedNetworks ?? [],
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
    links: publicLinks(record),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}

/**
 * What each proof actually established, in words a buyer or a reviewer
 * can quote. `x402_pay_to` in particular is NOT key custody and must not
 * read as if it were.
 */
function describeProof(proof: string | undefined): string | null {
  switch (proof) {
    case 'wallet_signature':
      return 'The registrant signed with the payout private key: key custody proven.'
    case 'well_known':
      return 'A token we issued was published under the API origin and claimed with its private secret: origin control plus the registrant\'s assertion of the payout address. Not key custody.'
    case 'x402_pay_to':
      return 'The live 402 at the registered origin advertises exactly the registered payout address: the endpoint\'s own payout configuration matches. Not key custody, and not proof of who submitted the form.'
    case 'hosted_origin_auth':
      return 'MPP Router hosts the paywall; the origin served the paid verification call with the credential the registrant supplied or configured. Proves the registrant can authenticate to the origin. Not key custody of the payout address, and not proof of who runs the origin.'
    default:
      return null
  }
}

function explorerTxUrl(network: string | undefined, txHash: string | undefined | null): string | null {
  if (!txHash) return null
  if (!network || network.startsWith('stellar:')) return `https://stellar.expert/explorer/public/tx/${txHash}`
  return null
}

/** Stable public URLs for a record; the result page and the report link to these. */
function publicLinks(record: ProviderRecord) {
  const tx = record.verification.paidCallTxHash
  return {
    status: `https://apiserver.mpprouter.dev/v1/providers/${record.id}`,
    verification: `https://apiserver.mpprouter.dev/v1/providers/${record.id}/verification`,
    listing: record.status === 'published' ? `https://www.mpprouter.dev/providers/${record.id}` : null,
    catalog: record.status === 'published' ? 'https://apiserver.mpprouter.dev/services' : null,
    metrics: record.status === 'published' ? `https://apiserver.mpprouter.dev/v1/services/${record.id}/metrics` : null,
    settlement_tx: explorerTxUrl(record.verification.paidCallNetwork, tx),
    horizon_tx: tx ? `https://horizon.stellar.org/transactions/${tx}` : null,
  }
}

/**
 * What a provider should do about a failed gate, keyed by code. Every
 * failure the portal can show comes with one of these, and with a flag
 * saying whether retrying can spend money — the frontend must never have
 * to guess that.
 */
const NEXT_ACTIONS: Record<string, { action: string; can_safely_retry: boolean }> = {
  unreachable: { action: 'Make the endpoint reachable over public HTTPS with no redirect, then retry. Nothing was paid.', can_safely_retry: true },
  not_402: { action: 'The endpoint answered an unpaid request without a 402. Enable payment on this route, then retry. Nothing was paid.', can_safely_retry: true },
  unparseable_challenge: { action: 'Serve an mpp WWW-Authenticate challenge or an x402 accepts[] challenge, then retry. Nothing was paid.', can_safely_retry: true },
  payout_not_advertised: { action: 'Your 402 does not offer the network you registered. Add it to the endpoint or remove it from the registration (re-register), then retry. Nothing was paid.', can_safely_retry: true },
  paytoaddress_mismatch: { action: 'The endpoint pays a different address than you registered. Correct whichever is wrong (re-register if the registration is wrong), then retry. Nothing was paid.', can_safely_retry: true },
  price_mismatch: { action: 'The endpoint charges a different amount than you registered. Correct whichever is wrong, then retry. Nothing was paid.', can_safely_retry: true },
  bad_amount: { action: 'The challenge amount is not an integer in base units. Fix the endpoint, then retry. Nothing was paid.', can_safely_retry: true },
  bad_price: { action: 'The registered price is not representable on this network. Re-register with a valid price. Nothing was paid.', can_safely_retry: true },
  gate_unavailable: { action: 'The verification wallet is not configured on this deployment. Your registration is kept; retry later. Nothing was paid.', can_safely_retry: true },
  too_expensive_to_verify: { action: `Expose one route priced at or below $${MAX_VERIFY_PAYMENT_USD} (mark it verify_with) and re-register. Nothing was paid.`, can_safely_retry: true },
  no_stellar_payout: { action: 'Add a stellar:pubnet payout (we can sponsor the account) and re-register. Nothing was paid.', can_safely_retry: true },
  budget_exhausted: { action: 'The daily verification budget is spent. Retry tomorrow. Nothing was paid.', can_safely_retry: true },
  challenge_mismatch: { action: 'Your endpoint served a different payTo or a higher amount to the paid call than to the probe. Nothing was signed or paid. Make the 402 consistent, then retry.', can_safely_retry: true },
  paid_call_failed: { action: 'The paid call did not complete. Money may or may not have moved; this attempt is frozen. Check the verification status page before doing anything else.', can_safely_retry: false },
  paid_call_not_200: { action: 'A payment was submitted but your endpoint did not return 200. Check the transaction, fix the endpoint, then re-register with a changed registration to start a fresh verification.', can_safely_retry: false },
  empty_body: { action: 'A payment was submitted but your endpoint returned an empty body. Fix the endpoint, then re-register with a changed registration.', can_safely_retry: false },
  no_receipt: { action: 'Your endpoint served the call but returned no settlement receipt header, so we cannot confirm where the money went. Add the receipt header, then re-register with a changed registration.', can_safely_retry: false },
  settlement_unverified: { action: 'The ledger could not be read at the time. Open the verification status page to reconcile from the transaction hash; no second payment is made.', can_safely_retry: false },
  settlement_not_found: { action: 'The transaction does not pay the registered address. This attempt is frozen with the hash attached; contact support with it.', can_safely_retry: false },
  settlement_not_direct: { action: 'The settlement passed through the ROZO pool. Direct settlement must pay you with no ROZO leg; contact support with the hash.', can_safely_retry: false },
  tx_not_on_ledger: { action: 'The receipt named a transaction the ledger does not have yet. Open the verification status page to reconcile; if it never lands, the attempt is released without payment.', can_safely_retry: false },
  paid_call_uncertain: { action: 'The paid call ended without a definite result. This attempt is frozen; open the verification status page.', can_safely_retry: false },
}

function nextActionFor(code: string) {
  return NEXT_ACTIONS[code] ?? { action: 'Check the verification status page before retrying.', can_safely_retry: false }
}

function gateEvidence(record: ProviderRecord, probe?: GateResult, paid?: GateResult) {
  const txHash = paid && 'txHash' in paid ? paid.txHash : undefined
  const network = record.payouts.find(p => p.network.startsWith('stellar:'))?.network
  return {
    probe_402: probe ? { ok: probe.ok, detail: probe.detail, ...(probe.ok ? { dialect: probe.dialect ?? null, unlisted_networks: probe.unlistedNetworks ?? [] } : { code: probe.code }) } : null,
    real_money: paid ? { ok: paid.ok, detail: paid.detail, ...(paid.ok ? {} : { code: paid.code }) } : null,
    settlement_tx: txHash ?? null,
    settlement_network: txHash ? network ?? null : null,
    settled_to: paid?.ok && txHash ? record.payouts.find(p => p.network.startsWith('stellar:'))?.payTo ?? null : null,
    explorer_url: explorerTxUrl(network, txHash),
    horizon_url: txHash ? `https://horizon.stellar.org/transactions/${txHash}` : null,
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

  // Hosted paywall: the registrant has an origin but no 402 of their own.
  // Their public origin becomes `<id>.<hosted suffix>`, served by us.
  const hostedRequested = Boolean(body?.hosting)
  let hosted: ReturnType<typeof validateHosting> | { keep: true } | null = null
  if (hostedRequested) {
    if (!(await hostingAvailable(env))) {
      return json(503, { error: 'hosting_unavailable', detail: 'Router-hosted paywalls are not enabled on this deployment.' })
    }
    const id = String(body?.id ?? '').trim().toLowerCase()
    if (id) body.api_base_url = hostedOriginFor(env, id)
    try {
      hosted = body.hosting?.auth?.keep === true ? { keep: true } : validateHosting(body.hosting)
    } catch (err: any) {
      if (err instanceof ProviderValidationError) {
        return json(400, { error: 'invalid_registration', field: err.field, detail: err.message })
      }
      throw err
    }
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

  // Only a hosted registration may live on a hosted hostname; a relayed
  // record pointing at `<x>.pay.mpprouter.dev` would relay to ourselves.
  if (!hostedRequested && hostedProviderIdFor(env, new URL(validated.apiBaseUrl).hostname)) {
    return json(400, { error: 'invalid_registration', field: 'api_base_url', detail: 'That hostname is a router-hosted paywall. Register with a hosting block instead.' })
  }
  if (hostedRequested && !validated.payouts.some(p => p.network.startsWith('stellar:'))) {
    return json(400, { error: 'invalid_registration', field: 'payouts', detail: 'A router-hosted paywall settles on Stellar; a stellar:pubnet payout is required.' })
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

  if (!hostedRequested && existing?.hosting) {
    // A hosted record re-registered without a hosting block would silently
    // become a relayed record pointing at our own hostname. Refuse before
    // any proof runs.
    return json(400, { error: 'invalid_registration', field: 'hosting', detail: 'This provider is router-hosted; include the hosting block (auth.keep=true to keep the stored credential).' })
  }

  let auth
  try {
    auth = hostedRequested
      ? await resolveHostedOwnership(validated)
      : await resolveOwnershipProof(env, {
          providerId: validated.id,
          digest,
          apiBaseUrl: validated.apiBaseUrl,
          payouts: validated.payouts,
          routes: validated.routes,
          body: (body ?? {}) as Record<string, unknown>,
        })
    // A record established by a signature cannot be re-pointed by a weaker
    // proof. Checked after the proof runs so the caller learns their proof
    // was valid AND insufficient, rather than guessing. An absent marker
    // means the record predates pluralised proofs and was signed.
    assertNoProofDowngrade(existing?.ownerKey.proof, auth.proof, Boolean(existing))
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

  // Creation and update are different acts. Neither non-signature proof
  // identifies the CALLER — anyone can fetch a public 402 or read a token
  // off a domain they do not run — so they may file a new record (whose
  // money goes to the provider either way) but may not silently change an
  // existing one, which would swap its routes and origin and mint a fresh
  // dashboard credential. Updating with a non-signature proof therefore
  // additionally requires that record's dashboard bearer token.
  if (existing && auth.proof !== 'wallet_signature') {
    const authorized = await verifyDashboardToken(
      request.headers.get('authorization'),
      existing.dashboardTokenHash,
    )
    if (!authorized) {
      return json(401, {
        error: 'unauthorized',
        detail:
          `Provider id "${validated.id}" already exists. Updating it with a ${auth.proof} proof ` +
          'requires the dashboard token issued at registration, sent as an Authorization: Bearer ' +
          'header. A wallet signature over the new payload also authorises the change.',
      })
    }
  }

  // First registration of this id: take the claim atomically, so a
  // concurrent create cannot slip past the update check above by racing
  // the read that found no record.
  if (!existing && !(await claimProviderIdForCreate(env, validated.id))) {
    return json(409, {
      error: 'registration_in_flight',
      detail: `Provider id "${validated.id}" was claimed by another registration. Retry to update it.`,
    })
  }

  const now = new Date().toISOString()
  const dashboardCredential = await issueDashboardToken()
  let hosting: StoredHosting | undefined
  if (hostedRequested) {
    if (hosted && 'keep' in hosted) {
      if (!existing?.hosting) {
        return json(400, { error: 'invalid_registration', field: 'hosting', detail: 'auth.keep needs an existing hosted registration to keep the credential from.' })
      }
      hosting = existing.hosting
    } else if (hosted) {
      hosting = await sealHosting(env, hosted)
    }
  }
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
    // Keep the original owner address, but let a STRONGER proof upgrade the
    // marker: a weakly established record updated under a wallet signature
    // must not stay downgradeable afterwards.
    ownerKey: existing
      ? {
          ...existing.ownerKey,
          ...(auth.proof === 'wallet_signature' ? { proof: 'wallet_signature' as const } : {}),
        }
      : auth.ownerKey,
    registrationVersion: digest,
    dashboardTokenHash: dashboardCredential.hash,
    ...(hosting ? { hosting } : {}),
  }
  await putProviderRecord(env, record)

  return json(201, {
    ...publicView(record),
    ownership_proof: { type: auth.proof, detail: auth.detail },
    dashboard_token: dashboardCredential.token,
    ...(hosting ? {
      hosting: {
        hosted_origin: hostedOriginFor(env, record.id),
        origin_url: hosting.originUrl,
        auth_header: hosting.auth.header,
        auth_scheme: hosting.auth.scheme,
        auth_digest: hosting.authDigest,
        // Shown exactly once. The provider configures their origin to
        // accept it; we never return it again.
        ...(hosted && !('keep' in hosted) && hosted.auth.generated ? { generated_secret: hosted.auth.value } : {}),
        paid_routes: record.routes.map(r => `${hostedOriginFor(env, record.id)}${r.upstreamPath}`),
        note: 'Buyers call the hosted origin (or the /v1/services path) and pay x402 on Stellar straight to your payout address; the router calls your origin with the stored credential and settles only after your origin answers 2xx.',
      },
    } : {}),
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
      explorer_url: explorerTxUrl(record.verification.paidCallNetwork, record.verification.paidCallTxHash),
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
    return json(422, {
      error: 'verification_failed', gate: 'ownership', code: 'ownership_required',
      detail: 'Ownership has not been proven for this registration.',
      next_action: 'Complete a well_known or x402_pay_to proof (or a wallet signature plus domain proof) by re-registering. Nothing was paid.',
      can_safely_retry: true,
      checks: record.verification.checks,
    })
  }

  const spec = chooseVerificationRoute(record)
  const attemptAt = new Date().toISOString()

  // A frozen earlier attempt is settled from the ledger before anything
  // else happens. This never pays; it reads the hash the receipt named.
  const stellarPayTo = record.payouts.find(p => p.network.startsWith('stellar:'))?.payTo
  if (env.ATOMIC_STORE && stellarPayTo) {
    const claim = await readClaimState(env, record.id, verificationEpoch)
    if (claim.state === 'uncertain') {
      const outcome = await reconcileUncertainClaim(env, {
        providerId: record.id,
        registrationVersion: verificationEpoch,
        settled: hash => assertSettledToProvider(env, hash, stellarPayTo, undefined, verifyWalletPublicKey(env)),
        walletPaidSince: since => verifyWalletPaidProviderSince(env, stellarPayTo, since),
        allowRelease: true,
      })
      if (outcome.status === 'paid_not_served' || outcome.status === 'unresolved') {
        return json(409, {
          error: 'payment_outcome_uncertain',
          code: outcome.status,
          detail: outcome.detail,
          settlement_tx: 'txHash' in outcome ? outcome.txHash ?? null : null,
          explorer_url: 'txHash' in outcome ? explorerTxUrl(record.payouts.find(p => p.network.startsWith('stellar:'))?.network, outcome.txHash) : null,
          can_safely_retry: false,
          next_action: outcome.detail,
          retry: 'manual_status_check_required',
        })
      }
      // `released` falls through to a fresh attempt; `settled_and_served`
      // is picked up by runClaimedPaidGate as a completed claim below.
    }
  }

  const probe = await gateProbe402(record, spec, routerFetch(env))
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
      ...nextActionFor(probe.code),
      probed: { operation: spec.operation, method: spec.method },
      checks: buildChecks(record, probe),
      evidence: gateEvidence(record, probe),
    })
  }
  const dialect = probe.dialect ?? 'x402'

  const claimed = await runClaimedPaidGate(env, record.id, verificationEpoch, () => gateRealMoneyCall(env, record, spec, dialect, { fetchImpl: routerFetch(env) }))
  if (claimed.status === 'in_progress') {
    return json(202, { status: 'verification_in_progress', retry_after_seconds: claimed.retryAfterSeconds, can_safely_retry: false,
      next_action: 'A verification is already running for this registration. Poll the status page; do not submit again.' })
  }
  if (claimed.status === 'uncertain') {
    return json(409, { error: 'payment_outcome_uncertain', detail: claimed.detail, retry: 'manual_status_check_required', can_safely_retry: false,
      next_action: 'Open the verification status page; it reconciles from the transaction hash without paying again.' })
  }
  const paid = claimed.result
  if (!paid.ok) {
    record.verification = {
      ...record.verification,
      probe402At: attemptAt,
      challengeDialect: dialect,
      unlistedNetworks: probe.unlistedNetworks,
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
      ...nextActionFor(paid.code),
      probe_402: 'passed',
      checks: buildChecks(record, probe, paid),
      evidence: gateEvidence(record, probe, paid),
    })
  }

  const publishedAt = new Date().toISOString()
  record.verification = {
    probe402At: attemptAt,
    ownershipProof: record.verification.ownershipProof,
    challengeDialect: dialect,
    unlistedNetworks: probe.unlistedNetworks,
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
      ...gateEvidence(latest, probe, paid),
      paid_call_at: publishedAt,
    },
    catalog: latest.routes.map(r => publicPathFor(latest.id, r.operation)),
  })
}

/**
 * GET /v1/providers/:id/verification — the durable result page's source.
 *
 * Everything the portal shows after the fact comes from here, so a
 * recording made an hour later reads the same evidence as the live run:
 * the five checks, the paid-gate outcome, the settlement hash with public
 * explorer links, and — when the paid gate is frozen — a reconciliation
 * attempt from the ledger that never spends.
 */
export async function handleProviderVerificationStatus(env: Env, id: string): Promise<Response> {
  const record = await getProviderRecord(env, id.trim().toLowerCase())
  if (!record) return json(404, { error: 'not_found' })
  const epoch = record.registrationVersion ?? await registrationDigest({
    id: record.id, name: record.name, email: record.email, apiBaseUrl: record.apiBaseUrl, payouts: record.payouts, routes: record.routes,
  })
  let claim: Awaited<ReturnType<typeof readClaimState>> = { state: 'none' }
  let reconciliation: unknown = null
  const stellarPayTo = record.payouts.find(p => p.network.startsWith('stellar:'))?.payTo
  if (env.ATOMIC_STORE) {
    claim = await readClaimState(env, record.id, epoch)
    if (claim.state === 'uncertain' && stellarPayTo && record.status !== 'published') {
      // A public GET may complete a claim from the ledger (idempotent) but
      // never release one: releasing re-arms a payment, and that decision
      // belongs to the POST that would make it.
      reconciliation = await reconcileUncertainClaim(env, {
        providerId: record.id, registrationVersion: epoch,
        settled: hash => assertSettledToProvider(env, hash, stellarPayTo, undefined, verifyWalletPublicKey(env)),
        allowRelease: false,
      })
      claim = await readClaimState(env, record.id, epoch)
    }
  }
  const frozenTx = claim.state === 'uncertain' && claim.result && !claim.result.ok ? claim.result.txHash ?? null : null
  const lastCode = record.verification.lastError?.match(/\((\w+)\)/)?.[1]
  return json(200, {
    ...publicView(record),
    paid_gate: {
      state: record.status === 'published' ? 'passed' : claim.state,
      ...(claim.state === 'uncertain' || claim.state === 'completed' ? { result: claim.result ?? null } : {}),
      frozen_tx: frozenTx,
      frozen_tx_explorer_url: explorerTxUrl(record.payouts.find(p => p.network.startsWith('stellar:'))?.network, frozenTx),
      reconciliation,
    },
    ...(record.status !== 'published' && lastCode ? { next_action: nextActionFor(lastCode) } : {}),
    recovery: {
      safe_retry: 'POST /v1/providers/verify {"id"} — re-runs the free probe; the paid call runs only if no earlier paid attempt is frozen.',
      fresh_attempt: 'Re-register with a changed registration (any field) — a new registration version starts a new paid attempt. Use only after fixing the endpoint; it will pay once more.',
      never: 'Do not re-register with an identical payload to "retry": it maps to the same frozen attempt and changes nothing.',
    },
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
    // The well-known token is issued once per (provider, domain, address)
    // and lives for days. A second check of the same URL used to throw
    // here and fail the WHOLE check — so the one person most likely to
    // check twice, the provider, was locked out for a week. Now the check
    // succeeds without a token and says why; the x402 payTo proof needs no
    // token at all.
    let domainProof: Awaited<ReturnType<typeof issueDomainProof>> | null = null
    let domainProofStatus: 'issued' | 'already_active' | 'not_applicable' = 'not_applicable'
    if (inspected.draft && payTo && providerId.length >= 3) {
      try {
        domainProof = await issueDomainProof(env, { providerId, url, payTo })
        domainProofStatus = 'issued'
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('A domain proof')) domainProofStatus = 'already_active'
        else throw error
      }
    }
    const registration = inspected.draft ? {
      id: providerId,
      name: host.replace(/^www\./, ''),
      email: '',
      ...inspected.draft,
    } : null
    const stellar = inspected.draft?.payouts.some(p => p.network.startsWith('stellar:')) ?? false
    return json(200, {
      provider_id: providerId || null,
      registration,
      checks: inspected.checks,
      dialect: inspected.dialect ?? null,
      discovered_networks: inspected.draft?.payouts.map(p => p.network) ?? [],
      stellar_payout_discovered: stellar,
      domain_proof: domainProof,
      domain_proof_status: domainProofStatus,
      ownership_proofs: Object.values(OWNERSHIP_PROOF_GUIDE),
      capabilities: CAPABILITY_CONTRACTS,
      verify_payment_cap_usd: MAX_VERIFY_PAYMENT_USD,
    })
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
      claimSecret: String(body.claim_secret ?? ''),
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
