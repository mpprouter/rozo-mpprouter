/**
 * Stellar x402 Server — stellar.x402-in branch of the MPP Router proxy.
 *
 * Architecture
 * ------------
 * Agents that speak the x402 payment protocol (Coinbase's @x402/core
 * spec) over the Stellar network can hit the exact same public URLs
 * as legacy Stellar MPP (mppx) agents. When `classifyAuth()` sees an
 * x402 credential whose `payTo` matches this router's Stellar x402
 * recipient address, the proxy dispatches here instead of to the
 * Stellar mppx verify path.
 *
 * Flow, for one inbound stellar.x402 request:
 *   1. `parseStellarX402Header()` decodes the base64url payload from
 *      the `Authorization: Payment ...` header using the official
 *      `parsePaymentPayload` zod schema from `@x402/core/schemas`.
 *   2. `isAmountAcceptable()` applies the router's overpay tolerance
 *      policy (reject underpay, accept exact, accept overpay up to
 *      max(10¢, 10% of merchant quote) — the delta is router margin).
 *   3. `checkAndReserveNonce()` reserves the agent's Soroban auth
 *      entry nonce in KV so two concurrent workers can't both accept
 *      the same payment. This is a pre-broadcast guard on top of
 *      Soroban's own replay protection (the signed auth entry is
 *      single-use on-chain).
 *   4. `buildPaymentRequirementsForAgentAmount()` constructs a
 *      `PaymentRequirements` object that EXACTLY matches what the
 *      agent signed (scheme, network, asset, payTo, amount). The
 *      @x402/stellar `ExactStellarScheme` does strict equality on
 *      these fields, so passing the agent's own amount is the only
 *      way to make verify pass when the agent overpaid.
 *   5. `getFacilitator(env)` returns a lazily-initialized singleton
 *      `x402Facilitator` bound to the router's Stellar signer.
 *      `verify()` runs Soroban simulation + auth-entry validation.
 *   6. The proxy then pays the downstream merchant from the existing
 *      Tempo pool (unchanged — see `tempo-client.ts`).
 *   7. ONLY after merchant 2xx, `settleStellarX402()` submits the
 *      agent's signed Soroban invoke on chain, transferring their
 *      USDC to STELLAR_X402_PAY_TO. If merchant fails we never
 *      broadcast, so agent funds never move.
 *
 * Replay guards:
 *   - Chain-level: Soroban auth entry nonces are single-use; any
 *     replay after settle fails with DuplicateAuthNonce on chain.
 *   - KV-level (this file): pre-broadcast reservation in MPP_STORE
 *     under `stellar_x402:nonce:<from>:<nonce>`. TTL is capped at
 *     1 hour (Soroban auth entries typically expire much sooner,
 *     but we don't parse expiration here — the chain is the
 *     authoritative time-window enforcer).
 *
 * Runtime considerations:
 *   - The facilitator is lazily instantiated on first request per
 *     Worker isolate; @x402/stellar's `ExactStellarScheme` is a
 *     small class, the expensive thing is the Ed25519 signer setup
 *     which wraps `@stellar/stellar-sdk`'s `Keypair.fromSecret`.
 *   - Confirmed via a bundle-compatibility spike that
 *     `@x402/stellar/exact/facilitator` + its
 *     `@stellar/stellar-sdk/contract` dependency load cleanly in a
 *     Cloudflare Worker with `nodejs_compat` enabled. Bundle size
 *     impact: ~1.2 MB raw / ~230 KB gzipped.
 *
 * This module does NOT own any proxy routing logic. It exposes a
 * small set of functions the proxy calls. Keeping the x402 surface
 * here means the proxy file stays a flat top-to-bottom "classify
 * → probe merchant → verify → pay merchant → settle" script, and
 * stellar.x402 lands as one more branch parallel to the existing
 * stellar.charge / stellar.channel ones.
 */

import { x402Facilitator } from '@x402/core/facilitator'
import { parsePaymentPayload } from '@x402/core/schemas'
// Use the unified PaymentPayload type from `@x402/core/types` rather
// than the zod-derived one from `@x402/core/schemas`. The schemas
// export is a V1|V2 discriminated union where V1 lacks the
// `accepted` field; the types export is the post-normalization
// shape (V2-only for our purposes) with `accepted` required.
// facilitator.verify() takes the types-export shape.
import type {
  PaymentPayload,
  PaymentRequirements,
  Network,
} from '@x402/core/types'
import { safeBase64Decode, safeBase64Encode } from '@x402/core/utils'
import {
  createEd25519Signer,
  getUsdcAddress,
} from '@x402/stellar'
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator'
import type { Env } from '../index'

