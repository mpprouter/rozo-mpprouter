/**
 * Tempo MPP Client — pays merchants on Tempo L2.
 *
 * Two modes:
 *
 * 1. Charge (`payMerchant`) — single-shot 402 settle per request.
 *    Used by fixed-price merchants (Firecrawl, Exa, Parallel). mppx
 *    client auto-handles the challenge: 402 → sign TIP-20 transfer
 *    from Router's EVM wallet → retry with credential → 200.
 *
 * 2. Session (`payMerchantSession`) — long-lived payment channel
 *    with streaming cumulative vouchers. Used by dynamic-price
 *    merchants (OpenRouter). The channel is opened ONCE on-chain
 *    via `scripts/open-channel.ts`, then every agent request
 *    bumps an off-chain cumulative voucher signed by the Router.
 *    mppx still handles the 402 dance; we supply the manual
 *    voucher context via the `onChallenge` hook.
 *
 * Why both on one client: the `Mppx.create` API registers a list
 * of methods and dispatches on the merchant's challenge intent
 * (`charge` vs `session`), so a single client can handle either
 * kind of merchant. We keep them in separate helpers because the
 * session path needs to read + write channel state in KV on every
 * request, and the charge path should not pay that overhead.
 */

import { Mppx, tempo, sessionLegacy as legacySession, Transport } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'
import type { Env } from '../index'
import { getTempoClient } from './tempo-rpc'
import {
  bumpCumulative,
  getTempoChannel,
  type TempoChannelState,
} from './channel-store'

/**
 * Minimal shape of the ChannelEntry that mppx passes to the
 * `onChannelUpdate` callback. Defined here rather than imported
 * from mppx internals because that path is a non-public internal
 * module (see session-support-plan.md §8 risks). If a future mppx
 * release moves or renames the type we only need to update this
 * local stub, not a deep import path.
 *
 * In mppx 0.7.0 the TIP-1034 session path includes `descriptor` on
 * the entry (shape: { authorizedSigner, expiringNonceHash, operator,
 * payee, payer, salt, token }). The legacy session entry does not
 * include it. We declare it optional so both paths share this type.
 */
type ChannelEntryLike = {
  channelId: `0x${string}`
  cumulativeAmount: bigint
  escrowContract?: `0x${string}`
  chainId: number
  opened: boolean
  descriptor?: {
    authorizedSigner: `0x${string}`
    expiringNonceHash: `0x${string}`
    operator: `0x${string}`
    payee: `0x${string}`
    payer: `0x${string}`
    salt: `0x${string}`
    token: `0x${string}`
  }
}

/**
 * Error thrown by `payMerchantSession` when a merchant has not had
 * its channel opened yet. The proxy catches this and returns a 503
 * to the agent with a clear "session not installed" message so the
 * operator knows to run `scripts/open-channel.ts`.
 */
/**
 * Thrown when a merchant's live 402 asks for more than the caller's declared
 * ceiling. Raised from the `onChallenge` hook, i.e. BEFORE any credential is
 * signed, so no money moves: an over-priced or compromised merchant cannot
 * drain the router's pool just because a route is on an allow-list.
 *
 * Only callers that pass `maxAmountRaw` can see this. Callers that omit it
 * (the public proxy) keep their existing unbounded behaviour byte-for-byte.
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly merchantUrl: string,
    public readonly requestedRaw: string,
    public readonly maxRaw: string,
  ) {
    super(
      `Merchant asked for ${requestedRaw} base units but the caller's ceiling is ${maxRaw}. ` +
        `Refusing to sign a credential.`,
    )
    this.name = 'BudgetExceededError'
  }
}

/**
 * Read the merchant-requested amount out of a 402 challenge.
 *
 * Both tempo.charge and tempo.session put a base-unit integer string in
 * `challenge.request.amount` (USDC-6, so "10000" is $0.01). A challenge we
 * cannot parse is treated as a budget violation rather than waved through —
 * an unreadable price is exactly when we least want to sign blind.
 */
function assertWithinBudget(
  challenge: unknown,
  merchantUrl: string,
  maxAmountRaw: string,
): void {
  const requested = (challenge as any)?.request?.amount
  if (typeof requested !== 'string' || !/^\d+$/.test(requested)) {
    throw new BudgetExceededError(merchantUrl, String(requested), maxAmountRaw)
  }
  if (BigInt(requested) > BigInt(maxAmountRaw)) {
    throw new BudgetExceededError(merchantUrl, requested, maxAmountRaw)
  }
}

