/**
 * Ownership proof for a provider registration — three accepted forms.
 *
 * ## Why a wallet signature stopped being the only way
 *
 * `provider-auth.ts` explains, correctly, why a hand-typed payout address
 * is unacceptable: on the direct path the money never passes through us,
 * so a wrong address is unrecoverable and silent. A wallet signature
 * removes that failure mode. What it also does, in practice, is ask a
 * provider to sign with the key that holds their revenue — and the first
 * real provider to reach this stage refused, for a reason that is hard to
 * argue with. Agent402's Stellar `payTo` is their treasury key; taking it
 * out to sign a marketing challenge is a worse risk to them than anything
 * this check protects them from. (Founder-forwarded email from Mike
 * Petrillo, 2026-09-05: he approves the listing, and will not sign with
 * that wallet. He offered instead to serve a challenge we specify, or to
 * let the 402 itself stand as the proof.)
 *
 * A requirement no provider will satisfy protects nobody. So the question
 * became: what else demonstrates, mechanically, that this address belongs
 * to the party we are about to send buyers to?
 *
 * ## What each proof actually establishes
 *
 * | Proof | Establishes | Does not establish |
 * | --- | --- | --- |
 * | `wallet_signature` | The registrant holds the private key of the payout address. | That they control the API origin (a separate domain proof does). |
 * | `well_known` | Whoever controls the HTTPS origin published a token WE issued, bound to this provider id, domain and payout address. | Key custody. |
 * | `x402_pay_to` | The live endpoint at the registered origin advertises exactly this payout address in its own 402 challenge. | Key custody. |
 *
 * The two new forms are proofs of **endpoint control plus assertion**, not
 * of key custody, and the public record says so rather than implying a
 * stronger claim. That is the honest reading, and it is sufficient for the
 * hazard this gate exists to stop: the registrant is the party who serves
 * the API, and the address is the one that party publishes to every buyer
 * who probes them. A typo would break their own production 402 long before
 * it reached us; an impostor would have to control the provider's origin,
 * at which point they can already redirect the money without us.
 *
 * What we do NOT do is let a weaker proof take over a record that a
 * signature established — see the no-downgrade rule below. Nor do these
 * forms weaken the paid gate: publication still requires a real minimal
 * payment that settles to the registered address and returns 200.
 */

import type { Env } from '../index'
import { ProviderAuthError, isSupportedPayoutNetwork, verifyRegistrationSignatures } from './provider-auth'
import { consumeDomainProof } from './provider-domain-proof'
import { parseProviderChallenge } from './provider-verification'
import type { RouteOperatorPayout } from './merchants-types'
import type { ProviderRouteSpec } from './provider-registry'

export type OwnershipProofType = 'wallet_signature' | 'well_known' | 'x402_pay_to'

export const OWNERSHIP_PROOF_TYPES: OwnershipProofType[] = [
  'wallet_signature',
  'well_known',
  'x402_pay_to',
]

/** Human-readable, provider-facing description of each accepted proof. */
export const OWNERSHIP_PROOF_GUIDE = {
  wallet_signature: {
    type: 'wallet_signature',
    proves: 'Control of the payout private key.',
    how: 'Sign the string from GET /v1/providers/challenge with each payout address and submit signatures[].',
  },
  well_known: {
    type: 'well_known',
    proves: 'Control of the API origin, plus a signed-off assertion of the payout address.',
    how:
      'Serve the token we issue at https://<your-domain>/.well-known/mpprouter-verify.txt ' +
      '(plain text, the token and nothing else), or at /.well-known/mpp-provider.json as ' +
      '{"token":…,"domain":…,"provider_id":…,"pay_to":…}, then submit ' +
      '{"ownership_proof":{"type":"well_known","token":"…"}}.',
  },
  x402_pay_to: {
    type: 'x402_pay_to',
    proves: 'That your own live 402 challenge advertises exactly the payout address you registered.',
    how:
      'Keep serving your normal 402. Submit {"ownership_proof":{"type":"x402_pay_to"}} and we fetch ' +
      'one of your registered routes unpaid and compare every payTo against your registration.',
  },
} as const

export interface OwnershipOutcome {
  proof: OwnershipProofType
  /** The key/address authorised to change this record later. */
  ownerKey: { network: string; address: string; proof: OwnershipProofType }
  /**
   * Set when the proof itself demonstrated control of the origin, so the
   * verify step does not additionally demand a separate domain proof.
   * A wallet signature says nothing about the domain and so leaves this
   * undefined — exactly as before.
   */
  domainVerifiedAt?: string
  detail: string
}

const PROBE_TIMEOUT_MS = 10_000