// ---------------------------------------------------------------------
// Facilitator singleton
// ---------------------------------------------------------------------

/**
 * In-Worker-isolate singleton for the facilitator. `@x402/core`'s
 * `x402Facilitator` holds a registration table and a reference to
 * the underlying Stellar signer; both are cheap but we want to
 * create them at most once per isolate.
 *
 * Cached key includes the rpc URL and network so a mid-isolate
 * config change (which shouldn't happen in Workers) forces a
 * rebuild.
 */
let cachedFacilitator:
  | { facilitator: x402Facilitator; rpcUrl: string; network: string }
  | null = null

function getFacilitator(env: Env): x402Facilitator {
  if (
    cachedFacilitator &&
    cachedFacilitator.rpcUrl === env.STELLAR_RPC_URL &&
    cachedFacilitator.network === env.STELLAR_NETWORK
  ) {
    return cachedFacilitator.facilitator
  }

  const network = env.STELLAR_NETWORK as Network
  // createEd25519Signer wraps Keypair.fromSecret + basicNodeSigner
  // from @stellar/stellar-sdk/contract. The `defaultNetwork` arg
  // sets the network passphrase used when signTransaction is called
  // without an explicit override — we pass the router's configured
  // network.
  const signer = createEd25519Signer(
    env.STELLAR_X402_FACILITATOR_SECRET,
    network,
  )

  const scheme = new ExactStellarScheme([signer], {
    rpcConfig: { url: env.STELLAR_RPC_URL },
    // areFeesSponsored defaults to true — the facilitator pays tx
    // fees on behalf of the agent. This matches our gas-sponsor
    // wallet model where the router's STELLAR_GAS_SECRET account
    // holds XLM specifically for this purpose.
  })

  const facilitator = new x402Facilitator()
  facilitator.register(network, scheme)

  cachedFacilitator = {
    facilitator,
    rpcUrl: env.STELLAR_RPC_URL,
    network: env.STELLAR_NETWORK,
  }
  return facilitator
}

// ---------------------------------------------------------------------
// Header parsing / fast classification
// ---------------------------------------------------------------------

/**
 * Decode an `Authorization: Payment <base64url>` header into a
 * validated `PaymentPayload`. Returns null on ANY failure — the
 * caller falls back to the existing `passthrough` behavior so we
 * never break non-x402 agents that happen to reuse the `Payment`
 * prefix for their own auth scheme.
 */
export function parseStellarX402Header(
  authHeader: string,
): PaymentPayload | null {
  if (!authHeader) return null
  const trimmed = authHeader.trim()
  if (!/^Payment\s+/i.test(trimmed)) return null
  const encoded = trimmed.replace(/^Payment\s+/i, '').trim()
  if (!encoded) return null
  let decoded: string
  try {
    decoded = safeBase64Decode(encoded)
  } catch {
    return null
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(decoded)
  } catch {
    return null
  }
  const result = parsePaymentPayload(parsedJson)
  if (!result.success) return null
  // Phase 1 supports x402 V2 only — V1 omits the `accepted` block
  // we need for dispatch + verify. V1 credentials fall through.
  if (result.data.x402Version !== 2) return null
  return result.data as unknown as PaymentPayload
}

/**
 * Fast check — does this header parse as an x402 credential whose
 * `payTo` is the router's Stellar recipient? Used by `classifyAuth`
 * to decide whether to route into the stellar.x402 branch. Does NOT
 * do signature verification or Soroban simulation; that happens
 * later via the `prepare`/`verify` two-phase split.
 *
 * Comparison rules:
 *   - `payload.accepted.scheme` must be 'exact'
 *   - `payload.accepted.network` must equal env.STELLAR_NETWORK
 *   - `payload.accepted.payTo` must equal env.STELLAR_X402_PAY_TO
 *     (Stellar addresses are case-sensitive — we compare exactly)
 */
