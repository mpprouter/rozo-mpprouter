#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/playground-recon.ts — Playground solvency reconciliation.
 *
 * Read-only. No signing, no writes, no on-chain actions. Safe to run on a
 * schedule; exits non-zero on any mismatch so cron/CI can page.
 *
 * What it reconciles
 * ------------------
 * Three independent views of the same money must agree:
 *
 *   1. **On-chain**  — memo'd USDC payments to the router's receiving account
 *                      whose memo matches the playground nonce format.
 *   2. **Ledger in**  — `total:credited` in the PlaygroundLedger DO.
 *   3. **Ledger out** — `total:committed` plus current balances and in-flight
 *                       holds.
 *
 * Two invariants are checked:
 *
 *   A. `credited == committed + balances_sum + holds_sum`
 *      Internal consistency. A failure means the DO's incremental counters
 *      have drifted from the rows they summarise — a ledger bug, and the
 *      reason `/totals` recomputes the sums by scanning rather than reading
 *      the counters back.
 *
 *   B. `on-chain deposits >= credited`
 *      Solvency. Credit must never exceed money that actually arrived. The
 *      comparison is one-directional on purpose: a user can pay with a valid
 *      memo and never call `session/open` (or let the intent expire), which
 *      legitimately leaves on-chain ahead of credited. Credited ahead of
 *      on-chain is never legitimate and is the condition worth paging on.
 *
 * Usage:
 *   npx tsx scripts/admin/playground-recon.ts --api https://apiserver.mpprouter.dev
 *   npx tsx scripts/admin/playground-recon.ts --horizon https://horizon.stellar.org
 *
 * Reads STELLAR_ROUTER_PUBLIC and PLAYGROUND_RECON_TOKEN from .dev.vars at the
 * repo root. Never prints a secret; addresses are masked front-6/last-4.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

const ONE_USDC = 10_000_000n

