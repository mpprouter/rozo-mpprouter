/**
 * The two automatic gates a provider passes to get published.
 *
 * SCF Tranche 3 asks for onboarding "without manual approval", so no ROZO
 * human appears anywhere between a provider clicking Verify and their
 * routes going live. That raises the obvious question of what stops a
 * hostile or merely broken registration, and the answer has to be
 * mechanical:
 *
 *   Gate 1 — `probe-402` (free). Call the provider's endpoint with no
 *   credential and read the challenge it returns. It must be a 402, it
 *   must parse, its `payTo` must equal the address they registered and
 *   proved they hold, and its price must match what they declared. This
 *   catches the whole class of "the form says one thing and the server
 *   says another", including the important one: a server quoting an
 *   address the registrant does not control.
 *
 *   Gate 2 — the real-money gate. Our test wallet pays one minimal call
 *   through the provider's own 402 and asserts a 200 with a body. The
 *   money settles to THEIR address; we then read the transaction back
 *   from the chain and assert its destination is the provider, not us.
 *
 * Gate 2 is the one that cannot be faked by a cooperative-looking server,
 * because it ends with an on-chain fact. It is also the direct evidence
 * for the Tranche 3 payout criterion — a transaction hash whose
 * destination is a non-ROZO key, produced by the onboarding flow itself
 * rather than by an operator running a script.
 *
 * ## Everything here fails closed
 *
 * Any error, timeout, unparseable response, missing config or unfunded
 * wallet leaves the provider `pending`. A provider who is not published
 * is invisible and unpayable; the failure mode of this file is "nobody
 * onboards today", never "an unverified payout address goes live".
 */

import { Mppx } from 'mppx/client'
import { stellar } from '@stellar/mpp/charge/client'
import { Keypair } from '@stellar/stellar-sdk'
import type { Env } from '../index'
import type { ProviderRecord, ProviderRouteSpec } from './provider-registry'

/**
 * Wall-clock budget for one probe of a provider's endpoint.
 *
 * A provider whose server hangs must not hold a Worker invocation open
 * until the platform kills it — that turns a slow registrant into a way
 * to consume our request budget.
 */
const PROBE_TIMEOUT_MS = 10_000

/** Budget for the paid call, which includes on-chain settlement. */
const PAID_CALL_TIMEOUT_MS = 45_000

/**
 * Hard ceiling on what one verification may spend, in USD.
 *
 * This is the only place in the router where we sign a payment to an
 * address a stranger just gave us, so the amount is bounded by code rather
 * than by the provider's declared price. A registration claiming a $500
 * route does not get a $500 test call; it gets refused at the gate and
 * told to expose something cheap. The number is deliberately small enough
 * that the worst case of a completely hostile registry — every slot
 * filled, every one paid once — is a rounding error.
 */
const MAX_VERIFY_PAYMENT_USD = 0.02

/** Daily ceiling across all verifications, in USD. Same reasoning, aggregated. */
const DAILY_VERIFY_BUDGET_USD = 2.0

const DAILY_SPEND_PREFIX = 'providerVerifySpend:'

export type GateResult =
  | { ok: true; detail: string; txHash?: string; network?: string }
  | { ok: false; code: string; detail: string }