export function isStellarX402ForThisRouter(
  authHeader: string,
  env: Env,
): boolean {
  if (env.X402_ENABLED !== 'true') return false
  if (!env.STELLAR_X402_PAY_TO) return false
  const payload = parseStellarX402Header(authHeader)
  if (!payload) return false
  if (payload.accepted.scheme !== 'exact') return false
  if (payload.accepted.network !== env.STELLAR_NETWORK) return false
  if (payload.accepted.payTo !== env.STELLAR_X402_PAY_TO) return false
  return true
}

// ---------------------------------------------------------------------
// Amount tolerance policy
// ---------------------------------------------------------------------

/**
 * Stellar USDC uses 7 decimals (not 6 like EVM). 10¢ = 0.10 USDC =
 * 1_000_000 base units at 7 decimals.
 *
 * This absolute-overpay tolerance keeps small merchant quotes
 * workable (on a 1¢ quote the 10% rule gives 0.1¢, which floors to
 * nothing, so we fall back to this).
 */
const ABSOLUTE_OVERPAY_TOLERANCE_BASE_UNITS_7DP = 1_000_000n

/**
 * Is the agent's signed amount acceptable for a merchant quoting
 * `merchant` base units (7 decimals)?
 *
 * Policy (locked in during the design conversation in tasks/todo.md):
 *   - signed < merchant         → reject (underpay)
 *   - signed === merchant       → accept (exact)
 *   - signed > merchant, overpay ≤ max(10¢, 10% of merchant)
 *                               → accept (overpay within tolerance;
 *                                 the delta is router margin)
 *   - signed > merchant, larger → reject (agent probably miscomputed,
 *                                 refuse rather than silently
 *                                 draining their wallet)
 *
 * bigint throughout — inputs are on-chain base units which can exceed
 * Number.MAX_SAFE_INTEGER for high-value calls.
 */
export function isAmountAcceptable(
  signed: bigint,
  merchant: bigint,
): { ok: true } | { ok: false; reason: string } {
  if (signed < merchant) {
    return {
      ok: false,
      reason: `underpay: signed ${signed} < merchant quote ${merchant}`,
    }
  }
  if (signed === merchant) return { ok: true }
  const overpay = signed - merchant
  const relativeTolerance = merchant / 10n // 10% of merchant, integer floor
  if (
    overpay <= ABSOLUTE_OVERPAY_TOLERANCE_BASE_UNITS_7DP ||
    overpay <= relativeTolerance
  ) {
    return { ok: true }
  }
  return {
    ok: false,
    reason:
      `overpay ${overpay} exceeds max(10¢=${ABSOLUTE_OVERPAY_TOLERANCE_BASE_UNITS_7DP}, ` +
      `10%=${relativeTolerance}) of merchant quote ${merchant}`,
  }
}

// ---------------------------------------------------------------------
// Replay guard (KV-level, pre-broadcast)
// ---------------------------------------------------------------------

/**
 * KV key derived from the 128-bit hash of the signed Soroban tx
 * XDR. Same XDR → same hash → KV collision → replay rejected.
 * Different XDR (different auth entry nonce inside Soroban) →
 * different hash → KV miss → new payment accepted.
 */
function nonceKeyFromHash(payloadHash: string): string {
  return `stellar_x402:payload:${payloadHash}`
}

/**
 * Atomically reserve the signed payload in KV so a concurrent
 * worker can't double-spend the same authorization. Returns
 * `{ ok: false }` on replay, `{ ok: true, release }` on first use.
 *
 * Not atomic in the strict sense — Cloudflare KV is eventually
 * consistent, so two workers racing within ~1s may both see "new"
 * and both attempt submission. Soroban's own nonce enforcement
 * catches this at the chain level (one submit reverts with
 * DuplicateAuthNonce), so the economic loss is bounded to one
 * wasted XLM tx fee. For strict once-and-only-once semantics we'd
 * migrate to a Durable Object — same residual as the existing
 * mppx path (see proxy.ts comments around line 705).
 *
 * TTL is hardcoded to 1 hour. Soroban auth entries typically expire
 * within a few ledgers (~30 seconds each), so after an hour any
 * replay would be refused by the chain anyway — the KV entry just
 * wastes a bit of storage. We could parse the exact expiration
 * ledger from the auth entry but it's not worth the code.
 */
const NONCE_TTL_SECONDS = 3600

