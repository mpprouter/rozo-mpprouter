/**
 * The playground's single door to upstream merchants.
 *
 * ---------------------------------------------------------------------------
 * What this reuses, and what it deliberately does not
 * ---------------------------------------------------------------------------
 * The router already knows how to pay a merchant per call: `payMerchant()` in
 * `src/mpp/tempo-client.ts` builds an mppx client with `tempo.charge`
 * registered and performs the whole 402 → sign TIP-20 USDC transfer → retry
 * handshake, returning the upstream's response. That function IS the charge
 * seam, and this module calls it directly.
 *
 * What it does not reuse is `handleProxy` / `payMerchantAndGetBody` in
 * `src/routes/proxy.ts`. That path is the paid public proxy: it classifies
 * agent credentials, mints 402 challenges, and consults a global
 * `x-request-id` idempotency cache in KV that is read *before* auth. The
 * playground has no business touching any of it, and routing playground
 * traffic through it would make a 2,177-line payment-critical file a
 * dependency of a landing-page demo. Instead the request is constructed here,
 * server-side, from a fixed route descriptor — the caller never supplies a
 * URL, a merchant, or a body that reaches the upstream unshaped.
 *
 * ---------------------------------------------------------------------------
 * Two upstream flavours
 * ---------------------------------------------------------------------------
 *   1. **Router-held credential** (`route.upstreamAuth`) — Mercury. No Tempo
 *      payment happens at all; the router injects its own scoped JWT and
 *      fetches directly. Cost to the router is the credential's quota, which
 *      is why these calls consume the same daily rate-limit slot the proxy
 *      consumes (see `consumeUpstreamRateLimit`).
 *   2. **tempo.charge** — Groq, DeepSeek. `payMerchant()` pays per call out of
 *      the router's own pool.
 *   3. **tempo.session** — OpenAI, Anthropic. `payMerchantSession()` signs a
 *      cumulative voucher against a pre-opened Tempo channel whose state lives
 *      in `MPP_STORE`. This mirrors the `merchantIntent === 'session'` branch
 *      in `proxy.ts:659`.
 *
 * On the cumulative watermark: `payMerchantSession` installs an
 * `onChannelUpdate` hook that persists the just-signed cumulative via
 * `bumpCumulative`, which is monotone. The playground relies on that hook alone
 * and deliberately does NOT replicate the extra post-2xx `bumpCumulative` the
 * proxy performs: that call derives its delta from `parsed.request.amount` off
 * the live 402, which the playground never sees because `payMerchantSession`
 * handles the challenge internally, so replicating it would make the playground
 * an independent writer of a value it cannot compute correctly.
 *
 * The watermark is NEVER read back to decide settlement. It is async-written
 * (mppx does not await `onChannelUpdate`), route-wide (a concurrent call moves
 * it), and blind to initial non-402 failures — three ways to mis-settle. The
 * playground instead uses a call-local `paid` flag flipped synchronously the
 * instant a credential is signed for THIS request (see `onCredentialSigned`).
 *
 * A merchant with no channel installed raises `ChannelNotInstalledError`. That
 * is an operator-provisioning gap, not a user error, so it maps to a 503 and
 * the caller's reservation is released — see `failCall` in the route layer.
 */

import type { Env } from '../index'
import type { PublicServiceRoute } from '../services/merchants-types'
import { getRouteByPublicPath, resolveUpstreamPath } from '../services/merchants'
import { injectUpstreamAuth } from '../routes/proxy'
import {
  BudgetExceededError,
  ChannelNotInstalledError,
  payMerchant,
  payMerchantSession,
} from '../mpp/tempo-client'
import { toTempoRaw6 } from './amount'
import { checkAndBumpDailyLimit, utcDateKey } from '../mpp/rate-limit-do'

/**
 * Did a paid credential get signed for this call?
 *
 * This is the single most consequential fact about a failed playground call,
 * because it decides whether the user's hold is refunded or charged. It is
 * derived from the call-local `paid` flag (see `onCredentialSigned`), so it is
 * a real per-call fact, not an inference:
 *
 *   - `'no'`  — no credential was signed for THIS call. Provably unpaid; the
 *               hold is released. Covers pre-dispatch refusals, initial non-402
 *               errors, and router-held-credential (Mercury) routes.
 *   - `'yes'` — a credential was signed for this call. The money committed (or,
 *               for a failure right after signing, may have), so charge.
 *
 * `'maybe'` remains in the union only as the constructor default for a raw
 * error that predates classification; the settlement layer treats it the same
 * as `'yes'` (commit), because an unclassified failure must not release funds
 * that may have moved. No code path in this module emits it deliberately.
 */
export type PaymentEvidence = 'no' | 'maybe' | 'yes'

