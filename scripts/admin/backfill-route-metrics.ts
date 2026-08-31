/**
 * Backfill `route_metric_calls` from the existing per-call order ledger.
 *
 * Without this, the public metrics endpoint starts empty and the service
 * pages would read as "this provider has never been used" on the day they
 * ship. The order ledger (KV `mercury_order:*`, src/services/order-ledger.ts)
 * already holds one record per settled call going back to 2026-08-11, with
 * the route, the upstream status, the refund status and — for the routes
 * that measured it — a duration. That is exactly the shape this table wants.
 *
 * WHAT IT CANNOT RECOVER, and must not fake:
 *   - The HTTP method. The order ledger does not store it, and most catalog
 *     routes are POST, so hard-coding 'GET' would permanently record a
 *     method that disagrees with live rows. Backfilled rows use 'UNKNOWN'.
 *   - Latency for routes whose branch never measured it. The ledger stores
 *     0 for those; 0 is written back as NULL (unmeasured), never as a
 *     0ms sample, or the published p50 would be a lie in our own favour.
 *   - Calls that failed before a ledger record was written. Backfilled
 *     history is therefore a floor on failures, not a complete census, and
 *     the endpoint's `methodology.coverage` says so.
 *
 * Idempotent ACROSS RUNS: `call_id` is `backfill:<order_id>`, so a second run
 * inserts nothing.
 *
 * NOT idempotent against LIVE recording, which is why the cutoff below
 * exists. A live row is keyed by a random UUID, so it can never collide with
 * a backfill row for the same call — run this after live recording has
 * started and every overlapping call is counted TWICE, permanently, in every
 * window. The script therefore refuses to insert anything at or after the
 * oldest live row it can find.
 *
 * Usage (read-only against KV, writes only to the metrics D1):
 *   npx tsx scripts/admin/backfill-route-metrics.ts --dry-run
 *   npx tsx scripts/admin/backfill-route-metrics.ts --execute
 */

import { execFileSync } from 'node:child_process'
// Imported at module scope, not via require(): package.json sets
// "type": "module", so require is undefined here. The dry-run path never
// reaches the write, which is exactly how this stayed hidden.
import { writeFileSync } from 'node:fs'

const KV_NAMESPACE_ID = 'b0fa51efc09e4e708c6bd5061b0663e0'
const D1_NAME = 'mpprouter-route-metrics'
const LEDGER_PREFIX = 'mercury_order:'

interface OrderLedgerEntry {
  order_id: string
  ts: string
  route_id: string
  request_path: string
  upstream_status: number
  latency_ms: number
  refund_status: 'none' | 'pending' | 'refunded' | 'unknown'
}

function wrangler(args: string[]): string {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: '2d3f34ca0a1426b30a7d07cf79bdac90' },
  })
}

function serviceIdFromRouteId(routeId: string): string {
  const i = routeId.indexOf('_')
  return i === -1 ? routeId : routeId.slice(0, i)
}

/**
 * Mirrors classifyOutcome in src/services/route-metrics.ts. Kept as a copy
 * rather than imported because this script runs in Node against the wrangler
 * CLI, not in the Worker runtime — but the two MUST stay in step, or
 * backfilled history and live recording will disagree about whose fault a
 * 403 was. Change both together.
 */
function classify(status: number, routerHoldsCredential: boolean): string {
  if (status >= 200 && status < 300) return 'ok'
  // Not 'caller_error': the agent's Authorization never reaches the upstream
  // (forwardHeaders strips it), so an auth rejection is ours or the
  // provider's. Must match classifyOutcome exactly.
  if (status === 401 || status === 403) return routerHoldsCredential ? 'router_fault' : 'provider_fault'
  if (status === 408 || status === 429) return 'provider_fault'
  if (status >= 400 && status < 500) return 'caller_error'
  return 'provider_fault'
}

/**
 * Routes where the router presents the upstream credential. Sourced from
 * `upstreamAuth` in src/services/merchants.ts; a 401/403 on these is our
 * misconfiguration, not the caller's bad request.
 */
const ROUTER_CREDENTIAL_PREFIXES = ['mercury_']

