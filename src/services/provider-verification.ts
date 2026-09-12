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
 *   must parse, every payout address the provider REGISTERED must appear
 *   in it on its own network with exactly that address, and the price on
 *   those networks must match what they declared. This catches the whole
 *   class of "the form says one thing and the server says another",
 *   including the important one: a server quoting an address the
 *   registrant does not control.
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
 * ## Two dialects, one wallet
 *
 * A provider's 402 arrives in one of two shapes, and both are real:
 * `@stellar/mpp` servers emit an mppx `WWW-Authenticate` challenge, and
 * x402-native providers (Agent402 among them) emit `accepts[]` in a
 * `PAYMENT-REQUIRED` header or JSON body. Gate 1 reads both; gate 2 pays
 * each with the client that speaks it — `mppx` for the first, `@x402/core`
 * + `@x402/stellar` for the second — from the same verification keypair.
 * Paying an x402 challenge with the mppx client (the 2026-09-05 shape) did
 * not fail loudly; it failed as `paid_call_failed` with a message about
 * assets, which is what an x402-native provider would have hit at the
 * last step of an otherwise honest flow.
 *
 * ## Networks the provider advertises but did not register
 *
 * A multi-chain x402 provider typically advertises Base, Solana and
 * Stellar in one challenge. The registration only has to prove the
 * networks it wants LISTED; the others are reported back as
 * `unlisted_networks` and never published. Nothing in this router routes
 * a buyer to an address that was not registered and proven, so an extra
 * advertised network is the provider's business, not a gate failure.
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
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { ExactStellarScheme } from '@x402/stellar/exact/client'
import { createEd25519Signer } from '@x402/stellar'
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
export const MAX_VERIFY_PAYMENT_USD = 0.02

/** Daily ceiling across all verifications, in USD. Same reasoning, aggregated. */
const DAILY_VERIFY_BUDGET_USD = 2.0

const DAILY_SPEND_PREFIX = 'providerVerifySpend:'

export type ChallengeDialect = 'x402' | 'mppx'

export type GateResult =
  | {
      ok: true
      detail: string
      txHash?: string
      network?: string
      dialect?: ChallengeDialect
      /** Networks the provider advertises that the registration did not claim. */
      unlistedNetworks?: string[]
    }
  | {
      ok: false
      code: string
      detail: string
      /**
       * Set when money may already have moved. A failure that carries a
       * hash is reconcilable from the chain; one without is not, and the
       * claim store keeps it frozen rather than paying again.
       */
      txHash?: string
      dialect?: ChallengeDialect
    }