export class UpstreamError extends Error {
  readonly code: string
  readonly status: number
  /** Whether the router's payment went through. Drives commit-vs-release. */
  readonly paymentEvidence: PaymentEvidence
  constructor(code: string, status: number, message: string, paymentEvidence: PaymentEvidence = 'maybe') {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    this.status = status
    this.paymentEvidence = paymentEvidence
  }
}

/**
 * Look up a route the playground is allowed to call.
 *
 * The `verifiedMode` check is the same gate the proxy applies: a route that
 * has never completed a real paid call must not be reachable, and the
 * playground is not the place to discover that a merchant is broken.
 *
 * Both `tempo.charge` and `tempo.session` are accepted — `callUpstream`
 * dispatches on the mode. Session routes can still fail at call time if the
 * operator never opened a channel for them; that is handled where it is
 * detectable, not guessed at here.
 */
export function resolvePlaygroundRoute(
  publicPath: string,
  method: 'GET' | 'POST',
): PublicServiceRoute {
  const route = getRouteByPublicPath(publicPath, method)
  if (!route) {
    throw new UpstreamError(
      'route_unknown',
      500,
      `playground route ${publicPath} is not registered`,
      'no',
    )
  }
  if (!route.verifiedMode) {
    throw new UpstreamError('route_unverified', 503, `route ${route.id} is not verified`, 'no')
  }
  return route
}

/**
 * Consume one slot of a router-held credential's daily allowance.
 *
 * This shares the proxy's key namespace (`ratelimit:<service>:<utc-day>`) on
 * purpose. The cap exists to protect the credential itself, and a playground
 * call spends exactly the same Mercury quota a paid proxy call does — giving
 * the playground its own separate counter would let the two together spend
 * twice the cap the provider actually granted us.
 *
 * Only called for `upstreamAuth` routes with a configured `rateLimit`, and
 * only immediately before the upstream request, so a refused call never burns
 * allowance.
 */
async function consumeUpstreamRateLimit(env: Env, route: PublicServiceRoute): Promise<void> {
  if (!route.upstreamAuth || !route.rateLimit) return
  const key = `ratelimit:${route.service}:${utcDateKey()}`
  const result = await checkAndBumpDailyLimit(env, key, route.rateLimit.perDay)
  if (!result.ok) {
    throw new UpstreamError(
      'upstream_rate_limited',
      429,
      `daily cap reached for ${route.service} (${result.used}/${result.limit})`,
      // Refused before the request was ever dispatched — nothing was paid.
      'no',
    )
  }
}

/**
 * Call an upstream route and return its response.
 *
 * `query` supplies both `{placeholder}` path substitutions and any residual
 * query string. `body` is JSON-serialised for POST routes. Nothing from the
 * end user reaches here except through the caller's own validation.
 */
/**
 * The result of one upstream call: the merchant's response, plus whether a
 * paid credential was actually signed for THIS call.
 *
 * `paid` is the call-local, signing-correlated payment signal — set from a
 * callback fired synchronously inside the payment seam's `onChallenge`, the
 * exact moment a credential is created. It replaces the old KV-watermark
 * inference, which was async-written, route-wide (a concurrent call moved it),
 * and blind to initial non-402 failures.
 */
export interface UpstreamCall {
  response: Response
  paid: boolean
}