export class ChannelNotInstalledError extends Error {
  constructor(public readonly merchantId: string) {
    super(
      `No Tempo channel installed for merchant "${merchantId}". ` +
        `Run scripts/open-channel.ts to open one.`,
    )
    this.name = 'ChannelNotInstalledError'
  }
}

/**
 * Max size of an upstream `payment-required` header we will attempt to
 * parse/rewrite. A merchant fully controls this header; cap it before we
 * base64/JSON-decode so a hostile or buggy merchant cannot make us do
 * unbounded work. 16 KiB is ~10x the largest legitimate header we've
 * seen (multi-offer x402 with extensions runs ~3.5 KiB).
 */
const MAX_PAYMENT_REQUIRED_HEADER_BYTES = 16 * 1024

/** mppx 0.7.0's x402 schema only accepts EVM CAIP-2 networks. */
const EVM_CAIP2 = /^eip155:\d+$/

/**
 * Defensive fetch wrapper for the router→merchant leg.
 *
 * Root cause (docs/rootcause-invalid-base64-json-header-2026-06-24.md):
 * mppx 0.7.0's `x402Challenges` decodes the WHOLE `payment-required`
 * header against a strict EVM-only schema. If ANY `accepts[]` offer
 * carries an unrecognized network (e.g. a merchant that added a
 * `solana:...` offer), the decode throws `InvalidJsonHeaderError`
 * ("Invalid base64 JSON header.") and — because mppx spreads the
 * www-authenticate and x402 challenge lists into one array literal —
 * the throw discards the perfectly usable `www-authenticate` (Tempo)
 * challenge too. The router then 502s with "Merchant payment failed".
 *
 * This wrapper sits UNDER the mppx client (passed as `config.fetch`),
 * so it sees the raw upstream 402 before mppx parses it. On a 402 it
 * drops any `payment-required` offer mppx can't parse, then validates
 * the rewrite using mppx's OWN parser as the oracle:
 *   - rewrite parses cleanly  → forward the rewritten response
 *   - rewrite still fails AND a www-authenticate header is present
 *                             → strip payment-required entirely, let
 *                               mppx fall back to the Tempo challenge
 *   - rewrite still fails AND no www-authenticate → forward UNCHANGED
 *                               so mppx surfaces its own real error
 *                               (we never silently swallow).
 *
 * The router client registers only tempo.charge / tempo.session /
 * legacySession — there is no `evm/charge` method — so retained eip155
 * x402 offers are never payable by us anyway; dropping the non-EVM ones
 * cannot change which party/amount we pay. Falling back to
 * www-authenticate pays the same Tempo challenge the proxy already
 * quoted the customer. See codex review 2026-06-24, findings #4/#5/#7/#8.
 *
 * Scope guards (codex #8): only touches outbound 402 responses; caps
 * header size before parsing; never rewrites inbound client credentials
 * (this fetch only runs for merchant requests we originate); logs counts
 * and reasons only, never header contents.
 */
function sanitizeMerchant402Fetch(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await baseFetch(input as any, init as any)
    return sanitize402Response(response)
  }) as typeof globalThis.fetch
}

/** True iff mppx's own x402/www-authenticate parser accepts this response. */
function mppxCanParse(resp: Response): boolean {
  try {
    const t = Transport.http()
    // Use the same parser mppx will use. getChallenges is the list form
    // (what Fetch.from prefers); fall back to getChallenge.
    if (t.getChallenges) t.getChallenges(resp)
    else t.getChallenge(resp)
    return true
  } catch {
    return false
  }
}

/**
 * Pure core of the merchant-402 sanitizer (exported for unit tests).
 *
 * Given an upstream response, returns a response mppx's client can parse:
 *  - not a 402, or no `payment-required` header → unchanged
 *  - already parseable → unchanged (fast path)
 *  - drop non-EVM (`!eip155:\d+`) offers and re-validate with mppx's own
 *    parser; forward the rewrite only if it now parses
 *  - if rewrite still fails: strip `payment-required` so mppx falls back
 *    to the `www-authenticate` (Tempo) challenge when present, else
 *    forward UNCHANGED so mppx raises its own real error (never swallow)
 *
 * See the wrapper's doc comment + docs/rootcause-...-2026-06-24.md.
 */