function failure(code: string, detail: string, extra: { txHash?: string; dialect?: ChallengeDialect } = {}): GateResult {
  return { ok: false, code, detail, ...extra }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
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

/**
 * Address equality per network. EVM addresses are case-insensitive
 * (EIP-55 is a checksum, not an identity); Stellar and Solana are
 * case-sensitive base32/base58 and must match exactly. Shared with the
 * ownership proof so the two gates cannot disagree about the same pair.
 */
export function sameAddress(network: string, a: string, b: string): boolean {
  return network.startsWith('eip155:') ? a.toLowerCase() === b.toLowerCase() : a === b
}

// ---------------------------------------------------------------------
// Challenge parsing
// ---------------------------------------------------------------------

export interface ParsedProviderChallenge {
  /** Every settlement option the provider advertises. */
  accepts: Array<{ network: string; payTo: string; amount: string; decimals: number; asset?: string }>
  /** Which dialect the challenge arrived in, for the error messages and the payer. */
  dialect: ChallengeDialect
  /** x402 only: the protocol version the provider speaks (1 or 2). */
  x402Version?: number
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
  if (out.length === 0) return null
  const version = typeof body.x402Version === 'number' ? body.x402Version : undefined
  return { accepts: out, dialect: 'x402', ...(version ? { x402Version: version } : {}) }
}

function parseMppxChallenge(wwwAuth: string): ParsedProviderChallenge | null {
  try {
    // An MPP challenge names its method. Only `stellar` is a Stellar
    // settlement; Agent402, for one, serves `method="evm"` (Base) in
    // WWW-Authenticate NEXT TO an x402 accepts[] that does include Stellar.
    // Reading the EVM request as a Stellar recipient labelled an 0x address
    // `stellar:pubnet` in production on 2026-09-12. Anything other than
    // stellar falls through to the x402 parser.
    const methodMatch = wwwAuth.match(/method="([^"]+)"/)
    if (methodMatch && methodMatch[1].toLowerCase() !== 'stellar') return null
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
  fetchImpl: typeof fetch = fetch,
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
      fetchImpl,
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

  // Every REGISTERED payout must be advertised, on its own network, with
  // exactly the registered address. A registered address the endpoint never
  // quotes is unproven by this gate; an advertised address that differs is
  // the typo (or the impostor) the whole gate exists to catch.
  const advertisedNetworks = new Set(challenge.accepts.map(a => a.network))
  for (const payout of record.payouts) {
    const onNetwork = challenge.accepts.filter(a => a.network === payout.network)
    if (onNetwork.length === 0) {
      return failure(
        'payout_not_advertised',
        `Your registration lists a ${payout.network} payout, but the live 402 offers no ` +
          `${payout.network} settlement option, so that address cannot be verified against your server.`,
        { dialect: challenge.dialect },
      )
    }
    const match = onNetwork.find(a => sameAddress(payout.network, a.payTo, payout.payTo))
    if (!match) {
      return failure(
        'paytoaddress_mismatch',
        `The challenge pays ${payout.network} to an address that is not the one you registered. ` +
          'Registered and advertised addresses must match exactly.',
        { dialect: challenge.dialect },
      )
    }
  }

  // The price must match what the catalog will advertise, or buyers get a
  // 402 for one amount after reading another. Checked on the networks the
  // registration claims; an unlisted network's price is never published.
  const registeredNetworks = new Set(record.payouts.map(p => p.network))
  for (const accept of challenge.accepts) {
    if (!registeredNetworks.has(accept.network)) continue
    const advertised = (() => {
      try {
        return BigInt(accept.amount)
      } catch {
        return null
      }
    })()
    if (advertised === null) {
      return failure('bad_amount', `Challenge amount "${accept.amount}" is not an integer.`, { dialect: challenge.dialect })
    }
    const declaredHere = toBaseUnits(spec.priceUsd, accept.decimals)
    if (declaredHere === null) {
      return failure('bad_price', `Declared price "${spec.priceUsd}" is not representable.`, { dialect: challenge.dialect })
    }
    if (advertised !== declaredHere) {
      return failure(
        'price_mismatch',
        `Registered ${spec.priceUsd} USD for ${spec.operation}, but the endpoint charges ` +
          `${advertised} base units on ${accept.network} (expected ${declaredHere}).`,
        { dialect: challenge.dialect },
      )
    }
  }

  const unlisted = [...advertisedNetworks].filter(n => !registeredNetworks.has(n))
  return {
    ok: true,
    detail:
      `402 well-formed (${challenge.dialect}); every registered payout is advertised at the registered price.` +
      (unlisted.length > 0
        ? ` The endpoint also offers ${unlisted.join(', ')}, which is not registered and will not be listed.`
        : ''),
    dialect: challenge.dialect,
    ...(unlisted.length > 0 ? { unlistedNetworks: unlisted } : {}),
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
 *
 * Exported so an uncertain verification can be reconciled later from the
 * hash alone, without paying again.
 */
export async function assertSettledToProvider(
  env: Env,
  txHash: string,
  providerAddress: string,
  fetchImpl: typeof fetch = fetch,
  /**
   * Our verification wallet's public key. When known, the paying operation
   * must originate from it: a hash the provider picked from its own
   * history (any old transfer to itself) must not certify OUR payment.
   */
  expectedFrom?: string,
): Promise<GateResult> {
  const horizon = (env.PLAYGROUND_HORIZON_URL || 'https://horizon.stellar.org').replace(/\/+$/, '')
  try {
    const res = await fetchWithTimeout(
      `${horizon}/transactions/${txHash}/operations?limit=50`,
      { headers: { Accept: 'application/json' } },
      PROBE_TIMEOUT_MS,
      fetchImpl,
    )
    if (res.status === 404) {
      return failure('tx_not_on_ledger', `Transaction ${txHash} is not on the ledger.`, { txHash })
    }
    if (!res.ok) {
      return failure('settlement_unverified', `Horizon returned ${res.status} for ${txHash}.`, { txHash })
    }
    const body = (await res.json()) as { _embedded?: { records?: any[] } }
    const records = body._embedded?.records ?? []
    const routerAddress = env.STELLAR_ROUTER_PUBLIC
    // Structured, never textual: a transfer is a classic `payment` op with
    // typed from/to, or a Soroban invocation whose Horizon
    // `asset_balance_changes[]` lists a `transfer` with typed from/to. A
    // provider who controls the receipt header can name any hash, so a
    // hash only counts when the ledger shows OUR wallet moving value to
    // THEIR address — not when both strings merely appear somewhere in an
    // invocation's parameters.
    for (const op of records) {
      if (op.transaction_successful === false) {
        return failure('settlement_not_found', `Transaction ${txHash} failed on the ledger.`, { txHash })
      }
      const transfers: Array<{ from?: string; to?: string }> = []
      if (op.type === 'payment' || op.type === 'path_payment_strict_send' || op.type === 'path_payment_strict_receive') {
        transfers.push({ from: op.from, to: op.to })
      }
      if (op.type === 'invoke_host_function' && Array.isArray(op.asset_balance_changes)) {
        for (const change of op.asset_balance_changes) {
          if (change?.type === 'transfer') transfers.push({ from: change.from, to: change.to })
        }
      }
      for (const t of transfers) {
        if (expectedFrom && t.from !== expectedFrom) continue
        if (routerAddress && t.to === routerAddress) {
          return failure(
            'settlement_not_direct',
            'The settlement transaction pays the ROZO pool address. ' +
              'Direct settlement must pay the provider with no ROZO leg.',
            { txHash },
          )
        }
        if (t.to === providerAddress) {
          return { ok: true, detail: `Settled to ${providerAddress}.`, txHash }
        }
      }
    }
    return failure(
      'settlement_not_found',
      `Transaction ${txHash} shows no transfer${expectedFrom ? ' from the verification wallet' : ''} to ${providerAddress}.`,
      { txHash },
    )
  } catch (err: any) {
    return failure('settlement_unverified', `Could not read ${txHash} from Horizon: ${err?.message}.`, { txHash })
  }
}

/** Public key of the verification wallet, or undefined when unconfigured/malformed. */
export function verifyWalletPublicKey(env: Env): string | undefined {
  try {
    return env.PROVIDER_VERIFY_STELLAR_SECRET ? Keypair.fromSecret(env.PROVIDER_VERIFY_STELLAR_SECRET).publicKey() : undefined
  } catch {
    return undefined
  }
}

/**
 * Did OUR verification wallet pay `providerAddress` since `sinceIso`?
 *
 * Independent of any hash the provider handed us: read our own account's
 * recent operations from Horizon. `null` means the question could not be
 * answered (no wallet, Horizon down) and callers must treat that as
 * "possibly paid", never as "not paid".
 */
export async function verifyWalletPaidProviderSince(
  env: Env,
  providerAddress: string,
  sinceIso: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  const from = verifyWalletPublicKey(env)
  if (!from) return null
  const horizon = (env.PLAYGROUND_HORIZON_URL || 'https://horizon.stellar.org').replace(/\/+$/, '')
  const since = Date.parse(sinceIso)
  if (!Number.isFinite(since)) return null
  // Walk newest → oldest until an operation older than `since` proves the
  // window is fully covered. A scan that ends before reaching that point —
  // pagination cap, missing cursor, Horizon error — is INCOMPLETE and
  // answers null: "not seen on the pages we read" is not "not paid".
  let url = `${horizon}/accounts/${from}/operations?order=desc&limit=200`
  for (let page = 0; page < 10; page++) {
    let body: { _embedded?: { records?: any[] }; _links?: { next?: { href?: string } } }
    try {
      const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, PROBE_TIMEOUT_MS, fetchImpl)
      if (!res.ok) return null
      body = (await res.json()) as typeof body
    } catch {
      return null
    }
    const records = body._embedded?.records ?? []
    for (const op of records) {
      const createdAt = op.created_at ? Date.parse(op.created_at) : NaN
      if (Number.isFinite(createdAt) && createdAt < since) return false
      if (op.transaction_successful === false) continue
      if (op.to === providerAddress) return true
      if (op.type === 'invoke_host_function' && Array.isArray(op.asset_balance_changes)
        && op.asset_balance_changes.some((c: any) => c?.type === 'transfer' && c.to === providerAddress)) return true
    }
    // Fewer than a full page means the account history is exhausted
    // before `since`: nothing older exists, so nothing was paid.
    if (records.length < 200) return false
    const next = body._links?.next?.href
    if (!next) return null
    url = next.startsWith('http') ? next : `${horizon}${next}`
  }
  return null
}

/**
 * The paid HTTP call itself, dialect-specific.
 *
 * Injectable so the gate can be tested end to end against recorded 402 and
 * receipt shapes without a funded key. The default pays with the client
 * that speaks the provider's dialect.
 */
export interface PaidCallRequest {
  dialect: ChallengeDialect
  url: string
  method: 'GET' | 'POST'
  secret: string
  /** Soroban RPC for the x402 client; mainnet has no public default. */
  rpcUrl: string
  network: string
  signal: AbortSignal
  /**
   * What the paid challenge is allowed to ask for. The free probe read ONE
   * 402; the paid call fetches a fresh one, and a provider that serves a
   * cheap, correctly-addressed challenge to the probe and a different one
   * to the payment must be refused BEFORE anything is signed. Recipient
   * must match exactly; amount must not exceed the registered price.
   */
  expected: { payTo: string; maxAmountBaseUnits: bigint }
}
export type PaidCallExecutor = (req: PaidCallRequest) => Promise<Response>

/** Thrown by an executor when the paid-phase challenge disagrees with the registration. Nothing was signed. */
export class ChallengeMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChallengeMismatchError'
  }
}

