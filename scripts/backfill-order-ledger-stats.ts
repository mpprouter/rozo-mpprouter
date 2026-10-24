/**
 * One-time backfill of the D1 commerce rollup `order_ledger_stats`
 * (migrations-metrics/0002) from the KV order ledger `mercury_order:*`.
 *
 * Runs from an operator machine through wrangler, entirely outside the
 * Worker request path. Idempotent: rows upsert on order_id, so it is safe to
 * re-run (e.g. to catch orders written between deploy and backfill).
 *
 *   npx tsx scripts/backfill-order-ledger-stats.ts            # dry run, prints counts
 *   npx tsx scripts/backfill-order-ledger-stats.ts --apply    # writes to remote D1
 *
 * Prints only counts, never order contents or payers.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orderStatsRow, type OrderLedgerEntry } from '../src/services/order-ledger'

const NAMESPACE_ID = 'b0fa51efc09e4e708c6bd5061b0663e0' // MPP_STORE
const DB = 'mpprouter-route-metrics'
const apply = process.argv.includes('--apply')
const dir = mkdtempSync(join(tmpdir(), 'ols-backfill-'))

function wrangler(args: string[]): string {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

const sqlStr = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)

const listed = JSON.parse(
  wrangler(['kv', 'key', 'list', '--namespace-id', NAMESPACE_ID, '--remote', '--prefix', 'mercury_order:']),
) as { name: string }[]
console.log(`keys listed: ${listed.length}`)

const statements: string[] = []
let unreadable = 0
for (let i = 0; i < listed.length; i += 100) {
  const file = join(dir, `keys-${i}.json`)
  writeFileSync(file, JSON.stringify(listed.slice(i, i + 100).map((k) => k.name)))
  // wrangler appends a "Success!" line after the JSON object.
  const out = wrangler(['kv', 'bulk', 'get', file, '--namespace-id', NAMESPACE_ID, '--remote'])
  const values = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as Record<
    string,
    string | null
  >
  for (const raw of Object.values(values)) {
    if (!raw) continue // expired between list and get
    let row
    try {
      row = await orderStatsRow(JSON.parse(raw) as OrderLedgerEntry)
    } catch {
      row = null
    }
    if (!row) {
      unreadable += 1
      continue
    }
    statements.push(
      'INSERT INTO order_ledger_stats (order_id, created_at, service_id, amount_micros, payer_digest, refunded) VALUES (' +
        [sqlStr(row.order_id), row.created_at, sqlStr(row.service_id), row.amount_micros, sqlStr(row.payer_digest), row.refunded].join(', ') +
        ') ON CONFLICT(order_id) DO UPDATE SET refunded = MAX(order_ledger_stats.refunded, excluded.refunded);',
    )
  }
  process.stdout.write(`read ${Math.min(i + 100, listed.length)}/${listed.length}\r`)
}
console.log(`\nrows built: ${statements.length}, unreadable: ${unreadable}`)

if (!apply) {
  console.log('dry run; pass --apply to write')
  process.exit(0)
}
for (let i = 0; i < statements.length; i += 500) {
  const file = join(dir, `batch-${i}.sql`)
  writeFileSync(file, statements.slice(i, i + 500).join('\n'))
  wrangler(['d1', 'execute', DB, '--remote', '--file', file, '--yes'])
  console.log(`applied ${Math.min(i + 500, statements.length)}/${statements.length}`)
}
const out = JSON.parse(
  wrangler(['d1', 'execute', DB, '--remote', '--json', '--command', 'SELECT COUNT(*) AS n FROM order_ledger_stats']),
)
console.log(`order_ledger_stats rows: ${out[0].results[0].n}`)
