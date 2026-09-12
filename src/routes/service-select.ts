/**
 * GET /v1/services/select?capability=<id>[&provider=<id>][&window=7d]
 *
 * Quality-based selection between provider routes that declared the same
 * capability contract. Read-only and free: it names the route to call and
 * the address that route's 402 will pay, before any challenge is issued.
 * The buyer then calls `selected.public_path`; the payment they make is
 * to that provider and nobody else. See services/provider-selection.ts.
 *
 * GET /v1/services/capabilities lists the contracts a route may declare.
 */

import type { Env } from '../index'
import { CAPABILITY_CONTRACTS } from '../services/provider-capabilities'
import { selectProvider } from '../services/provider-selection'

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export function handleCapabilities(): Response {
  return json(200, {
    note: 'Contracts a self-serve provider route may declare in routes[].capability. Declared by the provider; the router checks the method only.',
    capabilities: CAPABILITY_CONTRACTS,
  })
}

export async function handleServiceSelect(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const capability = (url.searchParams.get('capability') ?? '').trim().toLowerCase()
  if (!capability) {
    return json(400, { error: 'missing_parameter', detail: 'capability is required.', example: '/v1/services/select?capability=web-search.v1' })
  }
  const result = await selectProvider(env, {
    capability,
    provider: url.searchParams.get('provider') ?? undefined,
    window: url.searchParams.get('window') ?? undefined,
  })
  if ('error' in result && !('capability' in result)) {
    return json(result.error.status, { error: result.error.code, detail: result.error.detail })
  }
  const selection = result as Exclude<typeof result, { error: { status: number } }>
  if (selection.error) {
    const status = selection.error.code === 'pinned_provider_not_found' ? 404 : selection.error.code === 'pinned_provider_offline' ? 409 : 404
    return json(status, { error: selection.error.code, detail: selection.error.detail, ...selection, error_detail: undefined })
  }
  return json(200, selection)
}
