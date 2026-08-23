import type { Env } from '../index'
import { handleProxy } from './proxy'

export interface FacadeModel {
  id: string
  provider: 'groq' | 'deepseek'
  route: string
  available: boolean
  unavailableReason?: string
}

export const FACADE_MODELS: readonly FacadeModel[] = [
  {
    id: 'llama-3.1-8b-instant', provider: 'groq', route: '/v1/services/groq/chat', available: false,
    unavailableReason: 'Paid re-probe on 2026-08-24 returned model_not_found after payment.',
  },
  { id: 'deepseek-v4-flash', provider: 'deepseek', route: '/v1/services/deepseek/chat', available: true },
]

const AVAILABLE_MODELS = FACADE_MODELS.filter(model => model.available)
const MODEL_BY_ID = new Map(AVAILABLE_MODELS.map(model => [model.id, model]))

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

export type FacadeRequestStatus = 'settled' | 'passthrough' | 'failed' | 'fallback_used' | 'delivered_unsettled'

export function classifyFacadeStatus(
  response: Response,
  quote: string | null,
  fallbackReason: string | null,
): FacadeRequestStatus {
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
  const quote = response.headers.get('X-MPPRouter-Quoted-Amount')
  const upstreamCost = response.headers.get('X-MPPRouter-Upstream-Cost')
  const settlementRef = response.headers.get('X-Payment-Tx')
    ?? response.headers.get('Payment-Receipt')
  const payer = response.headers.get('X-MPPRouter-Payer')
  const eventId = crypto.randomUUID()
  const status = classifyFacadeStatus(response, quote, fallbackReason)
  const reconciliationStatus = status === 'delivered_unsettled'
    ? 'manual_review'
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
      JSON.stringify({ quoted_amount_usd: quote }),
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
    return jsonError(400, `Unknown model. Supported models: ${AVAILABLE_MODELS.map(model => model.id).join(', ')}`, 'model_not_found')
  }

  const requestedModel = MODEL_BY_ID.get(body.model)!
  const requestId = request.headers.get('X-Request-Id') || crypto.randomUUID()
  let response = await handleProxy(proxiedRequest(request, body, requestedModel.route, requestId), env, ctx)
  let actualModel = requestedModel
  let fallbackReason: string | null = null

  // A 402 is the normal payment handshake, never a provider failure. Only a
  // terminal upstream failure is eligible for fallback; handleProxy has
  // already queued/marked the refund when the first payment settled.
  const fallback = AVAILABLE_MODELS.find(model => model.id !== requestedModel.id)
  if (response.status >= 500 && fallback) {
    actualModel = fallback
    fallbackReason = `primary_${requestedModel.provider}_http_${response.status}`
    response = await handleProxy(
      proxiedRequest(request, { ...body, model: actualModel.id }, actualModel.route, requestId),
      env,
      ctx,
    )
  }

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