function assertChallengeWithinRegistration(
  expected: PaidCallRequest['expected'],
  network: string,
  offered: { payTo: string; amount: string },
): void {
  if (!sameAddress(network, offered.payTo, expected.payTo)) {
    throw new ChallengeMismatchError(
      `The paid-phase 402 pays ${network} to a different address than the one registered and probed. Refusing to sign.`,
    )
  }
  let amount: bigint
  try {
    amount = BigInt(offered.amount)
  } catch {
    throw new ChallengeMismatchError(`The paid-phase 402 amount "${offered.amount}" is not an integer. Refusing to sign.`)
  }
  if (amount > expected.maxAmountBaseUnits) {
    throw new ChallengeMismatchError(
      `The paid-phase 402 asks for ${amount} base units, above the registered ${expected.maxAmountBaseUnits}. Refusing to sign.`,
    )
  }
}

export async function payWithMppx(req: PaidCallRequest, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const client = Mppx.create({
    methods: [stellar.charge({ keypair: Keypair.fromSecret(req.secret) })],
    polyfill: false,
    fetch: fetchImpl,
    // Runs before any credential is created: the recipient and amount in
    // the live challenge are checked against the registration, and a
    // mismatch aborts the whole paid call with nothing signed.
    onChallenge: async (challenge: any, helpers: { createCredential: () => Promise<string> }) => {
      const request = (challenge?.request ?? {}) as { recipient?: string; amount?: string }
      assertChallengeWithinRegistration(req.expected, req.network, {
        payTo: String(request.recipient ?? ''),
        amount: String(request.amount ?? ''),
      })
      return helpers.createCredential()
    },
  } as any)
  return client.fetch(req.url, {
    method: req.method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'mpprouter-verify/1' },
    ...(req.method === 'POST' ? { body: '{}' } : {}),
    signal: req.signal,
  } as RequestInit)
}

