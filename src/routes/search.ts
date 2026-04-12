/**
 * GET /v1/services/search — Lightweight catalog search and filter.
 *
 * Supports:
 *   ?q=<keyword>         — search across id, name, description
 *   ?category=<cat>      — filter by category
 *   ?status=active|limited — filter by status
 *   ?limit=20            — max results (default 20, max 100)
 *   ?offset=0            — pagination offset
 *
 * Returns the same entry shape as the full catalog, but filtered.
 * Runs in-memory against the pre-built route table (~489 entries).
 */

import { listPublicCatalog, type CatalogEnvView } from '../services/merchants'
import type { PublicCatalogEntry } from '../services/merchants-types'

export function handleSearch(url: URL, env: CatalogEnvView): Response {
  const params = url.searchParams
  const q = params.get('q')?.toLowerCase()
  const category = params.get('category')?.toLowerCase()
  const status = params.get('status')?.toLowerCase()
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '20', 10) || 20, 1), 100)
  const offset = Math.max(parseInt(params.get('offset') || '0', 10) || 0, 0)

  let results: PublicCatalogEntry[] = listPublicCatalog(env)

  // Filter by status
  if (status === 'active' || status === 'limited') {
    results = results.filter(s => s.status === status)
  }

  // Filter by category
  if (category) {
    results = results.filter(s =>
      s.categories.some(c => c.toLowerCase() === category),
    )
  }

  // Keyword search
  if (q) {
    results = results.filter(s =>
      s.id.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q),
    )
  }

  const total = results.length
  const paged = results.slice(offset, offset + limit)

  return new Response(JSON.stringify({
    total,
    limit,
    offset,
    services: paged,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}
