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
} from '../services/provider-registry'
import {
  buildSignatureMessage,
  registrationDigest,
  verifyRegistrationSignatures,
  isSupportedPayoutNetwork,
  ProviderAuthError,
  SIGNATURE_REALM,
} from '../services/provider-auth'
import {
  chooseVerificationRoute,
  gateProbe402,
  gateRealMoneyCall,
} from '../services/provider-verification'
import { registerWithMppScan } from '../services/provider-listing'
import { sponsorStellarAccount } from '../services/provider-sponsor'

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

async function throttleWrite(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  try {
    const verdict = await checkAndBumpWindowLimit(
      env,
      `ratelimit:providers:${ip}`,
      WRITE_REQUESTS_PER_WINDOW,
      WRITE_WINDOW_MS,
    )
    if (!verdict.ok) {
      return json(429, {
        error: 'rate_limited',
        detail: `${WRITE_REQUESTS_PER_WINDOW} requests per minute.`,
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
    },
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
  })
}

// ---------------------------------------------------------------------
// POST /v1/providers/register
// ---------------------------------------------------------------------

export async function handleProviderRegister(request: Request, env: Env): Promise<Response> {
  const throttled = await throttleWrite(request, env)
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
    auth = await verifyRegistrationSignatures(env, {
      providerId: validated.id,
      digest,
      payouts: validated.payouts,
      signatures: body?.signatures,
    })
  } catch (err: any) {
    if (err instanceof ProviderAuthError) {
      return json(401, { error: 'signature_rejected', code: err.code, detail: err.message })
    }
    throw err
  }

  const now = new Date().toISOString()
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
    verification: {},
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ownerKey: existing?.ownerKey ?? auth.ownerKey,
  }
  await putProviderRecord(env, record)

  return json(201, {
    ...publicView(record),
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
  const throttled = await throttleWrite(request, env)
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
  if (record.status === 'suspended') {
    return json(403, { error: 'suspended', detail: 'This provider is suspended.' })
  }

  const spec = chooseVerificationRoute(record)
  const attemptAt = new Date().toISOString()

  const probe = await gateProbe402(record, spec)
  if (!probe.ok) {
    record.verification = {
      ...record.verification,
      lastError: `probe-402 (${probe.code}): ${probe.detail}`,
      lastAttemptAt: attemptAt,
    }
    record.updatedAt = attemptAt
    await putProviderRecord(env, record)
    return json(422, {
      error: 'verification_failed',
      gate: 'probe-402',
      code: probe.code,
      detail: probe.detail,
      probed: { operation: spec.operation, method: spec.method },
    })
  }

  const paid = await gateRealMoneyCall(env, record, spec)
  if (!paid.ok) {
    record.verification = {
      ...record.verification,
      probe402At: attemptAt,
      lastError: `real-money (${paid.code}): ${paid.detail}`,
      lastAttemptAt: attemptAt,
    }
    record.updatedAt = attemptAt
    await putProviderRecord(env, record)
    // `gate_unavailable` is our missing configuration, not their failure,
    // so it reads as 503 rather than as a rejection of their endpoint.
    const status = paid.code === 'gate_unavailable' ? 503 : 422
    return json(status, {
      error: 'verification_failed',
      gate: 'real-money',
      code: paid.code,
      detail: paid.detail,
      probe_402: 'passed',
    })
  }

  const publishedAt = new Date().toISOString()
  record.verification = {
    probe402At: attemptAt,
    paidCallAt: publishedAt,
    paidCallTxHash: paid.txHash,
    paidCallNetwork: paid.network,
  }
  record.status = 'published'
  record.updatedAt = publishedAt
  await putProviderRecord(env, record)

  // External listing is best-effort and deliberately off the critical
  // path: MPPScan being down must not un-publish a provider who has
  // already proven a paid call settled to their own key.
  ctx.waitUntil(registerWithMppScan(env, record).catch(() => {}))

  return json(200, {
    ...publicView(record),
    published: true,
    evidence: {
      probe_402: probe.detail,
      real_money: paid.detail,
      settlement_tx: paid.txHash,
      settled_to: record.payouts.find(p => p.network.startsWith('stellar:'))?.payTo,
    },
    catalog: record.routes.map(r => publicPathFor(record.id, r.operation)),
  })
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
  const throttled = await throttleWrite(request, env)
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