function failure(code: string, detail: string): GateResult {
  return { ok: false, code, detail }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The provider's declared price, in the same base units the challenge
 * reports. Compared as integers so "0.010" and "0.01" agree and no float
 * ever touches a price.
 */
function toBaseUnits(decimalUsd: string, decimals: number): bigint | null {
  if (!/^\d+(?:\.\d+)?$/.test(decimalUsd)) return null
  const [whole, frac = ''] = decimalUsd.split('.')
  if (frac.length > decimals) return null
  return BigInt(whole + frac.padEnd(decimals, '0'))
}

// ---------------------------------------------------------------------
// Challenge parsing
// ---------------------------------------------------------------------

export interface ParsedProviderChallenge {
  /** Every settlement option the provider advertises. */
  accepts: Array<{ network: string; payTo: string; amount: string; decimals: number; asset?: string }>
  /** Which dialect the challenge arrived in, for the error messages. */
  dialect: 'x402' | 'mppx'
}

function parseX402Accepts(raw: unknown): ParsedProviderChallenge | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const accepts = body.accepts
  if (!Array.isArray(accepts) || accepts.length === 0) return null
  const out: ParsedProviderChallenge['accepts'] = []
  for (const entry of accepts) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const network = String(e.network ?? '')
    const payTo = String(e.payTo ?? e.pay_to ?? '')
    const amount = String(e.amount ?? e.maxAmountRequired ?? '')
    if (!network || !payTo || !amount) continue
    out.push({
      network,
      payTo,
      amount,
      // x402 amounts are in the asset's base units. Stellar USDC is 7dp,
      // EVM/Solana USDC is 6dp. Guessing wrong here would compare a price
      // against a number 10× off, so the decimals come from the network
      // rather than from a single hardcoded constant.
      decimals: network.startsWith('stellar:') ? 7 : 6,
      ...(e.asset ? { asset: String(e.asset) } : {}),
    })
  }
  return out.length > 0 ? { accepts: out, dialect: 'x402' } : null
}

function parseMppxChallenge(wwwAuth: string): ParsedProviderChallenge | null {
  try {
    const requestMatch = wwwAuth.match(/request="([^"]+)"/)
    if (!requestMatch) return null
    const json = atob(requestMatch[1].replace(/-/g, '+').replace(/_/g, '/'))
    const request = JSON.parse(json) as Record<string, unknown>
    const recipient = String(request.recipient ?? '')
    const amount = String(request.amount ?? '')
    if (!recipient || !amount) return null
    return {
      accepts: [
        {
          network: 'stellar:pubnet',
          payTo: recipient,
          amount,
          decimals: typeof request.decimals === 'number' ? request.decimals : 7,
          ...(request.currency ? { asset: String(request.currency) } : {}),
        },
      ],
      dialect: 'mppx',
    }
  } catch {
    return null
  }
}

/**
 * Read a provider's 402 in either dialect.
 *
 * Both are accepted because both are real: the mpp.dev/`@stellar/mpp`
 * server emits `WWW-Authenticate`, and an x402-native provider emits the
 * `accepts[]` JSON. Insisting on one would make the gate a statement about
 * which SDK we prefer rather than about whether the provider can charge.
 */
