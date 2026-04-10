/**
 * GET /services and GET /v1/services/catalog — Returns the public service catalog.
 */

import { listPublicCatalog } from '../services/merchants'

export function handleServices(): Response {
  return new Response(JSON.stringify({
    version: 1,
    base_url: 'https://apiserver.mpprouter.dev',
    generated_at: new Date().toISOString(),
    services: listPublicCatalog(),
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}
