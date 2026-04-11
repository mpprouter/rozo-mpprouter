#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/refresh-mpp-snapshot.ts
 *
 * Pull the current mpp.dev catalog and overwrite
 * `src/services/mpp-catalog-snapshot.json`. Run this when:
 *   - mpp.dev publishes a new merchant or endpoint we want to proxy
 *   - merchant prices change upstream
 *   - merchant adds a new endpoint we want exposed
 *
 * Workflow after running:
 *   1. git diff src/services/mpp-catalog-snapshot.json
 *      → review which routes were added / removed / repriced
 *   2. bun run test
 *      → confirm the build-routes generator + tests still pass
 *   3. bunx wrangler dev → curl /services → spot-check
 *   4. git commit -m "Refresh mpp.dev catalog snapshot YYYY-MM-DD"
 *      → record the operator action in git history
 *   5. wrangler deploy → ship
 *
 * The script does NOT auto-commit. Operators always review the diff
 * before committing because mpp.dev could in principle publish a
 * malformed entry, a route name change that would break public URL
 * bookmarks, or a price change the operator wants to flag in
 * REMIND.md.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SNAPSHOT_PATH = path.resolve(
  __dirname,
  '../../src/services/mpp-catalog-snapshot.json',
)
const SOURCE_URL = process.env.MPP_CATALOG_URL ?? 'https://mpp.dev/api/services'

async function main() {
  console.log(`[refresh-mpp-snapshot] fetching ${SOURCE_URL}`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) {
    console.error(`[refresh-mpp-snapshot] HTTP ${res.status}: ${res.statusText}`)
    process.exit(1)
  }
  const body = await res.text()
  let parsed: { services?: unknown[] }
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    console.error('[refresh-mpp-snapshot] response is not valid JSON', err)
    process.exit(1)
  }
  if (!Array.isArray(parsed.services)) {
    console.error(
      '[refresh-mpp-snapshot] response missing `services` array — refusing to overwrite snapshot',
    )
    process.exit(1)
  }
  const serviceCount = parsed.services.length
  if (serviceCount < 10) {
    console.error(
      `[refresh-mpp-snapshot] response has only ${serviceCount} services — sanity check failed, refusing to overwrite snapshot`,
    )
    process.exit(1)
  }
  // Pretty-print so the diff is reviewable in git.
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
  console.log(
    `[refresh-mpp-snapshot] wrote ${serviceCount} services to ${SNAPSHOT_PATH}`,
  )
  console.log('[refresh-mpp-snapshot] next: review `git diff` then commit')
}

main().catch(err => {
  console.error('[refresh-mpp-snapshot] fatal:', err)
  process.exit(1)
})
