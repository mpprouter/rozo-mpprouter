import type { Env } from '../index'
import { listPublishedProviders, publicPathFor } from '../services/provider-registry'

export async function handleX402WellKnown(env: Env): Promise<Response> {
  const providers = await listPublishedProviders(env)
  const resources = providers.flatMap(provider => provider.routes.map(route => ({
    resource: `https://apiserver.mpprouter.dev${publicPathFor(provider.id, route.operation)}`,
    method: route.method,
    description: route.description ?? `${route.operation} on ${provider.name}.`,
    accepts: provider.payouts.map(payout => ({
      scheme: 'exact', network: payout.network, asset: payout.asset, payTo: payout.payTo,
      price: route.priceUsd, operator: provider.id, settlement: 'direct',
    })),
  })))
  return new Response(JSON.stringify({
    spec: 'https://x402.org/specs/x402-v2',
    name: 'MPP Router',
    resources,
    discovery: 'https://apiserver.mpprouter.dev/services',
  }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } })
}