/**
 * Pay an x402 `accepts[]` challenge on Stellar.
 *
 * `@x402/core` selects among the provider's offers by registered network,
 * so a multi-chain challenge is paid on `stellar:pubnet` and nothing else
 * — the Base and Solana offers are ignored by construction, not by luck.
 * Only x402 **v2** is payable here (the Stellar exact scheme is registered
 * for v2; `registerV1` is not used). A v1 challenge parses in gate 1 and
 * then fails closed in gate 2 with `challenge_mismatch`/`paid_call_failed`
 * — the provider stays pending, nothing is signed.
 */
export async function payWithX402(req: PaidCallRequest, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const signer = createEd25519Signer(req.secret, req.network as any)
  const core = new x402Client()
  core.register(req.network as any, new ExactStellarScheme(signer, { url: req.rpcUrl }))
  const http = new x402HTTPClient(core)
  const init: RequestInit = {
    method: req.method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'mpprouter-verify/1' },
    ...(req.method === 'POST' ? { body: '{}' } : {}),
    signal: req.signal,
  }
  const first = await fetchImpl(req.url, init)
  if (first.status !== 402) return first
  const bodyText = await first.text().catch(() => '')
  let body: unknown = undefined
  try {
    body = JSON.parse(bodyText)
  } catch {
    // v2 carries the challenge in a header; a non-JSON body is fine.
  }
  // v2 puts the challenge in PAYMENT-REQUIRED; some servers (and every v1
  // server) put it in the JSON body. Accept either, in that order.
  let paymentRequired: any
  try {
    paymentRequired = http.getPaymentRequiredResponse(name => first.headers.get(name), body)
  } catch {
    const fromBody = body as { accepts?: unknown[] } | undefined
    if (fromBody && Array.isArray(fromBody.accepts) && fromBody.accepts.length > 0) paymentRequired = fromBody
    else throw new ChallengeMismatchError('The paid-phase 402 carried no readable x402 challenge. Refusing to sign.')
  }
  // Constrain BEFORE signing: only the registered network's entry, and only
  // if it pays the registered address for no more than the registered
  // price. The core client would otherwise happily sign whichever entry it
  // selected from a challenge the probe never saw.
  // EVERY entry the client could pick must pass, not just the first one on
  // the network: a challenge can list a cheap unsupported-scheme entry
  // first and an expensive `exact` one second. So the candidate set is
  // reduced to entries that individually satisfy scheme, network, address
  // and cap, and the client is only allowed to choose among those.
  const acceptable = (paymentRequired.accepts ?? []).filter((a: any) => {
    if (String(a.scheme ?? '') !== 'exact' || a.network !== req.network) return false
    try {
      assertChallengeWithinRegistration(req.expected, req.network, { payTo: String(a.payTo ?? ''), amount: String(a.amount ?? '') })
      return true
    } catch {
      return false
    }
  })
  if (acceptable.length === 0) {
    const onNetwork = (paymentRequired.accepts ?? []).filter((a: any) => a.network === req.network)
    if (onNetwork.length === 0) {
      throw new ChallengeMismatchError(`The paid-phase 402 offers no ${req.network} settlement option. Refusing to sign.`)
    }
    // Re-run the check on the first on-network entry for a precise message.
    assertChallengeWithinRegistration(req.expected, req.network, { payTo: String(onNetwork[0].payTo ?? ''), amount: String(onNetwork[0].amount ?? '') })
    throw new ChallengeMismatchError(`The paid-phase 402 has no exact-scheme ${req.network} entry within the registration. Refusing to sign.`)
  }
  core.registerPolicy((_v, reqs) => reqs.filter(r => acceptable.includes(r)))
  const payload = await http.createPaymentPayload({ ...paymentRequired, accepts: acceptable })
  const paymentHeaders = http.encodePaymentSignatureHeader(payload)
  return fetchImpl(req.url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...paymentHeaders },
  })
}