export async function callUpstream(
  env: Env,
  args: {
    route: PublicServiceRoute
    query?: Record<string, string>
    body?: unknown
    timeoutMs?: number
    /**
     * Hard ceiling on what the ROUTER may pay upstream for this call, in
     * 7-decimal atomic USD. Required for any route that costs money — see
     * `callUpstreamJson`, which every caller uses.
     */
    budgetAtomic?: bigint
  },
): Promise<UpstreamCall> {
  const { route } = args
  const searchParams = new URLSearchParams(args.query ?? {})
  const { path, consumed } = resolveUpstreamPath(route, searchParams)

  // Placeholder params are consumed by the path; anything left is real query.
  for (const name of consumed) searchParams.delete(name)
  const search = searchParams.toString()
  const merchantUrl = `https://${route.upstreamHost}${path}${search ? `?${search}` : ''}`

  const headers = new Headers({ accept: 'application/json' })
  let payload: string | undefined
  if (args.body !== undefined) {
    payload = JSON.stringify(args.body)
    headers.set('content-type', 'application/json')
  }

  const signal = AbortSignal.timeout(args.timeoutMs ?? 30_000)

  if (route.upstreamAuth) {
    // Router-held-credential route (Mercury): no Tempo payment ever happens,
    // so no credential is signed and `paid` is unconditionally false — every
    // failure here is provably unpaid and releases.
    await consumeUpstreamRateLimit(env, route)
    const authed = injectUpstreamAuth(headers, route, env)
    const response = await fetch(merchantUrl, {
      method: route.method,
      headers: authed,
      body: payload,
      signal,
    })
    return { response, paid: false }
  }

  const init: RequestInit = { method: route.method, headers, body: payload, signal }

  // Every paid route must carry a ceiling. Refusing to call without one is
  // deliberate: a missing budget is a programming error, and defaulting to
  // "unlimited" is exactly the failure this guard exists to prevent.
  if (args.budgetAtomic === undefined) {
    throw new UpstreamError(
      'budget_not_set',
      500,
      `playground call to ${route.id} has no upstream budget`,
      'no',
    )
  }
  const maxAmountRaw = toTempoRaw6(args.budgetAtomic)

  // Call-local signing flag. Flipped true SYNCHRONOUSLY inside the seam's
  // onChallenge, the moment a credential is created for THIS request. Captured
  // in this closure so it is per-call and cannot be moved by a concurrent
  // call on the same route.
  let paid = false
  const onCredentialSigned = () => {
    paid = true
  }

  if (route.upstreamPaymentMethod === 'tempo.session') {
    // Mirrors proxy.ts:659. The channel is keyed by `route.id`; the cumulative
    // watermark is persisted by payMerchantSession's own onChannelUpdate hook
    // (see the module header for why we do not bump it a second time).
    try {
      const { response } = await payMerchantSession(env, route.id, merchantUrl, init, {
        maxAmountRaw,
        onCredentialSigned,
      })
      return { response, paid }
    } catch (e: any) {
      if (e instanceof ChannelNotInstalledError) {
        // Operator provisioning gap, not a caller mistake. No channel means no
        // voucher was ever signed — paid is false, provably unpaid.
        throw new UpstreamError('session_channel_not_installed', 503, e.message, 'no')
      }
      if (e instanceof BudgetExceededError) {
        // Refused inside onChallenge, before signing. paid is false.
        throw new UpstreamError('upstream_over_budget', 502, e.message, 'no')
      }
      // Any other failure: `paid` tells us exactly whether the voucher was
      // signed for this call before it blew up. No watermark read, no guess.
      throw new UpstreamError(
        'upstream_unreachable',
        502,
        e?.message ?? 'session upstream call failed',
        paid ? 'yes' : 'no',
      )
    }
  }

  // tempo.charge — the router pays this call out of its own pool.
  try {
    const response = await payMerchant(env, merchantUrl, init, { maxAmountRaw, onCredentialSigned })
    return { response, paid }
  } catch (e: any) {
    if (e instanceof BudgetExceededError) {
      throw new UpstreamError('upstream_over_budget', 502, e.message, 'no')
    }
    // `paid` disambiguates what would otherwise be a guess: false means mppx
    // died before answering any 402 (no credential signed); true means it
    // signed and submitted the transfer and the failure came after, so the
    // money may have moved.
    throw new UpstreamError(
      'upstream_unreachable',
      502,
      e?.message ?? 'upstream call failed',
      paid ? 'yes' : 'no',
    )
  }
}

/**
 * Call an upstream route and parse a JSON body, mapping every failure to an
 * `UpstreamError` so the route layer has exactly one thing to catch (and
 * therefore exactly one place that releases the ledger hold).
 *
 * Upstream error bodies are NOT echoed to the caller. For `upstreamAuth`
 * routes the request carried a router-held secret, and an upstream that echoes
 * request state in its errors would leak it; for the rest, an upstream error
 * body is merchant internals the playground has no reason to republish.
 */
export async function callUpstreamJson<T = unknown>(
  env: Env,
  args: Parameters<typeof callUpstream>[1],
): Promise<T> {
  let call: UpstreamCall
  try {
    call = await callUpstream(env, args)
  } catch (e: any) {
    // callUpstream already stamped the right evidence from its call-local
    // signing flag. Anything that is not an UpstreamError never dispatched.
    if (e instanceof UpstreamError) throw e
    throw new UpstreamError('upstream_unreachable', 502, e?.message ?? 'upstream call failed', 'no')
  }

  // A response-level failure (bad status, non-JSON) is settled by whether a
  // credential was actually signed for THIS call — NOT by "we got a response".
  // An initial non-402 500/404 returns a response with `paid === false`, and
  // that must release, not charge.
  const evidence: PaymentEvidence = call.paid ? 'yes' : 'no'

  if (!call.response.ok) {
    throw new UpstreamError(
      'upstream_error',
      502,
      `upstream ${args.route.id} returned ${call.response.status}`,
      evidence,
    )
  }
  try {
    return (await call.response.json()) as T
  } catch {
    throw new UpstreamError(
      'upstream_bad_body',
      502,
      `upstream ${args.route.id} returned non-JSON`,
      evidence,
    )
  }
}