export async function checkAndReserveNonce(
  env: Env,
  payloadHash: string,
): Promise<{ ok: true; release: () => Promise<void> } | { ok: false }> {
  const key = nonceKeyFromHash(payloadHash)
  const existing = await env.MPP_STORE.get(key)
  if (existing) return { ok: false }
  await env.MPP_STORE.put(key, '1', { expirationTtl: NONCE_TTL_SECONDS })
  return {
    ok: true,
    release: async () => {
      try {
        await env.MPP_STORE.delete(key)
      } catch (err: any) {
        console.error(
          `[stellar-x402] nonce release failed for ${key}: ${err.message}`,
        )
      }
    },
  }
}

// ---------------------------------------------------------------------
// PaymentRequirements construction
// ---------------------------------------------------------------------

/**
 * Build the `PaymentRequirements` we hand to `facilitator.verify()`.
 *
 * IMPORTANT: `ExactStellarScheme` does STRICT equality on every
 * field (scheme, network, asset, payTo, amount — matching the same
 * pattern as the EVM exact scheme). That means the amount we pass
 * must equal the value the agent signed, NOT the merchant's quote.
 * Overpay tolerance is enforced by `isAmountAcceptable()` BEFORE
 * calling this function; once past that check, the agent's signed
 * amount is what we require.
 *
 * `asset` resolves to the network-specific USDC Soroban Asset
 * Contract address via `getUsdcAddress()`, exported from
 * `@x402/stellar`. For `stellar:pubnet` that's
 * `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`.
 */
export function buildPaymentRequirementsForAgentAmount(
  env: Env,
  agentSignedAmount: bigint,
): PaymentRequirements {
  const network = env.STELLAR_NETWORK as Network
  const asset = getUsdcAddress(network)
  return {
    scheme: 'exact',
    network,
    amount: agentSignedAmount.toString(),
    asset,
    payTo: env.STELLAR_X402_PAY_TO,
    // Stellar auth entries have their own shorter expiration
    // baked in at sign time. This field is mostly advisory for
    // x402-over-HTTP clients deciding how long to cache the
    // 402 challenge.
    maxTimeoutSeconds: 300,
    // @x402/stellar's ExactStellarScheme does not require any
    // specific `extra` fields (unlike @x402/evm which needs
    // EIP-712 domain name/version). getExtra() on the facilitator
    // only adds `areFeesSponsored` for discovery. We leave this
    // empty.
    extra: {},
  }
}

/**
 * Build the base64-encoded value for the `Payment-Required` HTTP
 * header that x402-spec-compliant clients read on a 402 response.
 *
 * Why this exists: when a vanilla x402 client (e.g.
 * `@x402/core/client`'s `x402HTTPClient.getPaymentRequiredResponse`)
 * receives a 402 from the router, it looks for a `PAYMENT-REQUIRED`
 * header to learn what to sign. The router's mppx 402 path emits
 * the legacy `WWW-Authenticate: Payment ...` format that
 * vanilla x402 clients don't understand. To make those clients
 * work without any custom code, we ALSO inject a standard x402
 * `Payment-Required` header on the same response. mppx clients
 * ignore the new header (they still read `WWW-Authenticate`),
 * x402 clients ignore the `WWW-Authenticate` (they read
 * `Payment-Required`). One 402 serves both audiences.
 *
 * Inputs:
 *   - `env` — for `X402_ENABLED`, `STELLAR_NETWORK`, `STELLAR_X402_PAY_TO`
 *   - `merchantQuoteTempoBaseUnits` — the merchant's live quote in
 *     Tempo USDC base units (6 decimals). We multiply by 10n to
 *     convert to Stellar USDC base units (7 decimals) since that's
 *     what the agent must sign.
 *   - `resourceUrl` — the agent's request URL, echoed back in the
 *     `resource.url` field per x402 spec
 *
 * Returns the base64 string ready to drop into a header value, or
 * `null` when `X402_ENABLED !== 'true'` (in which case the router
 * skips dual-format injection entirely and only emits mppx format).
 *
 * Note on `extra.areFeesSponsored: true` — required by
 * `@x402/stellar/exact/client` at sign time. The router IS
 * sponsoring fees (its `ExactStellarScheme` defaults to
 * `areFeesSponsored: true` and the facilitator pays from
 * `STELLAR_X402_FACILITATOR_SECRET`'s XLM balance), so this is
 * truthful, not aspirational.
 */