function main() {
  const execute = process.argv.includes('--execute')
  if (!execute && !process.argv.includes('--dry-run')) {
    console.error('Pass --dry-run or --execute.')
    process.exit(2)
  }

  // The cutoff: the oldest call the Worker recorded live. Anything at or
  // after it is already in the table under a different (random) id, and
  // inserting it again would double-count it forever.
  let liveCutoffMs = Number.POSITIVE_INFINITY
  try {
    const res = JSON.parse(
      wrangler([
        'd1', 'execute', D1_NAME, '--remote', '--json',
        '--command',
        "SELECT MIN(created_at) AS oldest FROM route_metric_calls WHERE call_id NOT LIKE 'backfill:%'",
      ]),
    )
    const oldest = res?.[0]?.results?.[0]?.oldest
    if (typeof oldest === 'number') {
      liveCutoffMs = oldest
      console.log(
        `Live recording starts at ${new Date(oldest).toISOString()}; ` +
          `ledger entries at or after that are already recorded and will be skipped.`,
      )
    }
  } catch (err) {
    // Fail closed. Guessing "no live rows" is exactly the assumption that
    // produces silent double counting.
    console.error(
      `Could not determine the live-recording cutoff: ${(err as Error).message}\n` +
        `Refusing to run rather than risk double-counting. Verify the table exists and retry.`,
    )
    process.exit(1)
  }

  const keys: Array<{ name: string }> = JSON.parse(
    wrangler(['kv', 'key', 'list', '--namespace-id', KV_NAMESPACE_ID, '--prefix', LEDGER_PREFIX, '--remote']),
  )
  console.log(`Found ${keys.length} order-ledger records.`)

  const statements: string[] = []
  const skipped: string[] = []

  for (const { name } of keys) {
    let entry: OrderLedgerEntry
    try {
      entry = JSON.parse(wrangler(['kv', 'key', 'get', name, '--namespace-id', KV_NAMESPACE_ID, '--remote']))
    } catch (err) {
      skipped.push(`${name}: unreadable (${(err as Error).message})`)
      continue
    }

    const routerHeld = ROUTER_CREDENTIAL_PREFIXES.some((p) => entry.route_id.startsWith(p))
    const outcome = classify(entry.upstream_status, routerHeld)
    // 0 in the ledger means "this branch never measured it", not "instant".
    const latency = entry.latency_ms > 0 ? entry.latency_ms : null
    const refunded = entry.refund_status === 'refunded' ? 1 : 0
    const createdAt = Date.parse(entry.ts)
    if (Number.isNaN(createdAt)) {
      skipped.push(`${name}: unparseable ts ${entry.ts}`)
      continue
    }
    if (createdAt >= liveCutoffMs) {
      skipped.push(`${name}: at/after live cutoff, already recorded live`)
      continue
    }

    // Deterministic id from the ledger's own order id: re-running cannot
    // duplicate a call, and a live-recorded call cannot collide with it.
    const callId = `backfill:${entry.order_id}`
    const esc = (v: string) => `'${v.replace(/'/g, "''")}'`
    statements.push(
      `INSERT INTO route_metric_calls (call_id, created_at, service_id, route_id, method, outcome, reason, upstream_status, latency_ms, refunded) VALUES (${esc(callId)}, ${createdAt}, ${esc(serviceIdFromRouteId(entry.route_id))}, ${esc(entry.route_id)}, ${esc('UNKNOWN')}, ${esc(outcome)}, ${outcome === 'ok' ? 'NULL' : esc('backfilled_from_order_ledger')}, ${entry.upstream_status}, ${latency ?? 'NULL'}, ${refunded}) ON CONFLICT(call_id) DO NOTHING;`,
    )
  }

  const byOutcome = new Map<string, number>()
  for (const s of statements) {
    const m = s.match(/'(ok|provider_fault|caller_error|router_fault)'/)
    if (m) byOutcome.set(m[1], (byOutcome.get(m[1]) ?? 0) + 1)
  }
  console.log(`Prepared ${statements.length} inserts:`, Object.fromEntries(byOutcome))
  if (skipped.length) console.log(`Skipped ${skipped.length}:`, skipped)

  if (!execute) {
    console.log('\nDry run. Re-run with --execute to write.')
    console.log(statements.slice(0, 3).join('\n'))
    return
  }

  const sqlFile = `/tmp/backfill-route-metrics-${Date.now()}.sql`
  writeFileSync(sqlFile, statements.join('\n'))
  wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', sqlFile])
  console.log(`Wrote ${statements.length} rows to ${D1_NAME}.`)
}

main()
