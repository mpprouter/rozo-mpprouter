import type { Env } from '../index'

type PayInvoiceRequest =
  | { url: string; payment_id?: never }
  | { payment_id: string; url?: never }

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function normalizeBody(input: unknown): PayInvoiceRequest | null {
  if (!input || typeof input !== 'object') return null
  const body = input as Record<string, unknown>
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  const paymentId = typeof body.payment_id === 'string' ? body.payment_id.trim() : ''

  if (url && !paymentId) return { url }
  if (paymentId && !url) return { payment_id: paymentId }
  return null
}

export async function handleAdminPayInvoice(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  if (!env.PAYINVOICE_ADMIN_SECRET) {
    return json(500, { error: 'PAYINVOICE_ADMIN_SECRET is not configured' })
  }

  const callerSecret = request.headers.get('x-admin-secret')?.trim()
  if (!callerSecret || callerSecret !== env.PAYINVOICE_ADMIN_SECRET) {
    return json(401, { error: 'Unauthorized' })
  }

  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }

  const body = normalizeBody(parsed)
  if (!body) {
    return json(400, {
      error: 'Body must contain exactly one of: { "url": "..." } or { "payment_id": "..." }',
    })
  }

  let upstream: Response
  try {
    upstream = await fetch('https://agentapi.rozo.ai/pay-invoice', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET,
      },
      body: JSON.stringify(body),
    })
  } catch (err: any) {
    return json(502, { error: `Upstream call failed: ${err?.message ?? 'unknown error'}` })
  }

  const contentType = upstream.headers.get('content-type') || 'application/json'
  const text = await upstream.text()
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': contentType },
  })
}