export function buildX402PaymentRequiredHeader(
  env: Env,
  merchantQuoteTempoBaseUnits: bigint,
  resourceUrl: string,
): string | null {
  if (env.X402_ENABLED !== 'true') return null
  if (!env.STELLAR_X402_PAY_TO) return null

  // Convert Tempo 6dp → Stellar 7dp (×10). Same conversion the
  // dispatch branch does on the way in. Keep these two call sites
  // consistent — if you ever add a non-USDC-6 merchant, both must
  // change together.
  const stellarAmount = merchantQuoteTempoBaseUnits * 10n
  const network = env.STELLAR_NETWORK as Network

  const paymentRequired = {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: resourceUrl },
    accepts: [
      {
        scheme: 'exact',
        network,
        amount: stellarAmount.toString(),
        asset: getUsdcAddress(network),
        payTo: env.STELLAR_X402_PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { areFeesSponsored: true },
      },
    ],
  }

  return safeBase64Encode(JSON.stringify(paymentRequired))
}

// ---------------------------------------------------------------------
// Top-level verify / settle helpers (thin wrappers around the facilitator)
// ---------------------------------------------------------------------

/**
 * Shape of what @x402/stellar/exact/client emits in `payload.payload`:
 *
 *   { transaction: <base64url XDR string> }
 *
 * That's it — one field. The source account, Soroban auth nonce,
 * amount, destination, etc. are all encoded inside the XDR. The
 * facilitator parses them via `@stellar/stellar-sdk`'s
 * Transaction.fromXDR() during verify().
 *
 * We don't need to decode the XDR here. For the router's KV replay
 * guard we just hash the XDR string itself — same XDR → same hash,
 * different XDR → different hash. Since Soroban auth entries embed
 * a one-shot nonce that changes per submission, this is correct
 * replay detection at the payload level (not the payer level, but
 * that's fine: a single payer can legitimately have many active
 * payments in flight).
 */
type StellarExactPayload = {
  transaction?: string
}

/**
 * Compute a stable 32-char identifier for an XDR string. Uses
 * Web Crypto SHA-256 which is available in Cloudflare Workers
 * without any polyfill. We truncate to 32 hex chars (128 bits)
 * which is more than enough to avoid collision under any sane
 * load.
 */
