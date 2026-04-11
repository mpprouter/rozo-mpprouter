/**
 * POST /v1/services/:service/:operation — Core proxy handler.
 *
 * Flow:
 * 1. Agent sends request → forward to merchant → get 402 challenge
 * 2. Parse Tempo challenge to learn amount/recipient
 * 3. Feed request through the mppx Stellar charge handler:
 *    - No credential → mppx returns a signed 402 challenge for the agent
 *    - Credential    → mppx verifies HMAC + on-chain Soroban simulation
 *                      (the `OPTIMISTIC_THRESHOLD` env var is declared
 *                      but not wired up — see notes.md)
 * 4. On verified payment, pay the merchant on Tempo via the mppx client
 * 5. Return merchant content to the agent with a Payment-Receipt header
 */

import { Credential } from 'mppx'
import { getRouteByPublicPath } from '../services/merchants'
import {
  ChannelNotInstalledError,
  payMerchant,
  payMerchantSession,
} from '../mpp/tempo-client'
import { bumpCumulative } from '../mpp/channel-store'
import {
  createStellarPayment,
  getRouterStellarAddress,
  getStellarUsdcSac,
} from '../mpp/stellar-server'
import {
  resolveStellarChannelMppx,
  StellarChannelNotRegisteredError,
} from '../mpp/stellar-channel-dispatch'
import type { Env } from '../index'

/**
 * Resolve a public Router URL to an internal upstream route.
 */
function resolveRoute(url: URL, method: string) {
  return getRouteByPublicPath(url.pathname, method)
}

/**
 * Build the full merchant URL from the internal route mapping.
 */
function buildMerchantUrl(merchantHost: string, upstreamPath: string, search: string): string {
  return `https://${merchantHost}${upstreamPath}${search}`
}

/**
 * Forward headers from agent to merchant.
 *
 * By default the agent's Authorization header is stripped — the router
 * replaces it with a Tempo credential minted from the router's own wallet
 * when paying the merchant. In transparent-passthrough mode (for non-
 * Stellar credentials) we keep Authorization so the merchant sees the
 * agent's original auth exactly as sent.
 */
function forwardHeaders(
  request: Request,
  opts: { keepAuthorization?: boolean } = {},
): HeadersInit {
  const headers: Record<string, string> = {}
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase()
    if (lower === 'host') continue
    if (lower === 'authorization' && !opts.keepAuthorization) continue
    headers[key] = value
  }
  return headers
}

/**
 * Inspect an Authorization header and decide how the router should
 * treat the credential.
 *
 * Returns:
 *   - 'stellar.charge'  → agent presented a Stellar MPP credential
 *                         with intent="charge" (V1, single-shot USDC
 *                         payment). Run the charge verify path and
 *                         pay the Tempo merchant on the agent's
 *                         behalf.
 *   - 'stellar.channel' → agent presented a Stellar MPP credential
 *                         with intent="channel" (V2 §6, long-lived
 *                         payment channel voucher). Run the channel
 *                         dispatch path which looks up the
 *                         channel's sidecar metadata in KV and
 *                         builds a per-request Mppx instance.
 *   - 'passthrough'     → anything else — non-Stellar MPP, Bearer,
 *                         Basic, EVM x402, SIWX, unrelated Payment
 *                         schemes. Forward untouched; the router
 *                         does not settle these.
 *   - 'none'            → no Authorization header. Fall through to
 *                         the default Stellar 402 challenge flow so
 *                         naive Stellar agents learn what to pay.
 *
 * History: V1 returned just `'stellar'` without distinguishing
 * intent. V2 splits `'stellar'` into `'stellar.charge'` vs
 * `'stellar.channel'` so the proxy can route each to the right
 * verify handler. Critically, both intents carry
 * `challenge.method === "stellar"`, so the intent field is the
 * ONLY way to tell them apart from the credential wire format.
 *
 * IMPORTANT: a pre-V1 draft of this function parsed the header as
 * if it contained RFC 9110 auth-params (`Payment id="...",
 * method="stellar", ...`). That is the `WWW-Authenticate`
 * serialization format, not the `Authorization` format. Real mppx
 * Credentials are serialized as a single base64url-encoded JSON
 * blob after the `Payment ` prefix — see
 * mppx/src/Credential.ts:131. Always parse with
 * `Credential.deserialize()` — mppx owns the wire format.
 */
