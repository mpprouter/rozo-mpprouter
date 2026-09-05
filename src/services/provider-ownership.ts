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
 * ## The limit that matters, and how it is contained
 *
 * Neither new proof identifies the *caller*. Anyone can fetch a public 402,
 * so `x402_pay_to` on its own says "this origin publishes this address",
 * not "the person submitting this form runs that origin". That is fine for
 * creating a record — the worst outcome is a stranger filing a listing
 * whose money goes to the real provider anyway — and it is NOT fine for
 * changing one, because an update can swap routes and origin and mints a
 * fresh dashboard credential.
 *
 * So updates are separated from creation:
 *
 *   - a wallet signature over the new payload updates anything, as before;
 *   - any other proof may update an existing record only when the caller
 *     also presents that record's dashboard bearer token;
 *   - a record established by a signature can never be re-pointed by a
 *     weaker proof, and a record from before proofs were pluralised is
 *     treated as signature-established.
 *
 * Nor do these forms weaken the paid gate: publication still requires a
 * real minimal payment that settles to the registered address and returns
 * 200.
 */

import type { Env } from '../index'
import { ProviderAuthError, isSupportedPayoutNetwork, verifyRegistrationSignatures } from './provider-auth'
import { consumeDomainProof, payToFromProofToken } from './provider-domain-proof'
import { readBoundedText } from './provider-check'
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

/**
 * Provider ids a non-signature proof may claim for a given origin.
 *
 * Both new proofs rest on public facts — anyone can fetch someone else's
 * 402, and a published well-known token is readable by the world — so
 * without this a stranger could file first under a desirable id and become
 * its credential holder. Tying the id to the origin being proven removes
 * the prize: you may only claim a name your own domain already spells.
 *
 * `agent402.tools` therefore yields `agent402-tools`, `agent402` and
 * `agent402-tools` again for the label-minus-TLD form — the shapes a real
 * operator would reach for — and nothing belonging to anyone else. A
 * wallet signature is exempt: it proves key custody directly and has
 * always been allowed to name its own record.
 */
export function providerIdsForOrigin(apiBaseUrl: string): string[] {
  let host: string
  try {
    host = new URL(apiBaseUrl).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return []
  }
  const labels = host.split('.')
  const slug = (value: string) =>
    value.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
  const candidates = [
    slug(host),
    slug(labels[0] ?? ''),
    slug(labels.slice(0, -1).join('.')),
  ]
  return [...new Set(candidates.filter(Boolean))]
}

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

  // The registrant controls this response and is unauthenticated, so it is
  // read through the same bounded reader the well-known proof uses rather
  // than buffered whole.
  let text = ''
  try {
    text = await readBoundedText(response, 65_536)
  } catch {
    throw new ProviderAuthError(
      `${url} returned a payment challenge too large to read.`,
      'oversized_challenge',
    )
  }
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

  // From here on the proof is a public fact, so the id must belong to the
  // origin the proof is about.
  const allowedIds = providerIdsForOrigin(args.apiBaseUrl)
  if (!allowedIds.includes(args.providerId)) {
    throw new ProviderAuthError(
      `A ${type} proof may only register an id derived from its own domain. ` +
        `For ${args.apiBaseUrl} that is: ${allowedIds.join(', ') || '(none)'}. ` +
        'Registering a different id requires a wallet signature.',
      'id_not_derived_from_domain',
    )
  }

  const first = args.payouts[0]

  if (type === 'well_known') {
    const rawTokens = Array.isArray(requested?.tokens)
      ? (requested!.tokens as unknown[]).map(String)
      : requested?.token
        ? [String(requested.token)]
        : []
    if (rawTokens.length === 0) {
      throw new ProviderAuthError(
        'ownership_proof.token is required. Issue one with POST /v1/providers/check and publish it.',
        'missing_token',
      )
    }

    // A token binds an ADDRESS, not an address-plus-network. Two payout
    // entries sharing the same address string on different networks would
    // therefore both be covered by one token, letting an unadvertised
    // network ride in on a real proof. Refuse the ambiguity rather than
    // resolve it wrongly.
    const addresses = args.payouts.map(p => p.payTo)
    if (new Set(addresses).size !== addresses.length) {
      throw new ProviderAuthError(
        'Two payout entries share the same address. A domain proof token binds an address, ' +
          'not a network, so it cannot tell them apart. Use distinct addresses, or sign with the wallet.',
        'ambiguous_payout',
      )
    }

    // Each token was issued for ONE payout address. Consuming a token
    // published for address A must not authorise a registration that
    // settles to address B, nor smuggle extra unproven addresses in
    // alongside it — so the proven set must cover every declared payout.
    const proven = new Set<string>()
    const details: string[] = []
    for (const token of rawTokens) {
      const tokenPayTo = payToFromProofToken(token)
      if (!tokenPayTo) {
        throw new ProviderAuthError('Domain proof token is malformed.', 'bad_token')
      }
      if (!args.payouts.some(p => p.payTo === tokenPayTo)) {
        throw new ProviderAuthError(
          'A domain proof token was issued for an address this registration does not declare.',
          'token_payout_mismatch',
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
      proven.add(tokenPayTo)
      details.push(result.detail)
    }
    const unproven = args.payouts.filter(p => !proven.has(p.payTo))
    if (unproven.length > 0) {
      throw new ProviderAuthError(
        `No domain proof was published for the ${unproven.map(p => p.network).join(', ')} ` +
          'payout address. Publish one token per payout address, or sign with the wallet.',
        'missing_token',
      )
    }
    return {
      proof: 'well_known',
      ownerKey: { network: first.network, address: first.payTo, proof: 'well_known' },
      domainVerifiedAt: new Date().toISOString(),
      detail: details.join(' '),
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
  hasRecord = true,
): void {
  // A record with no recorded proof predates this change, and every record
  // written before it was signature-established. Reading `undefined` as
  // "weak" would let exactly the takeover this function exists to stop
  // through the one door nobody would think to check. `hasRecord: false`
  // distinguishes "no existing record" from "record with no marker".
  const effective = hasRecord ? existingProof ?? 'wallet_signature' : undefined
  if (effective === 'wallet_signature' && offered !== 'wallet_signature') {
    throw new ProviderAuthError(
      'This provider id was registered with a wallet signature. Updating it requires a wallet ' +
        'signature too; a weaker proof cannot replace a stronger one.',
      'proof_downgrade',
    )
  }
}
