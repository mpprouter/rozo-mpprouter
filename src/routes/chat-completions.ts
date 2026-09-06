import type { Env } from '../index'
import { handleProxy } from './proxy'
import { PUBLIC_SERVICE_ROUTES } from '../services/merchants'

export interface FacadeModel {
  id: string
  /** Catalog `service` of the route serving this model (e.g. 'groq'). */
  provider: string
  /** Public router path the facade re-dispatches to. */
  route: string
  available: boolean
  unavailableReason?: string
}

/**
 * The facade's model list is DERIVED from the public route table rather than
 * hardcoded here (2026-08-24). A route opts in by carrying a `facade.models`
 * entry in the operator overlay (`merchants.ts → OPERATOR_OVERLAY`), which is
 * the same per-route-capability pattern already used by `upstreamAuth`,
 * `fixedPricing`, `rateLimit` and `launchGate`.
 *
 * Two consequences worth stating, since both are load-bearing:
 *
 *  - A delisted route (`verifiedMode: false`) drops out of the facade
 *    automatically. Before this, delisting a route in the catalog would have
 *    left the facade happily selling it, because the model list was a literal
 *    that nothing kept in sync with the catalog.
 *  - Registration is opt-in, not "every OpenAI-shaped route". The anthropic
 *    chat_completions route is OpenAI-shaped AND charge-verified, but it is
 *    deliberately kept payable as the live refund demo and never returns a
 *    completion, so it must not appear behind the front door we tell people
 *    to point an OpenAI SDK at.
 */
function buildFacadeModels(): FacadeModel[] {
  const models: FacadeModel[] = []
  for (const route of PUBLIC_SERVICE_ROUTES) {
    if (!route.facade || route.verifiedMode === false) continue
    for (const model of route.facade.models) {
      models.push({
        id: model.id,
        provider: route.service,
        route: route.publicPath,
        available: model.available,
        unavailableReason: model.unavailableReason,
      })
    }
  }
  return models
}

export const FACADE_MODELS: readonly FacadeModel[] = buildFacadeModels()

const AVAILABLE_MODELS = FACADE_MODELS.filter(model => model.available)
const MODEL_BY_ID = new Map(AVAILABLE_MODELS.map(model => [model.id, model]))
const UNAVAILABLE_BY_ID = new Map(
  FACADE_MODELS.filter(model => !model.available).map(model => [model.id, model]),
)

function jsonError(status: number, message: string, code: string): Response {
  return new Response(JSON.stringify({
    error: { message, type: 'invalid_request_error', param: code === 'model_not_found' ? 'model' : 'stream', code },
  }), { status, headers: { 'Content-Type': 'application/json' } })
}