export function parseProviderChallenge(
  status: number,
  headers: Headers,
  bodyText: string,
): ParsedProviderChallenge | null {
  if (status !== 402) return null
  const wwwAuth = headers.get('www-authenticate')
  if (wwwAuth) {
    const parsed = parseMppxChallenge(wwwAuth)
    if (parsed) return parsed
  }
  const paymentRequired = headers.get('payment-required')
  if (paymentRequired) {
    try {
      const decoded = atob(paymentRequired.replace(/-/g, '+').replace(/_/g, '/'))
      const parsed = parseX402Accepts(JSON.parse(decoded))
      if (parsed) return parsed
    } catch {
      // Fall through to the body.
    }
  }
  try {
    return parseX402Accepts(JSON.parse(bodyText))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------
// Gate 1 — probe-402
// ---------------------------------------------------------------------

export function providerEndpointUrl(record: ProviderRecord, spec: ProviderRouteSpec): string {
  const base = record.apiBaseUrl.replace(/\/+$/, '')
  return `${base}${spec.upstreamPath}`
}

/**
 * Assert that the provider's live server agrees with their registration.
 *
 * The `payTo` comparison is the point of this gate. Everything else here
 * is a well-formedness check that mostly saves the provider a confusing
 * failure later; the address check is the one that prevents publishing a
 * route whose money goes somewhere the registrant did not prove they hold.
 */
export async function gateProbe402(
  record: ProviderRecord,
  spec: ProviderRouteSpec,
): Promise<GateResult> {
  const url = providerEndpointUrl(record, spec)
  let response: Response
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: spec.method,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'mpprouter-verify/1' },
        // A minimal body so a POST endpoint that validates before pricing
        // still reaches its 402. A provider whose 402 is gated behind a
        // valid body will fail here, and the message says so.
        ...(spec.method === 'POST' ? { body: '{}' } : {}),
        redirect: 'manual',
      },
      PROBE_TIMEOUT_MS,
    )
  } catch (err: any) {
    return failure(
      'unreachable',
      `Could not reach ${url}: ${err?.name === 'AbortError' ? 'timed out' : 'connection failed'}. ` +
        'The endpoint must be publicly reachable over HTTPS, with no redirect.',
    )
  }

  if (response.status !== 402) {
    return failure(
      'not_402',
      `Expected HTTP 402 with no credential, got ${response.status}. ` +
        'The endpoint must issue a payment challenge to an unpaid request.',
    )
  }

  const bodyText = await response.text().catch(() => '')
  const challenge = parseProviderChallenge(response.status, response.headers, bodyText)
  if (!challenge) {
    return failure(
      'unparseable_challenge',
      'The 402 carried no challenge we could read. Expected an mpp WWW-Authenticate header ' +
        'or an x402 accepts[] array (Payment-Required header or JSON body).',
    )
  }

  // Every advertised settlement option must point at an address this
  // provider proved they hold. One good entry among several is not enough:
  // a client is free to pick any of them, so an unproven entry is a live
  // path to an unproven address.
  const proven = new Map(record.payouts.map(p => [p.network, p.payTo]))
  for (const accept of challenge.accepts) {
    const expected = proven.get(accept.network)
    if (!expected) {
      return failure(
        'unregistered_network',
        `The challenge offers settlement on ${accept.network}, which is not in your registration. ` +
          'Every network your endpoint advertises must have a signature-proven payout address.',
      )
    }
    if (accept.payTo !== expected) {
      return failure(
        'paytoaddress_mismatch',
        `The challenge pays ${accept.network} to an address that is not the one you registered. ` +
          'Registered and advertised addresses must match exactly.',
      )
    }
  }

  // The price must match what the catalog will advertise, or buyers get a
  // 402 for one amount after reading another.
  const declared = toBaseUnits(spec.priceUsd, 7)
  for (const accept of challenge.accepts) {
    const advertised = (() => {
      try {
        return BigInt(accept.amount)
      } catch {
        return null
      }
    })()
    if (advertised === null) {
      return failure('bad_amount', `Challenge amount "${accept.amount}" is not an integer.`)
    }
    const declaredHere = toBaseUnits(spec.priceUsd, accept.decimals)
    if (declaredHere === null || declared === null) {
      return failure('bad_price', `Declared price "${spec.priceUsd}" is not representable.`)
    }
    if (advertised !== declaredHere) {
      return failure(
        'price_mismatch',
        `Registered ${spec.priceUsd} USD for ${spec.operation}, but the endpoint charges ` +
          `${advertised} base units on ${accept.network} (expected ${declaredHere}).`,
      )
    }
  }

  return {
    ok: true,
    detail: `402 well-formed; ${challenge.accepts.length} settlement option(s), all paying registered addresses.`,
  }
}

// ---------------------------------------------------------------------
// Gate 2 — the real-money call
// ---------------------------------------------------------------------

function todayKey(): string {
  return DAILY_SPEND_PREFIX + new Date().toISOString().slice(0, 10)
}