const defaultExecutor: PaidCallExecutor = req =>
  req.dialect === 'x402' ? payWithX402(req) : payWithMppx(req)

/** Pull a 64-hex transaction hash out of a receipt header in any encoding. */
export function extractTxHash(header: string): string | null {
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
 * The settlement receipt, wherever the provider's stack puts it.
 *
 * `payment-receipt` is mppx; `payment-response` is x402 v2; the
 * `x-payment-response` spelling is x402 v1. The base64 JSON inside carries
 * `transaction` for x402 and a hash for mppx; either way a 64-hex string
 * is what gets read back from Horizon.
 */
export function receiptTxHash(headers: Headers): string | null {
  for (const name of ['payment-receipt', 'payment-response', 'x-payment-response']) {
    const value = headers.get(name)
    if (!value) continue
    const hash = extractTxHash(value)
    if (hash) return hash
  }
  return null
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
  dialect: ChallengeDialect,
  deps: { execute?: PaidCallExecutor; fetchImpl?: typeof fetch } = {},
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

  if (dialect === 'x402' && !env.STELLAR_RPC_URL) {
    return failure(
      'gate_unavailable',
      'Paying an x402 challenge on Stellar needs a Soroban RPC (STELLAR_RPC_URL) on this deployment.',
    )
  }

  if (!(await reserveDailyBudget(env, priceUsd))) {
    return failure(
      'budget_exhausted',
      'The daily verification budget is spent. Retry tomorrow.',
    )
  }

  try {
    Keypair.fromSecret(secret)
  } catch {
    return failure('gate_unavailable', 'The verification wallet secret is malformed.')
  }

  const url = providerEndpointUrl(record, spec)
  const maxAmount = toBaseUnits(spec.priceUsd, 7)
  if (maxAmount === null) {
    return failure('bad_price', `Cannot express "${spec.priceUsd}" in Stellar base units.`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAID_CALL_TIMEOUT_MS)
  let response: Response
  try {
    response = await (deps.execute ?? defaultExecutor)({
      dialect,
      url,
      method: spec.method,
      secret,
      rpcUrl: env.STELLAR_RPC_URL ?? '',
      network: stellarPayout.network,
      signal: controller.signal,
      expected: { payTo: stellarPayout.payTo, maxAmountBaseUnits: maxAmount },
    })
  } catch (err: any) {
    if (err instanceof ChallengeMismatchError) {
      // Nothing was signed; the provider's paid-phase challenge disagreed
      // with what it showed the probe. Safe to retry, and worth recording.
      return failure('challenge_mismatch', err.message, { dialect })
    }
    return failure(
      'paid_call_failed',
      `The paid call did not complete: ${err?.message ?? 'unknown error'}. ` +
        'Common causes: the challenge asks for an asset our wallet does not hold, ' +
        'or the endpoint rejects the credential it issued.',
      { dialect },
    )
  } finally {
    clearTimeout(timer)
  }

  // Read the receipt before judging the status: a 5xx that still carries a
  // settlement hash is "paid, not served", which is reconcilable and must
  // not be reported as if no money moved.
  const txHash = receiptTxHash(response.headers)

  if (response.status !== 200) {
    return failure(
      'paid_call_not_200',
      `Paid call returned ${response.status}. A paying buyer must get a 200 and a body.`,
      { dialect, ...(txHash ? { txHash } : {}) },
    )
  }

  const text = await response.text().catch(() => '')
  if (text.trim().length === 0) {
    return failure('empty_body', 'Paid call returned 200 with an empty body.', { dialect, ...(txHash ? { txHash } : {}) })
  }

  // The receipt header carries the settlement reference. Absent it, we
  // cannot make the on-chain claim, and an unprovable claim is worse than
  // no publication: the payout gate is the whole point.
  if (!txHash) {
    return failure(
      'no_receipt',
      'The provider served the call but returned no settlement receipt, so we cannot ' +
        'confirm on-chain where the money landed.',
      { dialect },
    )
  }

  const settled = await assertSettledToProvider(env, txHash, stellarPayout.payTo, deps.fetchImpl, verifyWalletPublicKey(env))
  if (!settled.ok) return { ...settled, dialect }

  return {
    ok: true,
    detail: `Paid call returned 200 (${text.length} bytes); settlement confirmed to ${stellarPayout.payTo}.`,
    txHash,
    network: stellarPayout.network,
    dialect,
  }
}

/**
 * Pick the route the gates run against.
 *
 * The cheapest one: verification pays real money, and the provider should
 * not be charged more than necessary to prove their server works. Ties
 * break on the first declared route so the choice is deterministic and a
 * retry probes the same endpoint. A route the provider marked
 * `verify_with` wins outright, so a request-dependent POST is never forced
 * through an empty body when a documented no-input GET exists.
 */
export function chooseVerificationRoute(record: ProviderRecord): ProviderRouteSpec {
  const pinned = record.routes.find(r => r.verifyWith)
  if (pinned) return pinned
  return [...record.routes].sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd))[0]
}