export function sanitize402Response(
  response: Response,
  // Injectable only so tests can assert the oversized guard short-circuits
  // BEFORE any parse (codex #1). Production always uses mppx's real parser.
  canParse: (r: Response) => boolean = mppxCanParse,
): Response {
  if (response.status !== 402) return response

  const prHeader = response.headers.get('payment-required')
  if (!prHeader) return response // nothing to sanitize (pure www-authenticate)

  const hasWwwAuth = response.headers.has('www-authenticate')

  // Bound the work BEFORE we hand anything to a parser (codex review #1/R2):
  // an oversized header is merchant-controlled and suspicious, so we must
  // not feed it into mppx's base64/JSON/schema parser at all. We ALWAYS
  // strip it — never return it to mppx — because this wrapper sits under
  // Mppx.create and mppx would otherwise re-parse the oversized header.
  //  - with www-authenticate present → mppx falls back to the Tempo challenge
  //  - without www-authenticate → the 402 now carries no challenge, so mppx
  //    raises a clean "no challenge" error instead of parsing 17 KiB of
  //    attacker-controlled bytes. Either way no parser touches the header.
  if (prHeader.length > MAX_PAYMENT_REQUIRED_HEADER_BYTES) {
    console.warn(
      `[tempo] oversized payment-required header (${prHeader.length}B) from merchant; ` +
        `stripping (will not be parsed)` +
        (hasWwwAuth ? '; falling back to www-authenticate' : '; no www-authenticate fallback'),
    )
    return withoutPaymentRequired(response)
  }

  // Fast path: if mppx can already parse it, do nothing.
  if (canParse(response)) return response

  // Try to drop offers mppx can't handle (non-EVM networks).
  let kept = 0
  let dropped = 0
  let rewritten: Response | null = null
  try {
    const obj = JSON.parse(Buffer.from(prHeader, 'base64').toString('utf8'))
    if (obj && Array.isArray(obj.accepts)) {
      const filtered = obj.accepts.filter(
        (a: any) => typeof a?.network === 'string' && EVM_CAIP2.test(a.network),
      )
      dropped = obj.accepts.length - filtered.length
      kept = filtered.length
      if (kept > 0 && dropped > 0) {
        const newObj = { ...obj, accepts: filtered }
        const newHeader = Buffer.from(JSON.stringify(newObj)).toString('base64')
        rewritten = cloneWithPaymentRequired(response, newHeader)
      }
    }
  } catch {
    // base64/JSON garbage — fall through to the strip/forward decision.
  }

  // Use mppx's OWN parser as the oracle (codex #7): only forward the
  // rewrite if mppx now accepts it. This also catches the case where a
  // *retained* eip155 offer is itself malformed.
  if (rewritten && canParse(rewritten)) {
    console.log(
      `[tempo] sanitized merchant 402: dropped ${dropped} unparseable offer(s), kept ${kept}`,
    )
    return rewritten
  }

  // Rewrite didn't help. Prefer the Tempo (www-authenticate) challenge
  // if the merchant offered one; otherwise forward unchanged so mppx
  // raises its own real error instead of us swallowing it.
  if (hasWwwAuth) {
    console.warn(
      `[tempo] payment-required unparseable by mppx after filter; ` +
        `stripping it, falling back to www-authenticate (Tempo)`,
    )
    return withoutPaymentRequired(response)
  }
  console.warn(
    `[tempo] payment-required unparseable by mppx and no www-authenticate fallback; ` +
      `forwarding unchanged so mppx surfaces the underlying error`,
  )
  return response
}