function proxiedRequest(request: Request, body: Record<string, unknown>, route: string, requestId: string): Request {
  const url = new URL(request.url)
  url.pathname = route
  const headers = new Headers(request.headers)
  const authorization = headers.get('Authorization')
  if (authorization && !/^Payment\s+/i.test(authorization)) headers.delete('Authorization')
  headers.set('X-Request-Id', requestId)
  return new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function usageNumber(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function extractUsage(payload: unknown): { input: number | null; output: number | null; cached: number | null } {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const usage = root.usage && typeof root.usage === 'object' ? root.usage as Record<string, unknown> : {}
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details as Record<string, unknown> : {}
  return {
    input: usageNumber(usage.prompt_tokens ?? usage.input_tokens),
    output: usageNumber(usage.completion_tokens ?? usage.output_tokens),
    cached: usageNumber(details.cached_tokens ?? usage.cached_tokens),
  }
}

/**
 * Did the merchant run a DIFFERENT model than the one we dispatched?
 *
 * A bare string comparison is too eager. Providers routinely answer a rolling
 * alias with the pinned build behind it — anthropic answers `claude-haiku-4-5`
 * with `claude-haiku-4-5-20251001` (observed on a paid call 2026-08-24). That
 * is the same model, and flagging it would bury the case this exists for:
 * grok answering `grok-3-mini` with `grok-4.3`, a different model entirely.
 *
 * So a served id that extends the requested one with something that LOOKS
 * LIKE A VERSION -- a separator followed by a number or a `v` and a number --
 * is a pin. "Any separator-delimited suffix" is too generous: `sonar` ->
 * `sonar-pro` would pass, and that is a different and dearer model, exactly
 * the case worth catching.
 */
const VERSION_PIN_SUFFIX = /^[-_.@:]v?\d[\w.-]*$/

export function isModelSubstitution(dispatched: string, served: string | null): boolean | null {
  if (served === null) return null
  if (served === dispatched) return false
  if (!served.startsWith(dispatched)) return true
  return !VERSION_PIN_SUFFIX.test(served.slice(dispatched.length))
}

export type FacadeRequestStatus = 'settled' | 'passthrough' | 'failed' | 'fallback_used' | 'delivered_unsettled'

export function classifyFacadeStatus(
  response: Response,
  quote: string | null,
  fallbackReason: string | null,
): FacadeRequestStatus {
  const refundStatus = response.headers.get('Refund-Status')
  if (refundStatus === 'manual-review') return 'failed'
  if (refundStatus === 'pending') return 'failed'
  if (!response.ok) return 'failed'
  if (response.headers.get('X-Payment-Settle-Status') === 'failed') return 'delivered_unsettled'
  if (quote === null) return 'passthrough'
  if (fallbackReason) return 'fallback_used'
  return 'settled'
}

async function recordUsage(
  env: Env,
  requestId: string,
  requestedModel: string,
  actualModel: FacadeModel,
  response: Response,
  fallbackReason: string | null,
): Promise<void> {
  if (!env.COUPON_SECURITY_DB) return
  let payload: unknown = null
  try { payload = await response.clone().json() } catch { /* usage remains unknown */ }
  const usage = extractUsage(payload)
  // What the MERCHANT says it ran, which is not always what we asked for:
  // grok's merchant accepts `grok-3-mini` and serves grok-4.3 (paid probes
  // 2026-08-24). `actual_model` cannot carry this — it is the model this
  // router dispatched to, paired with `fallback_reason`. Recording the
  // merchant's own answer means a substitution is findable with a query
  // instead of by reading a response body by hand, which is how the grok one
  // was caught.
  const servedModel = payload && typeof payload === 'object'
    && typeof (payload as Record<string, unknown>).model === 'string'
    ? (payload as Record<string, unknown>).model as string
    : null
  const quote = response.headers.get('X-MPPRouter-Quoted-Amount')
  const upstreamCost = response.headers.get('X-MPPRouter-Upstream-Cost')
  const settlementRef = response.headers.get('X-Payment-Tx')
    ?? response.headers.get('Payment-Receipt')
  const payer = response.headers.get('X-MPPRouter-Payer')
  // 'stellar.x402' | 'stellar.charge' | 'stellar.channel', set by the proxy on
  // every settled response. Kept in charge_evidence_json so /v1/me/ledger can
  // report the payment mode without guessing from the settlement reference.
  const paymentMethod = response.headers.get('X-Payment-Method')
  const eventId = crypto.randomUUID()
  const status = classifyFacadeStatus(response, quote, fallbackReason)
  const refundStatus = response.headers.get('Refund-Status')
  const refundId = response.headers.get('Refund-Id')
  const reconciliationStatus = status === 'delivered_unsettled' || refundStatus === 'manual-review'
    ? 'manual_review'
    : refundStatus === 'pending' ? 'refund_pending'
    : refundStatus === 'voucher-not-consumed' ? 'not_charged'
    : settlementRef ? 'authoritative' : 'pending'
  try {
    await env.COUPON_SECURITY_DB.prepare(`
      INSERT INTO llm_facade_requests (
        event_id, request_id, created_at, wallet_address, requested_model, actual_model, provider,
        fallback_reason, input_tokens, output_tokens, cached_tokens,
        quoted_amount_usd, upstream_cost_usd, settlement_ref, status,
        charge_evidence_json, authoritative_receipt_json,
        reconciliation_status, reconciliation_attempts, reconciliation_last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      ON CONFLICT(event_id) DO NOTHING
    `).bind(
      eventId, requestId, Date.now(), payer, requestedModel, actualModel.id, actualModel.provider,
      fallbackReason, usage.input, usage.output, usage.cached,
      quote, upstreamCost, settlementRef,
      status,
      JSON.stringify({
        quoted_amount_usd: quote,
        refund_id: refundId,
        refund_status: refundStatus,
        served_model: servedModel,
        payment_method: paymentMethod,
        // Precomputed rather than derived at query time so a substitution is
        // one `json_extract(charge_evidence_json, '$.model_substituted')`
        // away. Null when the merchant reported no model at all.
        model_substituted: isModelSubstitution(actualModel.id, servedModel),
      }),
      settlementRef ? JSON.stringify({ settlement_ref: settlementRef }) : null,
      reconciliationStatus,
    ).run()
  } catch (error) {
    console.error(JSON.stringify({ event: 'llm_facade_usage_write_failed', request_id: requestId, error: String(error) }))
  }
}

export function handleModels(): Response {
  return new Response(JSON.stringify({
    object: 'list',
    data: AVAILABLE_MODELS.map(model => ({ id: model.id, object: 'model', created: 0, owned_by: model.provider })),
  }), { headers: { 'Content-Type': 'application/json' } })
}

export async function handleChatCompletions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'Method not allowed', type: 'invalid_request_error' } }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'POST' },
    })
  }

  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    body = parsed as Record<string, unknown>
  } catch {
    return jsonError(400, 'Request body must be valid JSON object.', 'invalid_json')
  }
  if (body.stream === true) {
    return jsonError(400, 'Streaming is not supported yet; set stream to false.', 'stream_not_supported')
  }
  if (typeof body.model !== 'string' || !MODEL_BY_ID.has(body.model)) {
    // A model that is registered but unavailable carries an operator note
    // saying WHY, and often which id to use instead. Surfacing it turns an
    // opaque "unknown model" into an actionable one — the caller is being
    // rejected before paying, which is the moment that note is worth most.
    const known = typeof body.model === 'string' ? UNAVAILABLE_BY_ID.get(body.model) : undefined
    const reason = known?.unavailableReason
      ? `Model ${known.id} is currently unavailable. ${known.unavailableReason} `
      : 'Unknown model. '
    return jsonError(400, `${reason}Supported models: ${AVAILABLE_MODELS.map(model => model.id).join(', ')}`, 'model_not_found')
  }

  const requestedModel = MODEL_BY_ID.get(body.model)!
  const requestId = request.headers.get('X-Request-Id') || crypto.randomUUID()
  let response = await handleProxy(proxiedRequest(request, body, requestedModel.route, requestId), env, ctx)
  const actualModel = requestedModel
  const fallbackReason: string | null = null

  // Never replay a payment credential to another paid route. Once the first
  // leg settles, its refund/receipt must reach the caller intact. A future
  // fallback design needs a separate payment handshake and one ledger row per
  // leg; until then the safe behavior is to return the primary result.

  // Locus merchants wrap successful OpenAI responses as
  // { success: true, data: <OpenAI response> }. The facade contract is the
  // OpenAI shape itself, so unwrap only that positively identified envelope.
  if (response.ok && response.headers.get('Content-Type')?.includes('application/json')) {
    try {
      const envelope = await response.clone().json() as Record<string, unknown>
      if (envelope.success === true && envelope.data && typeof envelope.data === 'object') {
        response = new Response(JSON.stringify(envelope.data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
    } catch { /* preserve non-JSON merchant body verbatim */ }
  }

  const headers = new Headers(response.headers)
  headers.set('X-MPPRouter-Request-Id', requestId)
  headers.set('X-MPPRouter-Provider', actualModel.provider)
  headers.set('X-MPPRouter-Model', actualModel.id)
  if (fallbackReason) headers.set('X-MPPRouter-Fallback-Reason', fallbackReason)
  const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  if (result.status !== 402) ctx.waitUntil(recordUsage(env, requestId, requestedModel.id, actualModel, result, fallbackReason))
  return result
}