async function hashXdr(xdr: string): Promise<string> {
  const encoded = new TextEncoder().encode(xdr)
  const hash = await crypto.subtle.digest('SHA-256', encoded)
  const bytes = new Uint8Array(hash)
  let hex = ''
  for (let i = 0; i < 16; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

async function extractPayloadIdentity(
  payload: PaymentPayload,
): Promise<{ payloadHash: string } | null> {
  const raw = payload.payload as StellarExactPayload | undefined
  if (!raw || typeof raw.transaction !== 'string' || raw.transaction.length === 0) {
    return null
  }
  const payloadHash = await hashXdr(raw.transaction)
  return { payloadHash }
}

export type StellarX402VerifyFail = {
  ok: false
  reason: string
  statusCode: number
}

/**
 * Phase A — local-only inbound preparation. Parses the header,
 * extracts the signed amount + payload hash, applies the overpay
 * tolerance policy, and builds the `PaymentRequirements` we'll
 * later hand to the facilitator. Does NOT touch KV and does NOT
 * make any RPC calls.
 *
 * The proxy MUST call this BEFORE checking the KV replay guard,
 * which in turn MUST run BEFORE the chain-side `verifyStellarX402WithFacilitator`
 * call. This ordering exists for one specific reason: the facilitator's
 * verify() runs a Soroban `simulateTransaction` against the live
 * network, and a replayed payload's auth nonce has already been
 * consumed on chain — simulate fails with
 * `invalid_exact_stellar_payload_simulation_failed`. We want the
 * KV-level guard to fire FIRST and return a clean
 * `replay detected` error instead of leaking the chain-level
 * detail (which is also slower because it round-trips RPC).
 *
 * Returns a sum type so the proxy can branch on prepare-stage
 * failures (malformed header, underpay, etc.) without ever
 * touching KV.
 */
export type StellarX402PrepareOk = {
  ok: true
  payload: PaymentPayload
  requirements: PaymentRequirements
  signedAmount: bigint
  payloadHash: string
}
export type StellarX402PrepareFail = StellarX402VerifyFail

export async function prepareStellarX402Inbound(
  env: Env,
  authHeader: string,
  merchantQuoteBaseUnits: bigint,
): Promise<StellarX402PrepareOk | StellarX402PrepareFail> {
  const payload = parseStellarX402Header(authHeader)
  if (!payload) {
    return {
      ok: false,
      reason: 'invalid stellar x402 payload format',
      statusCode: 402,
    }
  }
  // Parse the agent's signed amount from the payload's own `accepted`
  // block. @x402/stellar stores the committed amount there during
  // payload construction — `payload.accepted.amount` is a base-unit
  // integer string at the network's token decimals (7 for USDC).
  let signedAmount: bigint
  try {
    signedAmount = BigInt(payload.accepted.amount)
  } catch {
    return {
      ok: false,
      reason: `stellar x402 payload has non-integer accepted.amount: ${payload.accepted.amount}`,
      statusCode: 402,
    }
  }
  const amountCheck = isAmountAcceptable(signedAmount, merchantQuoteBaseUnits)
  if (!amountCheck.ok) {
    return {
      ok: false,
      reason: `stellar x402 amount rejected: ${amountCheck.reason}`,
      statusCode: 402,
    }
  }
  // Extract the opaque payload identity. @x402/stellar puts only
  // `{ transaction: <XDR> }` in payload.payload — we hash the XDR
  // as our dedup key for the KV replay guard the proxy will run
  // next.
  const identity = await extractPayloadIdentity(payload)
  if (!identity) {
    return {
      ok: false,
      reason:
        'stellar x402 payload missing `transaction` XDR (unexpected shape for exact scheme)',
      statusCode: 402,
    }
  }
  const requirements = buildPaymentRequirementsForAgentAmount(env, signedAmount)
  return {
    ok: true,
    payload,
    requirements,
    signedAmount,
    payloadHash: identity.payloadHash,
  }
}

/**
 * Phase B — chain-side facilitator verify. Runs Soroban simulate
 * against the live network through the @x402/stellar
 * `ExactStellarScheme` facilitator. RPC calls happen here.
 *
 * The proxy MUST call this AFTER `checkAndReserveNonce` succeeds —
 * see `prepareStellarX402Inbound`'s docstring for why.
 */
export async function verifyStellarX402WithFacilitator(
  env: Env,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<{ ok: true } | StellarX402VerifyFail> {
  let facilitator: x402Facilitator
  try {
    facilitator = getFacilitator(env)
  } catch (err: any) {
    return {
      ok: false,
      reason: `stellar x402 facilitator init failed: ${err.message}`,
      statusCode: 500,
    }
  }
  let verifyResult
  try {
    verifyResult = await facilitator.verify(payload, requirements)
  } catch (err: any) {
    return {
      ok: false,
      reason: `stellar x402 verify threw: ${err.message}`,
      statusCode: 402,
    }
  }
  if (!verifyResult.isValid) {
    return {
      ok: false,
      reason: `stellar x402 verify failed: ${verifyResult.invalidReason ?? 'unknown'}`,
      statusCode: 402,
    }
  }
  return { ok: true }
}

export type StellarX402SettleResult = {
  success: boolean
  transaction?: string
  errorReason?: string
  errorMessage?: string
}

/**
 * Submit the agent's signed Soroban invoke on chain. Called ONLY
 * after the downstream merchant has returned 2xx, so the router
 * never collects USDC for a request the agent didn't actually get
 * served.
 *
 * No sponsor mode for Stellar — `areFeesSponsored` is baked into
 * the scheme at construction time and we always pay the few-stroop
 * tx fees out of the facilitator's XLM balance. If you want to
 * skip broadcast entirely, flip `X402_ENABLED=false` at the env
 * level; there's no in-between for Stellar.
 */
export async function settleStellarX402(
  env: Env,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<StellarX402SettleResult> {
  let facilitator: x402Facilitator
  try {
    facilitator = getFacilitator(env)
  } catch (err: any) {
    return {
      success: false,
      errorReason: 'facilitator_init_failed',
      errorMessage: err.message,
    }
  }
  try {
    const result = await facilitator.settle(payload, requirements)
    return {
      success: result.success,
      transaction: result.transaction,
      errorReason: result.errorReason,
      errorMessage: result.errorMessage,
    }
  } catch (err: any) {
    return {
      success: false,
      errorReason: 'settle_threw',
      errorMessage: err.message,
    }
  }
}