function loadDevVars(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const raw = readFileSync(resolve(REPO_ROOT, '.dev.vars'), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (!m) continue
      out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // .dev.vars is optional — flags and process env can supply everything.
  }
  return out
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Front 6 + last 4. House policy for any address in output or logs. */
function mask(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`
}

function fmt(atomic: bigint): string {
  const negative = atomic < 0n
  const abs = negative ? -atomic : atomic
  return `${negative ? '-' : ''}$${abs / ONE_USDC}.${(abs % ONE_USDC).toString().padStart(7, '0')}`
}

/** Horizon renders amounts with 7 decimals; parse to atomic without floats. */
function horizonToAtomic(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.')
  return BigInt(whole) * ONE_USDC + BigInt(frac.padEnd(7, '0').slice(0, 7) || '0')
}

const PLAYGROUND_MEMO = /^pg-[0-9a-f]{20}$/
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

interface HorizonPayment {
  type: string
  asset_code?: string
  asset_issuer?: string
  to?: string
  amount?: string
  transaction_hash?: string
}

/**
 * Sum playground-memo'd USDC payments into the receiving account.
 *
 * Pages backwards from newest and stops at `sinceIso`, so a routine run costs
 * a handful of requests rather than a full account history walk. Payments
 * whose memo is not playground-shaped belong to the paid proxy and are skipped.
 */
async function sumOnChainDeposits(
  horizon: string,
  account: string,
  sinceIso: string,
): Promise<{ total: bigint; count: number; scanned: number }> {
  let total = 0n
  let count = 0
  let scanned = 0
  let url =
    `${horizon}/accounts/${account}/payments?limit=200&order=desc&join=transactions`

  for (let page = 0; page < 50; page++) {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`Horizon ${resp.status} on ${url.split('?')[0]}`)
    const body = (await resp.json()) as {
      _embedded?: { records?: (HorizonPayment & { created_at?: string; transaction?: any })[] }
      _links?: { next?: { href?: string } }
    }
    const records = body._embedded?.records ?? []
    if (records.length === 0) break

    let reachedCutoff = false
    for (const record of records) {
      scanned++
      if (record.created_at && record.created_at < sinceIso) {
        reachedCutoff = true
        continue
      }
      if (record.type !== 'payment') continue
      if (record.to !== account) continue
      if (record.asset_code !== 'USDC' || record.asset_issuer !== USDC_ISSUER) continue
      const memo = record.transaction?.memo
      const memoType = record.transaction?.memo_type
      if (memoType !== 'text' || typeof memo !== 'string' || !PLAYGROUND_MEMO.test(memo)) continue
      if (record.transaction?.successful === false) continue
      total += horizonToAtomic(record.amount ?? '0')
      count++
    }

    if (reachedCutoff) break
    const next = body._links?.next?.href
    if (!next) break
    url = next
  }

  return { total, count, scanned }
}

interface LedgerTotals {
  credited: string
  committed: string
  outstanding: string
  balances_sum: string
  holds_sum: string
  consumed_deposits: { tx_hash: string; op_index: number; intent_id: string }[]
}

async function main(): Promise<number> {
  const vars = { ...loadDevVars(), ...process.env } as Record<string, string>

  const horizon = arg('horizon') ?? vars.PLAYGROUND_HORIZON_URL ?? 'https://horizon.stellar.org'
  const api = arg('api') ?? 'https://apiserver.mpprouter.dev'
  const account = arg('account') ?? vars.STELLAR_ROUTER_PUBLIC
  const since = arg('since') ?? '2026-08-01T00:00:00Z'
  const token = vars.PLAYGROUND_RECON_TOKEN

  if (!account) {
    console.error('STELLAR_ROUTER_PUBLIC is not set (put it in .dev.vars or pass --account)')
    return 2
  }

  console.log('Playground solvency reconciliation')
  console.log(`  receiving account : ${mask(account)}`)
  console.log(`  horizon           : ${horizon}`)
  console.log(`  api               : ${api}`)
  console.log(`  since             : ${since}`)
  console.log('')

  // ---- ledger side ------------------------------------------------------
  // Served by an operator-only endpoint on the Worker; the DO is not
  // reachable from outside it. Without a token this half cannot be read, so
  // the script reports that rather than pretending the ledger is at zero.
  let totals: LedgerTotals
  try {
    const resp = await fetch(`${api}/v1/playground/admin/totals`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (!resp.ok) throw new Error(`status ${resp.status}`)
    const body = (await resp.json()) as { ok?: boolean; value?: LedgerTotals }
    if (!body.value) throw new Error('unexpected response shape')
    totals = body.value
  } catch (e: any) {
    console.error(`FATAL: could not read ledger totals from ${api}: ${e.message}`)
    console.error('Set PLAYGROUND_RECON_TOKEN in .dev.vars, or run against a deploy that')
    console.error('exposes /v1/playground/admin/totals.')
    return 2
  }

  const credited = BigInt(totals.credited)
  const committed = BigInt(totals.committed)
  const balances = BigInt(totals.balances_sum)
  const holds = BigInt(totals.holds_sum)
  const outstanding = BigInt(totals.outstanding)

  console.log('Ledger (PlaygroundLedger DO)')
  console.log(`  credited (deposits in)   : ${fmt(credited)}`)
  console.log(`  committed (spent)        : ${fmt(committed)}`)
  console.log(`  balances (unspent)       : ${fmt(balances)}`)
  console.log(`  holds (calls in flight)  : ${fmt(holds)}`)
  console.log(`  outstanding (counter)    : ${fmt(outstanding)}`)
  console.log(`  consumed deposit ops     : ${totals.consumed_deposits.length}`)
  console.log('')

  // ---- chain side -------------------------------------------------------
  const onChain = await sumOnChainDeposits(horizon, account, since)
  console.log('On-chain (memo-matched USDC payments)')
  console.log(`  deposits found           : ${onChain.count} (scanned ${onChain.scanned} payments)`)
  console.log(`  total received           : ${fmt(onChain.total)}`)
  console.log('')

  // ---- invariants -------------------------------------------------------
  let failures = 0

  const internalRhs = committed + balances + holds
  if (credited !== internalRhs) {
    console.error('MISMATCH (A): credited != committed + balances + holds')
    console.error(`  credited ${fmt(credited)} vs ${fmt(internalRhs)} (diff ${fmt(credited - internalRhs)})`)
    failures++
  } else {
    console.log('OK (A): credited == committed + balances + holds')
  }

  if (outstanding !== balances + holds) {
    console.error('MISMATCH (A2): the outstanding counter drifted from a full rescan')
    console.error(`  counter ${fmt(outstanding)} vs rescan ${fmt(balances + holds)}`)
    failures++
  } else {
    console.log('OK (A2): outstanding counter matches a full rescan')
  }

  if (credited > onChain.total) {
    console.error('MISMATCH (B): credited MORE than actually arrived on-chain — INSOLVENT')
    console.error(`  credited ${fmt(credited)} vs on-chain ${fmt(onChain.total)}`)
    console.error('  Investigate immediately: this is credit minted without payment.')
    failures++
  } else {
    const unclaimed = onChain.total - credited
    console.log(`OK (B): on-chain >= credited (unclaimed/expired deposits ${fmt(unclaimed)})`)
  }

  console.log('')
  console.log(failures === 0 ? 'RECON PASSED' : `RECON FAILED — ${failures} mismatch(es)`)
  return failures === 0 ? 0 : 1
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error('recon failed:', e.message)
    process.exit(2)
  })