async function reserveDailyBudget(env: Env, amountUsd: number): Promise<boolean> {
  const key = todayKey()
  const raw = await env.MPP_STORE.get(key)
  const spent = raw ? Number(raw) : 0
  if (!Number.isFinite(spent) || spent + amountUsd > DAILY_VERIFY_BUDGET_USD) return false
  // Read-modify-write, so concurrent verifications can each see the old
  // total and overshoot. The overshoot is bounded by the per-call cap times
  // the concurrency, i.e. cents — which is the right amount of machinery
  // for a budget measured in dollars. The per-call cap above is the guard
  // that actually matters.
  await env.MPP_STORE.put(key, String(spent + amountUsd), { expirationTtl: 172800 })
  return true
}

/**
 * Confirm on-chain that the payment went where we think it went.
 *
 * The whole claim being made — "settles to a non-ROZO key" — rests on
 * this. A 200 from the provider proves they served the call; it does not
 * prove where the money landed, and a provider who wanted to fake the
 * second thing would find the first one easy. So the destination is read
 * back from Horizon rather than inferred from what we intended to sign.
 */
async function assertSettledToProvider(
  env: Env,
  txHash: string,
  providerAddress: string,
): Promise<GateResult> {
  const horizon = (env.PLAYGROUND_HORIZON_URL || 'https://horizon.stellar.org').replace(/\/+$/, '')
  try {
    const res = await fetchWithTimeout(
      `${horizon}/transactions/${txHash}/operations?limit=50`,
      { headers: { Accept: 'application/json' } },
      PROBE_TIMEOUT_MS,
    )
    if (!res.ok) {
      return failure('settlement_unverified', `Horizon returned ${res.status} for ${txHash}.`)
    }
    const body = (await res.json()) as { _embedded?: { records?: any[] } }
    const records = body._embedded?.records ?? []
    const routerAddress = env.STELLAR_ROUTER_PUBLIC
    for (const op of records) {
      // Classic payment leg.
      if (op.to === providerAddress || op.into === providerAddress) {
        return { ok: true, detail: `Settled to ${providerAddress}.`, txHash }
      }
      // Soroban SEP-41 transfer: the destination sits in the invocation
      // parameters rather than in a typed field, so match on the rendered
      // form and require the provider address to be present while ours is
      // not — the second half is what rules out a forward-through-us shape.
      const asText = JSON.stringify(op)
      if (asText.includes(providerAddress)) {
        if (routerAddress && asText.includes(routerAddress)) {
          return failure(
            'settlement_not_direct',
            'The settlement transaction references the ROZO pool address. ' +
              'Direct settlement must pay the provider with no ROZO leg.',
          )
        }
        return { ok: true, detail: `Settled to ${providerAddress}.`, txHash }
      }
    }
    return failure(
      'settlement_not_found',
      `Transaction ${txHash} does not show a payment to ${providerAddress}.`,
    )
  } catch (err: any) {
    return failure('settlement_unverified', `Could not read ${txHash} from Horizon: ${err?.message}.`)
  }
}

/**
 * Pay one minimal call and assert the provider served it.
 *
 * Returns `{ok: false, code: 'gate_unavailable'}` — not a hard rejection —
 * when the verification wallet is unconfigured, so a deploy without the
 * secret leaves providers pending rather than failing them for something
 * that is our missing configuration, not their broken server.
 */