type AuthKind = 'stellar.charge' | 'stellar.channel' | 'passthrough' | 'none'

function classifyAuth(authHeader: string | null): AuthKind {
  if (!authHeader) return 'none'
  const trimmed = authHeader.trim()
  // Payment scheme uses the MPP "Payment" prefix. Anything else is
  // definitely not a Stellar MPP credential — forward untouched.
  if (!/^Payment\s+/i.test(trimmed)) return 'passthrough'
  // Try to parse as a real mppx Credential. If it parses, the nested
  // `challenge.method` field tells us the payment method unambiguously
  // and `challenge.intent` tells us whether it's charge or channel.
  // If it doesn't parse, it's some non-mppx `Payment ...` scheme that
  // happens to share the prefix (e.g. an unrelated x402 dialect) — hand
  // it back to the merchant to interpret.
  try {
    const credential = Credential.deserialize(trimmed) as {
      challenge?: { method?: string; intent?: string }
    }
    const method = credential.challenge?.method?.toLowerCase()
    if (method !== 'stellar') return 'passthrough'
    const intent = credential.challenge?.intent?.toLowerCase()
    if (intent === 'channel') return 'stellar.channel'
    // Default for stellar.* credentials is charge. This matches V1
    // behavior: any stellar credential without an explicit
    // 'channel' intent takes the charge path. New intents added by
    // future mppx versions will need explicit cases here.
    return 'stellar.charge'
  } catch {
    return 'passthrough'
  }
}

/**
 * Stellar USDC has 7 decimals. Any merchant currency with more than 7
 * decimals cannot be represented losslessly on the Stellar side, so we
 * refuse to charge the agent rather than silently truncating.
 */
const STELLAR_USDC_DECIMALS = 7

/**
 * TIP-20 stablecoins on Tempo (pathUSD, USDC) are hard-coded at 6
 * decimals — see node_modules/mppx/dist/tempo/internal/defaults.js.
 * Merchants drop `decimals` from the wire format via a zod transform,
 * so we have to assume this value unless the challenge explicitly
 * overrides it. Revisit before adding non-Tempo upstreams. See notes.md.
 */
const TEMPO_DEFAULT_DECIMALS = 6

/**
 * Convert a base-unit integer amount (as a string) into a human-readable
 * decimal string. Uses BigInt so there is no floating-point error.
 *
 * Examples:
 *   baseUnitsToDecimalString("10000", 6)     === "0.01"
 *   baseUnitsToDecimalString("1000000", 6)   === "1"
 *   baseUnitsToDecimalString("1234567", 6)   === "1.234567"
 *   baseUnitsToDecimalString("1", 6)         === "0.000001"
 *   baseUnitsToDecimalString("0", 6)         === "0"
 *
 * Trailing zeros in the fractional part are stripped; a pure-integer
 * result loses its decimal point entirely. This matches what the Stellar
 * charge method's toBaseUnits() expects on the way back in.
 */
export function baseUnitsToDecimalString(amount: string, decimals: number): string {
  if (!/^-?\d+$/.test(amount)) {
    throw new Error(`baseUnitsToDecimalString: amount must be integer string, got ${amount}`)
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`baseUnitsToDecimalString: decimals must be non-negative integer, got ${decimals}`)
  }
  const negative = amount.startsWith('-')
  const digits = negative ? amount.slice(1) : amount
  if (decimals === 0) return negative ? `-${digits}` : digits
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '')
  const body = frac.length === 0 ? whole : `${whole}.${frac}`
  return negative ? `-${body}` : body
}

/**
 * Parse a Tempo WWW-Authenticate header into its fields.
 *
 * Format: Payment id="...", realm="...", method="tempo", intent="charge",
 *         request="base64", expires="..."
 * The request is base64url-encoded JSON: { amount, currency, recipient,
 * decimals, ... }
 *
 * Critical: Tempo emits `amount` in token base units (integer) together
 * with a `decimals` field describing the token's decimal precision. The
 * Stellar charge method, in contrast, expects `amount` as a human-readable
 * decimal string and applies its own `toBaseUnits(amount, 7)` internally.
 * Callers must convert between the two before forwarding — see
 * baseUnitsToDecimalString above. Dropping `decimals` here was the source
 * of the 1,000,000x overcharge bug.
 */