function sameAddress(network: string, a: string, b: string): boolean {
  // EVM addresses are case-insensitive (EIP-55 is a checksum, not an
  // identity). Stellar and Solana are case-sensitive base32/base58 and
  // must match exactly.
  return network.startsWith('eip155:')
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

/**
 * Fetch one registered route unpaid and require the live 402 to name every
 * registered payout address on its own network.
 *
 * Every address must be found. Accepting a partial match would publish an
 * address the endpoint never advertised alongside one it did, which is the
 * exact shape of the typo this whole gate exists to catch.
 */
export async function verifyX402PayToMatch(args: {
  apiBaseUrl: string
  routes: ProviderRouteSpec[]
  payouts: RouteOperatorPayout[]
  requestedOperation?: string
  fetchImpl?: typeof fetch
}): Promise<{ detail: string; probedUrl: string }> {
  const doFetch = args.fetchImpl ?? fetch
  const spec =
    (args.requestedOperation
      ? args.routes.find(r => r.operation === args.requestedOperation)
      : undefined) ?? args.routes[0]
  if (!spec) {
    throw new ProviderAuthError('No route to probe for a payTo match.', 'no_route')
  }
  const url = `${args.apiBaseUrl.replace(/\/+$/, '')}${spec.upstreamPath}`

  let response: Response
  try {
    response = await doFetch(url, {
      method: spec.method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'mpprouter-ownership/1' },
      ...(spec.method === 'POST' ? { body: '{}' } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch {
    throw new ProviderAuthError(
      `Could not fetch ${url} over HTTPS without redirects to read its 402.`,
      'unreachable',
    )
  }

  const text = await response.text().catch(() => '')
  const challenge = parseProviderChallenge(response.status, response.headers, text)
  if (!challenge) {
    throw new ProviderAuthError(
      `${url} did not answer with a parseable 402 payment challenge (got HTTP ${response.status}).`,
      'not_402',
    )
  }

  for (const payout of args.payouts) {
    const match = challenge.accepts.find(
      accept =>
        accept.network === payout.network && sameAddress(payout.network, accept.payTo, payout.payTo),
    )
    if (!match) {
      const advertised = challenge.accepts
        .filter(a => a.network === payout.network)
        .map(a => a.payTo)
      throw new ProviderAuthError(
        advertised.length > 0
          ? `Your live 402 on ${payout.network} advertises a different payTo than the one registered.`
          : `Your live 402 advertises no ${payout.network} settlement option, so that payout address is unproven.`,
        'pay_to_mismatch',
      )
    }
  }

  return {
    detail: `The live 402 at ${url} advertises every registered payout address.`,
    probedUrl: url,
  }
}

/**
 * Resolve whichever proof the registration offered.
 *
 * Order is deliberate: an explicit `ownership_proof.type` wins, and a bare
 * `signatures[]` still works unchanged so every existing integration and
 * every existing test keeps its behaviour.
 */
export async function resolveOwnershipProof(
  env: Env,
  args: {
    providerId: string
    digest: string
    apiBaseUrl: string
    payouts: RouteOperatorPayout[]
    routes: ProviderRouteSpec[]
    body: Record<string, unknown>
  },
): Promise<OwnershipOutcome> {
  const requested = (args.body.ownership_proof ?? null) as Record<string, unknown> | null
  const declaredType = requested ? String(requested.type ?? '') : ''
  const hasSignatures = Array.isArray(args.body.signatures) && args.body.signatures.length > 0

  const type: OwnershipProofType =
    declaredType === 'well_known' || declaredType === 'x402_pay_to' || declaredType === 'wallet_signature'
      ? declaredType
      : hasSignatures
        ? 'wallet_signature'
        : (() => {
            throw new ProviderAuthError(
              'An ownership proof is required. Provide signatures[], or ownership_proof.type of ' +
                '"well_known" or "x402_pay_to".',
              'missing_ownership_proof',
            )
          })()

  for (const payout of args.payouts) {
    if (type === 'wallet_signature' && !isSupportedPayoutNetwork(payout.network)) {
      throw new ProviderAuthError(
        `Cannot verify a signature on "${payout.network}". Supported: stellar:*, eip155:*, solana:*.`,
        'unsupported_network',
      )
    }
  }

  if (type === 'wallet_signature') {
    const auth = await verifyRegistrationSignatures(env, {
      providerId: args.providerId,
      digest: args.digest,
      payouts: args.payouts,
      signatures: args.body.signatures,
    })
    return {
      proof: 'wallet_signature',
      ownerKey: { ...auth.ownerKey, proof: 'wallet_signature' },
      detail: 'Every payout address was proven with a wallet signature.',
    }
  }

  const first = args.payouts[0]

  if (type === 'well_known') {
    const token = String(requested?.token ?? '')
    if (!token) {
      throw new ProviderAuthError(
        'ownership_proof.token is required. Issue one with POST /v1/providers/check and publish it.',
        'missing_token',
      )
    }
    const result = await consumeDomainProof(env, {
      providerId: args.providerId,
      url: args.apiBaseUrl,
      token,
    })
    if (!result.ok) {
      throw new ProviderAuthError(result.detail, 'domain_proof_failed')
    }
    return {
      proof: 'well_known',
      ownerKey: { network: first.network, address: first.payTo, proof: 'well_known' },
      domainVerifiedAt: new Date().toISOString(),
      detail: result.detail,
    }
  }

  const matched = await verifyX402PayToMatch({
    apiBaseUrl: args.apiBaseUrl,
    routes: args.routes,
    payouts: args.payouts,
    requestedOperation: requested?.operation ? String(requested.operation) : undefined,
  })
  return {
    proof: 'x402_pay_to',
    ownerKey: { network: first.network, address: first.payTo, proof: 'x402_pay_to' },
    // The probed origin IS the registered origin (`validateApiBaseUrl`
    // normalises it and the probe is built from it, not from anything the
    // caller supplied separately), so a passing probe is a demonstration
    // of control over that origin.
    domainVerifiedAt: new Date().toISOString(),
    detail: matched.detail,
  }
}

/**
 * Refuse to let a weaker proof take over a record a stronger one created.
 *
 * Without this, a record established with a wallet signature could later
 * be re-pointed by anyone who can serve a file on the domain — which is a
 * strictly larger set of people than "holds the payout key", and the
 * record's whole value is that it names one of them.
 */
export function assertNoProofDowngrade(
  existingProof: OwnershipProofType | undefined,
  offered: OwnershipProofType,
): void {
  if (existingProof === 'wallet_signature' && offered !== 'wallet_signature') {
    throw new ProviderAuthError(
      'This provider id was registered with a wallet signature. Updating it requires a wallet ' +
        'signature too; a weaker proof cannot replace a stronger one.',
      'proof_downgrade',
    )
  }
}