export async function gateRealMoneyCall(
  env: Env,
  record: ProviderRecord,
  spec: ProviderRouteSpec,
): Promise<GateResult> {
  const secret = env.PROVIDER_VERIFY_STELLAR_SECRET
  if (!secret) {
    return failure(
      'gate_unavailable',
      'The real-money verification wallet is not configured on this deployment. ' +
        'Your registration is stored and will publish once verification is available.',
    )
  }

  const priceUsd = Number(spec.priceUsd)
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return failure('bad_price', `Cannot verify a route priced "${spec.priceUsd}".`)
  }
  if (priceUsd > MAX_VERIFY_PAYMENT_USD) {
    return failure(
      'too_expensive_to_verify',
      `Verification pays for one real call, capped at $${MAX_VERIFY_PAYMENT_USD}. ` +
        `Your cheapest route costs $${spec.priceUsd}. Expose one inexpensive endpoint to verify with; ` +
        'it can be removed afterwards.',
    )
  }

  const stellarPayout = record.payouts.find(p => p.network.startsWith('stellar:'))
  if (!stellarPayout) {
    // Not a judgement about other chains — it is simply the leg our
    // verification wallet can pay today. §1 of the spec covers the rest:
    // a Stellar address is a keypair and we will sponsor its creation.
    return failure(
      'no_stellar_payout',
      'The real-money gate settles on Stellar, so one Stellar payout address is required. ' +
        'We can sponsor the account reserve and USDC trustline — see POST /v1/providers/sponsor.',
    )
  }

  if (!(await reserveDailyBudget(env, priceUsd))) {
    return failure(
      'budget_exhausted',
      'The daily verification budget is spent. Retry tomorrow.',
    )
  }

  let keypair: Keypair
  try {
    keypair = Keypair.fromSecret(secret)
  } catch {
    return failure('gate_unavailable', 'The verification wallet secret is malformed.')
  }

  const url = providerEndpointUrl(record, spec)
  const client = Mppx.create({
    methods: [stellar.charge({ keypair })],
    polyfill: false,
  })

  let response: Response
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAID_CALL_TIMEOUT_MS)
  try {
    response = await client.fetch(url, {
      method: spec.method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'mpprouter-verify/1' },
      ...(spec.method === 'POST' ? { body: '{}' } : {}),
      signal: controller.signal,
    } as RequestInit)
  } catch (err: any) {
    return failure(
      'paid_call_failed',
      `The paid call did not complete: ${err?.message ?? 'unknown error'}. ` +
        'Common causes: the challenge asks for an asset our wallet does not hold, ' +
        'or the endpoint rejects the credential it issued.',
    )
  } finally {
    clearTimeout(timer)
  }

  if (response.status !== 200) {
    return failure(
      'paid_call_not_200',
      `Paid call returned ${response.status}. A paying buyer must get a 200 and a body.`,
    )
  }

  const text = await response.text().catch(() => '')
  if (text.trim().length === 0) {
    return failure('empty_body', 'Paid call returned 200 with an empty body.')
  }

  // The receipt header carries the settlement reference. Absent it, we
  // cannot make the on-chain claim, and an unprovable claim is worse than
  // no publication: the payout gate is the whole point.
  const receiptHeader =
    response.headers.get('payment-receipt') ??
    response.headers.get('x-payment-response') ??
    ''
  const txHash = extractTxHash(receiptHeader)
  if (!txHash) {
    return failure(
      'no_receipt',
      'The provider served the call but returned no settlement receipt, so we cannot ' +
        'confirm on-chain where the money landed.',
    )
  }

  const settled = await assertSettledToProvider(env, txHash, stellarPayout.payTo)
  if (!settled.ok) return settled

  return {
    ok: true,
    detail: `Paid call returned 200 (${text.length} bytes); settlement confirmed to ${stellarPayout.payTo}.`,
    txHash,
    network: stellarPayout.network,
  }
}

/** Pull a 64-hex transaction hash out of a receipt header in any encoding. */
function extractTxHash(header: string): string | null {
  if (!header) return null
  const direct = header.match(/\b([0-9a-f]{64})\b/i)
  if (direct) return direct[1].toLowerCase()
  try {
    const decoded = atob(header.replace(/-/g, '+').replace(/_/g, '/'))
    const inner = decoded.match(/\b([0-9a-f]{64})\b/i)
    return inner ? inner[1].toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Pick the route the gates run against.
 *
 * The cheapest one: verification pays real money, and the provider should
 * not be charged more than necessary to prove their server works. Ties
 * break on the first declared route so the choice is deterministic and a
 * retry probes the same endpoint.
 */
export function chooseVerificationRoute(record: ProviderRecord): ProviderRouteSpec {
  return [...record.routes].sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd))[0]
}