function parseTempoChallenge(wwwAuth: string): {
  id: string
  realm: string
  intent: string
  request: { amount: string; currency: string; recipient: string; decimals?: number; [key: string]: any }
  expires?: string
} | null {
  try {
    const idMatch = wwwAuth.match(/id="([^"]+)"/)
    const realmMatch = wwwAuth.match(/realm="([^"]+)"/)
    const intentMatch = wwwAuth.match(/intent="([^"]+)"/)
    const requestMatch = wwwAuth.match(/request="([^"]+)"/)
    const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)

    if (!idMatch || !requestMatch) return null

    // Decode base64url request
    const requestJson = atob(requestMatch[1].replace(/-/g, '+').replace(/_/g, '/'))
    const request = JSON.parse(requestJson)

    return {
      id: idMatch[1],
      realm: realmMatch?.[1] || '',
      intent: intentMatch?.[1] || 'charge',
      request,
      expires: expiresMatch?.[1],
    }
  } catch {
    return null
  }
}

export async function handleProxy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url)

  const route = resolveRoute(url, request.method)
  if (!route) {
    return new Response(JSON.stringify({
      error: 'Unknown public service route',
      hint: 'Use GET /v1/services/catalog for the list of supported public routes',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const merchantHost = route.upstreamHost
  const upstreamPath = route.upstreamPath
  const merchantUrl = buildMerchantUrl(merchantHost, upstreamPath, url.search)

  // Idempotency check — return cached result on repeat POSTs with same id.
  const requestId = request.headers.get('x-request-id')
  if (requestId) {
    const cached = await env.MPP_STORE.get(`idempotency:${requestId}`)
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Idempotent': 'true' },
      })
    }
  }

  // Read the body once; we may need to send it twice (merchant 402 probe + real paid call).
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const requestBody = hasBody ? await request.text() : undefined

  // 0. Wallet-type gate. Router only represents Stellar wallets. If the
  // agent sent any other kind of Authorization header (Bearer, Basic,
  // EVM x402, SIWX, Solana MPP, …) the merchant decides how to handle
  // it — the router does not spend from the Tempo pool on their behalf.
  //
  // This closes the replay-amplification attack surface by construction:
  // router only funds merchant calls that came with a Stellar credential
  // the router itself issued via mppx. Any other credential type is
  // forwarded as-is and whatever economic exchange happens is between
  // the agent and the merchant.
  const authHeader = request.headers.get('authorization')
  const rawAuthKind = classifyAuth(authHeader)

  // V2 §6-D2 query-param bootstrap: agents that want the stellar.channel
  // flow on their FIRST request (before any credential has been signed)
  // advertise their intent by passing `?payment=channel&agent=G...` in
  // the URL. We upgrade authKind from 'none' to 'stellar.channel' when
  // we see this pair, so the verify dispatch below builds a channel-
  // bound Mppx for the initial 402.
  //
  // This is strictly additive: requests without the hint stay on the
  // V1 charge path (including the working stellar.charge → tempo.session
  // bridge from commit 9dbaba1). Requests with the hint but a wrong G
  // get a clean 402 via StellarChannelNotRegisteredError. There is no
  // silent mode switch.
  const paymentHint = url.searchParams.get('payment')?.toLowerCase() ?? null
  const agentHint = url.searchParams.get('agent')
  let authKind: typeof rawAuthKind = rawAuthKind
  if (authKind === 'none' && paymentHint === 'channel' && agentHint) {
    authKind = 'stellar.channel'
  }

  if (authKind === 'passthrough') {
    console.log(`[proxy] Non-Stellar credential — transparent passthrough to ${merchantHost}`)
    const passthroughResponse = await fetch(merchantUrl, {
      method: request.method,
      headers: forwardHeaders(request, { keepAuthorization: true }),
      body: requestBody,
    })
    return passthroughResponse
  }

  // 1. Probe the merchant to learn the live quote. If the merchant
  // serves content for free, pass that through directly.
  const probeResponse = await fetch(merchantUrl, {
    method: request.method,
    headers: forwardHeaders(request),
    body: requestBody,
  })

  if (probeResponse.status !== 402) {
    // Merchant doesn't require payment for this route — passthrough.
    return probeResponse
  }

  const wwwAuth = probeResponse.headers.get('www-authenticate')
  if (!wwwAuth) {
    return new Response(JSON.stringify({
      error: 'Merchant returned 402 without WWW-Authenticate header',
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const parsed = parseTempoChallenge(wwwAuth)
  if (!parsed) {
    return new Response(JSON.stringify({
      error: 'Could not parse merchant challenge',
      raw: wwwAuth,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 2. Run the request through the Stellar mppx handler. This is the
  // critical verification step: without a valid, HMAC-bound credential
  // whose echoed challenge matches the same amount/currency/recipient
  // (charge) or channel (channel), mppx returns a 402 challenge here
  // and we never reach payMerchant.
  //
  // Dispatch branches on authKind:
  //   - 'stellar.charge' / 'none': use the shared-instance charge Mppx
  //     from createStellarPayment(env). This is the V1 path, unchanged.
  //   - 'stellar.channel': use a per-request Mppx from
  //     resolveStellarChannelMppx() which reads the channel metadata
  //     from KV (`stellarChannel:<contract>`) and constructs a fresh
  //     Mppx instance bound to that specific channel + its
  //     commitmentKey. See src/mpp/stellar-channel-dispatch.ts and
  //     internaldocs/v2-stellar-channel-notes.md §N2.
  let mppx: Awaited<ReturnType<typeof resolveStellarChannelMppx>>['mppx']
  let channelContractForVerify: string | undefined
  try {
    if (authKind === 'stellar.channel') {
      // Pass agentHint so the first-request bootstrap path can
      // resolve the agent's channel without a credential yet.
      // Once the agent signs a voucher on the retry, the
      // credential.source extraction will produce the same G
      // and we'll converge on the same channel.
      const resolved = await resolveStellarChannelMppx(env, authHeader, agentHint)
      mppx = resolved.mppx as any
      channelContractForVerify = resolved.channelContract
      console.log(
        `[proxy] Stellar channel dispatch for ${resolved.channelContract} (agent=${resolved.agentAccount})`,
      )
    } else {
      mppx = createStellarPayment(env) as any
    }
  } catch (err: any) {
    if (err instanceof StellarChannelNotRegisteredError) {
      // Agent is unknown to the router — either they never
      // deployed a channel, or the operator never registered
      // it. 402 with a pointer to the register script, not 500:
      // the request is well-formed and we want the operator to
      // notice quickly.
      console.error(`[proxy] ${err.message}`)
      return new Response(
        JSON.stringify({
          error: 'Router does not recognize this agent',
          detail: err.message,
          hint: 'Deploy a Stellar channel contract and run scripts/admin/register-stellar-channel.ts before first use.',
        }),
        {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }
    console.error(`[proxy] Failed to initialize Stellar payment handler: ${err.message}`)
    return new Response(JSON.stringify({
      error: 'Router payment handler misconfigured',
      detail: err.message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Rebuild a Request clone that mppx can read (it calls request.headers /
  // url on the input). Body isn't needed by the charge verifier, but we
  // forward a fresh one so consumers of the input see the original.
  const mppxInput = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? requestBody : undefined,
  })

  // Convert the merchant's base-unit amount into a decimal string for
  // the Stellar charge method.
  //
  // Tempo TIP-20 tokens (pathUSD, USDC) are hard-coded at 6 decimals on
  // the Tempo side — see node_modules/mppx/dist/tempo/internal/defaults.js
  // which exports `decimals = 6` with the comment "All TIP-20 tokens on
  // Tempo use 6 decimals, so there is no risk of mismatch." The merchant's
  // wire format drops `decimals` during the zod transform in mppx's
  // tempo.charge method, so the 402 challenge arrives with a base-unit
  // integer amount but no explicit decimals field.
  //
  // We therefore assume TEMPO_DEFAULT_DECIMALS unless the challenge
  // overrides it. If we ever start routing merchants on a chain where
  // stablecoins use different precision (e.g. BNB Chain ERC-20 USDT/USDC
  // use 18 decimals), this assumption MUST be revisited — see notes.md.
  const merchantDecimals = typeof parsed.request.decimals === 'number'
    ? parsed.request.decimals
    : TEMPO_DEFAULT_DECIMALS
  if (!Number.isInteger(merchantDecimals) || merchantDecimals < 0) {
    return new Response(JSON.stringify({
      error: 'Merchant challenge carried an invalid decimals field',
      raw: parsed.request,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (merchantDecimals > STELLAR_USDC_DECIMALS) {
    return new Response(JSON.stringify({
      error: 'Merchant token precision exceeds Stellar USDC',
      detail: `merchant decimals=${merchantDecimals}, stellar=${STELLAR_USDC_DECIMALS}. ` +
        `See notes.md for chains that need explicit handling (e.g. BNB Chain ERC-20 = 18 decimals).`,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  let stellarAmount: string
  try {
    stellarAmount = baseUnitsToDecimalString(parsed.request.amount, merchantDecimals)
  } catch (err: any) {
    return new Response(JSON.stringify({
      error: 'Could not normalize merchant amount',
      detail: err.message,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Dispatch the actual verify on authKind. Both the charge and the
  // channel paths are HMAC-bound challenge verifications that return
  // a Method.Server output with `.status`, `.challenge`, and
  // `.withReceipt`, so downstream code can treat them uniformly.
  //
  // The shape of the arguments differs slightly:
  //   - charge:  { amount, currency, recipient, meta }
  //   - channel: { amount, channel, methodDetails }
  // The channel path doesn't take currency + recipient because those
  // are baked into the on-chain channel contract at deploy time.
  let verifyResult
  try {
    if (authKind === 'stellar.channel') {
      // Should not happen — if we got to this branch, resolve already
      // set channelContractForVerify. Defensive check for the type
      // narrowing below.
      if (!channelContractForVerify) {
        throw new Error('Internal: stellar.channel authKind without resolved contract')
      }
      verifyResult = await (mppx as any)['stellar/channel']({
        amount: stellarAmount,
        channel: channelContractForVerify,
        methodDetails: {
          reference: parsed.id,
        },
      })(mppxInput)
    } else {
      verifyResult = await (mppx as any)['stellar/charge']({
        amount: stellarAmount,
        currency: getStellarUsdcSac(env),
        recipient: getRouterStellarAddress(env),
        // Correlate the mppx challenge with the upstream merchant challenge
        // so we can reconcile payments after the fact.
        meta: {
          upstreamChallengeId: parsed.id,
          route: route.id,
        },
      })(mppxInput)
    }
  } catch (err: any) {
    console.error(`[proxy] Stellar verify threw: ${err.message}`)
    return new Response(JSON.stringify({
      error: 'Payment verification failed',
      detail: err.message,
    }), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (verifyResult.status === 402) {
    // Either no credential was presented, or it failed verification —
    // including replay attempts. The stellar charge method inside mppx
    // uses the shared KV store (see src/mpp/stellar-server.ts) to
    // reject any credential whose challenge id (and, for push mode, tx
    // hash) has already been settled. Replay protection is enforced
    // here, not via a counter, so we do not need an extra guard.
    //
    // NOTE: Cloudflare KV is eventually consistent, so two concurrent
    // replays *can* race past the dedup check within a narrow window.
    // For strict once-and-only-once semantics, migrate MPP_STORE to a
    // Durable Object. For now, the mppx store is the authoritative
    // replay guard and the window is small enough that the economic
    // loss is bounded to a single concurrent duplicate.
    return verifyResult.challenge
  }

  console.log(`[proxy] Stellar payment verified for route ${route.id}`)

  // 4. Pay the merchant from the Tempo pool.
  //
  // Dispatch on the merchant's upstream payment method. Fixed-price
  // merchants (Firecrawl, Exa, Parallel) go through `tempo.charge` —
  // a single-shot 402 settle per request. Dynamic-price merchants
  // (OpenRouter) go through `tempo.session` — a long-lived payment
  // channel with streaming cumulative vouchers. The mppx client
  // handles the full 402 dance in both cases; the difference is
  // that the session path needs to read + write channel state in
  // KV and enforce the commit-after-2xx ordering from §5 of
  // internaldocs/session-support-plan.md.
  //
  // IMPORTANT: an `upstreamPaymentMethod` of `tempo.session` on a
  // merchant whose KV channel has not been opened yet raises
  // `ChannelNotInstalledError`. We surface that as a 503 with a
  // clear message so the operator notices and runs
  // `scripts/open-channel.ts` before agent traffic builds up.
  let merchantResponse: Response
  try {
    if (route.upstreamPaymentMethod === 'tempo.session') {
      const sessionResult = await payMerchantSession(env, route.id, merchantUrl, {
        method: request.method,
        headers: forwardHeaders(request),
        body: requestBody,
      })
      merchantResponse = sessionResult.response
      // §5 Rule 2: bump KV cumulative ONLY after a 2xx upstream
      // response. The `onChannelUpdate` callback inside
      // payMerchantSession also bumps KV as a safety net — the
      // monotone max() in bumpCumulative makes the second write
      // idempotent, so double-bumping is a no-op, and the explicit
      // post-2xx bump here is the authoritative commit point.
      //
      // On non-2xx we intentionally do NOT call bumpCumulative
      // from the proxy side, but if mppx already fired
      // onChannelUpdate during sign then KV may already be ahead.
      // That's an accepted residual window — see the
      // "Residual window" note in §5.
      if (merchantResponse.ok) {
        const newCumulativeRaw = (
          BigInt(sessionResult.channelBefore.cumulativeRaw) +
          BigInt(parsed.request.amount)
        ).toString()
        // Fire-and-forget: if the bump fails (e.g. KV throttling),
        // onChannelUpdate has almost certainly already done the
        // same write and the next request will read the right
        // high watermark anyway. Don't fail the agent's response
        // over a bookkeeping miss.
        ctx.waitUntil(
          bumpCumulative(env, route.id, newCumulativeRaw).catch((err: any) => {
            console.error(
              `[proxy] post-2xx bumpCumulative failed for ${route.id}: ${err.message}`,
            )
          }),
        )
      }
    } else {
      merchantResponse = await payMerchant(env, merchantUrl, {
        method: request.method,
        headers: forwardHeaders(request),
        body: requestBody,
      })
    }
  } catch (err: any) {
    if (err instanceof ChannelNotInstalledError) {
      console.error(`[proxy] ${err.message}`)
      return new Response(
        JSON.stringify({
          error: 'Router session channel not installed',
          detail: err.message,
          hint: 'Operator must run scripts/open-channel.ts before this merchant accepts session traffic.',
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }
    console.error(`[proxy] Tempo payment error: ${err.message}`)
    return new Response(JSON.stringify({
      error: 'Merchant payment failed',
      detail: err.message,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  console.log(`[proxy] Merchant responded: ${merchantResponse.status}`)

  if (!merchantResponse.ok) {
    const errorBody = await merchantResponse.text()
    console.error(`[proxy] Merchant error body: ${errorBody.substring(0, 200)}`)
    return new Response(JSON.stringify({
      error: 'Merchant payment failed',
      status: merchantResponse.status,
      detail: errorBody.substring(0, 500),
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 5. Return merchant content to the agent with a Payment-Receipt header.
  const contentType = merchantResponse.headers.get('content-type') || 'application/json'
  const body = await merchantResponse.text()

  // Async tasks: broadcast Stellar tx (handled by mppx store), log, cache idempotency
  ctx.waitUntil((async () => {
    console.log(
      `[payment] route=${route.id} merchant=${merchantHost} upstreamPath=${upstreamPath}`,
    )
    if (requestId) {
      await env.MPP_STORE.put(`idempotency:${requestId}`, body, { expirationTtl: 86400 })
    }
  })())

  const merchantContent = new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType },
  })
  return verifyResult.withReceipt(merchantContent)
}