/** Return a clone of `response` with the payment-required header replaced. */
function cloneWithPaymentRequired(response: Response, header: string): Response {
  const headers = new Headers(response.headers)
  headers.set('payment-required', header)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Return a clone of `response` with the payment-required header removed. */
function withoutPaymentRequired(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.delete('payment-required')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Build an mppx client that can handle both tempo.charge and
 * tempo.session challenges.
 *
 * In manual session mode we pass an `onChannelUpdate` callback
 * that mppx calls after every voucher sign; that's where we
 * persist the new cumulative watermark back to KV. Without this
 * callback a cold Worker restart would sign a voucher using the
 * stored cumulative and immediately get rejected by the merchant
 * ("non-monotonic cumulative") because the merchant already has
 * a higher cumulative from the previous voucher.
 *
 * The charge method has no equivalent callback — it's stateless
 * per request, which is exactly why it fits a Worker cleanly.
 */
function createTempoClientInternal(
  env: Env,
  opts: {
    /**
     * onChallenge hook forwarded to Mppx.create. Used by the
     * session path to compute `cumulativeAmountRaw = stored + delta`
     * at the moment the 402 arrives, and to call `createCredential`
     * with the manual voucher context.
     */
    onChallenge?: Parameters<typeof Mppx.create>[0]['onChallenge']
    /**
     * Called by mppx after every successful voucher sign. We use
     * it to bump the KV watermark. mppx passes `cumulativeAmount`
     * as a bigint here, which matches what the KV store already
     * stores as a base-unit string.
     */
    onChannelUpdate?: (entry: ChannelEntryLike) => void | Promise<void>
  } = {},
) {
  const account = privateKeyToAccount(env.TEMPO_ROUTER_PRIVATE_KEY as `0x${string}`)

  // Shared, isolate-lived viem client. This is the ONLY supported way to
  // get `env.TEMPO_RPC_URL` into the payment path: none of the three
  // methods below accepts an `rpcUrl` parameter — they each call
  // `Client.getResolver({ rpcUrl: defaults.rpcUrl })` with mppx's own
  // hardcoded map and would otherwise always hit the public endpoint.
  // Passing `getClient` also stops us building a new client (and opening
  // a new connection) on every single 402. See src/mpp/tempo-rpc.ts.
  const getClient = () => getTempoClient(env.TEMPO_RPC_URL)

  // Three methods registered:
  //
  // 1. `tempo.charge` — single-shot intent, unchanged.
  //
  // 2. `tempo.session(...)` (TIP-1034, `sessionMethod` in 0.7.0) — handles
  //    merchants that advertise `sessionProtocol: 'v2'` in their 402
  //    challenge. This is what anthropic, openai, gemini, openrouter now
  //    send. In manual mode (no `deposit` param), mppx dispatches on
  //    `canHandleChallenge` → v2 → this method, then calls `onChallenge`
  //    where we supply `{action, channelId, cumulativeAmountRaw, descriptor}`.
  //    The `descriptor` field is required by TIP-1034 — absent in 0.4.12,
  //    the root cause of the bug.
  //
  // 3. `legacySession(...)` (legacy contract-backed session, was `session`
  //    in 0.4.12, now re-exported as `sessionLegacy` in 0.7.0) — handles
  //    merchants that advertise `sessionProtocol: 'v1'` or omit it. Provides
  //    backward compatibility for any merchant still on the old protocol.
  //    Its manual-mode context does NOT require `descriptor`.
  //
  // mppx dispatches on `canHandleChallenge` to pick the right method:
  //   v2 challenge → tempo.session (TIP-1034)
  //   v1 / absent  → legacySession
  //
  // No `deposit` parameter on either session method — that parameter is
  // what flips them into auto mode. Leaving it unset keeps us in manual
  // mode where our `onChallenge` hook controls every voucher.
  const mppx = Mppx.create({
    methods: [
      tempo.charge({ account, getClient }),
      tempo.session({
        account,
        getClient,
        onChannelUpdate: opts.onChannelUpdate,
      }),
      legacySession({
        account,
        getClient,
        onChannelUpdate: opts.onChannelUpdate as any,
      }),
    ],
    polyfill: false,
    onChallenge: opts.onChallenge,
    // Wrap the underlying fetch so we sanitize the upstream merchant's
    // 402 BEFORE mppx parses it. This covers BOTH the charge
    // (`payMerchant`) and session (`payMerchantSession`) legs because
    // both go through this single factory (codex review #5). Without
    // this, a merchant that adds a non-EVM (e.g. solana) x402 offer
    // poisons mppx's whole challenge list and the router 502s with
    // "Invalid base64 JSON header".
    fetch: sanitizeMerchant402Fetch(globalThis.fetch),
  } as any)

  return mppx
}

/**
 * Pay a Tempo merchant for a single fixed-price request. The
 * mppx client handles the full 402 dance automatically via the
 * registered `tempo.charge` method.
 *
 * Unchanged from the pre-session Router — callers that speak
 * tempo.charge (Firecrawl, Exa, Parallel) must NOT switch to
 * `payMerchantSession`.
 */
export async function payMerchant(
  env: Env,
  merchantUrl: string,
  init?: RequestInit,
  opts: {
    /**
     * Optional hard ceiling on what this single call may cost, as a USDC-6
     * base-unit integer string. When set, an `onChallenge` hook inspects the
     * merchant's 402 and throws `BudgetExceededError` before signing anything
     * if the merchant wants more.
     *
     * Omit it and behaviour is exactly as before — no hook is installed at
     * all, so the proxy's payment path is untouched.
     */
    maxAmountRaw?: string
    /**
     * Fired SYNCHRONOUSLY at the exact moment a paid credential is signed for
     * THIS call — inside `onChallenge`, right before `createCredential`. This
     * is the only reliable per-call, call-correlated signal that money is
     * committed: unlike the KV channel watermark it is not async-written, not
     * route-wide, and only fires when a real 402 challenge is answered (so an
     * initial non-402 500/404 never trips it).
     *
     * Installing this callback forces an `onChallenge` hook even without a
     * budget; the hook still does the default passthrough sign, so behaviour
     * for a paying call is unchanged.
     *
     * The callback receives the base-unit (USDC-6) amount the router is paying
     * the merchant for THIS call, read from the merchant's 402 challenge. This
     * is the real per-call upstream cost, used by the channel playground for
     * real-cost reconciliation. Existing no-arg callers ignore it.
     */
    onCredentialSigned?: (amountRaw?: string) => void
  } = {},
): Promise<Response> {
  const needsHook = Boolean(opts.maxAmountRaw || opts.onCredentialSigned)
  const client = createTempoClientInternal(
    env,
    needsHook
      ? {
          onChallenge: async (challenge, { createCredential }) => {
            if (opts.maxAmountRaw) assertWithinBudget(challenge, merchantUrl, opts.maxAmountRaw)
            // No context: tempo.charge signs its default single-shot intent.
            const credential = await createCredential()
            // Signal ONLY AFTER the credential actually exists. If
            // createCredential throws, `paid` stays false and the caller
            // releases — there is no "paid=true but nothing signed" window.
            opts.onCredentialSigned?.(String((challenge as any).request?.amount ?? ''))
            return credential
          },
        }
      : {},
  )
  return client.fetch(merchantUrl, init)
}

/**
 * Add two base-unit cumulative amounts using BigInt so we don't
 * lose precision on amounts above 2^53. Both inputs and output
 * are non-negative integer strings.
 */
function addRaw(a: string, bRaw: string): string {
  return (BigInt(a) + BigInt(bRaw)).toString()
}

/**
 * Pay a Tempo merchant through an existing payment channel.
 *
 * Prerequisites:
 *   - `scripts/open-channel.ts` has been run for this merchantId
 *     and the resulting `TempoChannelState` is in KV.
 *   - The merchant speaks `tempo.session` on this route.
 *
 * Flow:
 *   1. Load the current channel state from KV — need the stored
 *      cumulativeRaw to compute the new voucher amount.
 *   2. Build a fresh mppx client for this request. The client's
 *      `onChallenge` hook intercepts the merchant's 402 challenge,
 *      reads the merchant-requested delta from it, computes
 *      `newCumulativeRaw = stored + delta`, and creates a
 *      manual-mode voucher credential.
 *   3. mppx retries the request with that credential and returns
 *      the merchant's final response.
 *   4. `onChannelUpdate` fires after the voucher is signed and
 *      bumps the KV watermark to the new cumulative.
 *
 * IMPORTANT: step 4 runs BEFORE we know whether the merchant
 * returned 2xx or 5xx. See §5 of session-support-plan.md — the
 * commit-after-2xx rule is enforced by the proxy layer, not
 * here. This helper will happily bump the cumulative for a
 * failed upstream request; the proxy either (a) only calls
 * this helper after Stellar settle has succeeded and trusts
 * that the next in-flight request will pick up the new watermark,
 * or (b) rolls the watermark forward on success by passing a
 * callback the proxy controls. We go with (a) because rollback
 * in an eventually-consistent KV is harder to get right than
 * "next voucher starts from wherever we landed, good or bad."
 *
 * The caller is responsible for handling ChannelNotInstalledError.
 */
export async function payMerchantSession(
  env: Env,
  merchantId: string,
  merchantUrl: string,
  init: RequestInit = {},
  opts: {
    /** See `payMerchant`. Checked before the voucher is signed. */
    maxAmountRaw?: string
    /**
     * See `payMerchant`. Fired synchronously when the voucher is signed, with
     * the base-unit (USDC-6) delta the router is paying for THIS call.
     */
    onCredentialSigned?: (amountRaw?: string) => void
  } = {},
): Promise<{ response: Response; channelBefore: TempoChannelState }> {
  const channel = await getTempoChannel(env, merchantId)
  if (!channel) {
    throw new ChannelNotInstalledError(merchantId)
  }

  const client = createTempoClientInternal(env, {
    // Intercept the merchant's 402 challenge so we can compute the
    // cumulative-after-this-request ourselves. mppx then signs a
    // voucher with that value and retries.
    onChallenge: async (challenge, { createCredential }) => {
      // Session challenge request shape (after the zod transform
      // in tempo.session's request schema): amount is a base-unit
      // string like "10000" for $0.01 at 6 decimals.
      const delta = (challenge as any).request?.amount as string | undefined
      if (!delta || !/^\d+$/.test(delta)) {
        throw new Error(
          `tempo.session challenge for ${merchantId} missing valid base-unit amount: ${delta}`,
        )
      }
      // Budget ceiling, checked before the voucher is signed. Once signed the
      // cumulative has advanced and the money is committed, so this is the
      // last point at which refusing is free.
      if (opts.maxAmountRaw) {
        assertWithinBudget(challenge, merchantUrl, opts.maxAmountRaw)
      }
      // Compute the new cumulative FIRST — if addRaw throws (malformed
      // stored/delta amount) nothing was signed and `paid` must stay false.
      const newCumulativeRaw = addRaw(channel.cumulativeRaw, delta)
      // Manual-mode context: tell mppx "sign a voucher action on
      // channel X at the new cumulative".
      //
      // For TIP-1034 (v2) merchants, `descriptor` is REQUIRED in the
      // context — the TIP-1034 session method (`tempo.session`) needs
      // it to derive the on-chain channel ID and sign the voucher.
      // `descriptor` is captured at channel open time by
      // `scripts/admin/open-tempo-channel.ts` via `onChannelUpdate`
      // and stored in KV alongside `channelId` and `cumulativeRaw`.
      //
      // For legacy (v1) merchants, `descriptor` is absent from KV
      // entries opened with pre-0.7.0 mppx. The `legacySession` method
      // handles their challenges without requiring `descriptor`.
      // Including it when present is harmless; legacySession ignores it.
      const credential = await createCredential({
        action: 'voucher',
        channelId: channel.channelId,
        cumulativeAmountRaw: newCumulativeRaw,
        ...(channel.descriptor ? { descriptor: channel.descriptor } : {}),
      } as any)
      // Signal ONLY AFTER the voucher credential actually exists. A throw in
      // addRaw or createCredential leaves `paid` false → the caller releases.
      opts.onCredentialSigned?.(delta)
      return credential
    },
    onChannelUpdate: async (entry: ChannelEntryLike) => {
      // mppx gives us the just-signed cumulative as a bigint.
      // Persist it to KV so a cold-isolate restart sees the
      // new watermark.
      //
      // We use `bumpCumulative` (monotone) instead of a blind
      // put so the KV side is safe even if two in-flight
      // requests race: the slower write will see an equal or
      // higher value and drop silently rather than rewinding.
      await bumpCumulative(env, merchantId, entry.cumulativeAmount.toString())
    },
  })

  const response = await client.fetch(merchantUrl, init)
  return { response, channelBefore: channel }
}

/**
 * Backwards-compat export — existing callers of `createTempoClient`
 * in scripts/tests should keep working. The new signature keeps
 * the single-arg form that just returns a vanilla client with
 * both methods registered.
 */
export function createTempoClient(env: Env) {
  return createTempoClientInternal(env)
}
