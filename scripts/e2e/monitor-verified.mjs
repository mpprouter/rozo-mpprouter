/**
 * ZERO-COST daily health monitor for verified MPP Router providers.
 *
 * Why this exists (docs/PROPOSAL-provider-lifecycle-sop-2026-06-24.md, codex
 * review 2026-06-24): a previously-working provider can break SILENTLY when a
 * merchant changes its 402 challenge (e.g. stableemail added a `solana:` offer)
 * or when we upgrade a shared dep. The first signal today is a customer report.
 * This monitor catches that class BEFORE customers, for free.
 *
 * codex's key correction: probe the UPSTREAM MERCHANT's 402 (service.url +
 * endpoint.path), NOT the Router's public endpoint — the Router endpoint only
 * shows the customer-facing quote, which would NOT have caught stableemail. We
 * probe the same upstream 402 the Router's mppx client sees, run it through the
 * SAME sanitizer the production fix uses, and classify:
 *
 *   OK    — challenge parses (after sanitizer if needed); the payable path we
 *           rely on is intact.
 *   WARN  — raw accepts[].network set changed but the sanitizer still yields a
 *           payable/parseable path (e.g. merchant added a network we don't pay,
 *           which the fix deliberately tolerates). Informational, not a page.
 *   FAIL  — after sanitizing, mppx still cannot parse a payable challenge, OR
 *           the www-authenticate (Tempo) challenge we depend on disappeared, OR
 *           the upstream didn't even return a 402. This is the stableemail class.
 *
 * SAFETY (codex #5 [P0]): this script NEVER signs, NEVER pays, NEVER imports a
 * key, NEVER calls pay-per-call. It only issues unauthenticated POSTs that
 * expect a 402 back. It physically cannot move money.
 *
 * SCOPE — what an unpaid probe can and cannot see (2026-08-18):
 * Because it stops at the 402, this monitor observes exactly one leg: that the
 * merchant still offers a payable challenge we can parse. It says nothing
 * about what happens AFTER a payment settles. A merchant that answers a
 * healthy 402, accepts the payment, and then fails its own upstream call is
 * OK by every check here — the challenge is intact, which is all an unpaid
 * request can establish. That class of failure is only observable from a paid
 * call (scripts/e2e/charge-e2e.mjs) or from production settlement data, and
 * anthropic chat_completions sat in it for days: healthy 402, payment
 * settled, merchant leg 403, automatic refund. Two signals close the gap
 * without spending money on every route:
 *   - GET /v1/ledger now records settled-but-undelivered calls with a refund
 *     status, so a route that refunds every call is visible in the data.
 *   - services/route-health.ts records the failure reason per route from live
 *     traffic.
 * Treat an all-OK run from this script as "the challenge layer is intact",
 * never as "the route delivers".
 *
 * Output: JSON report to stdout (consumed by ainative
 * scripts/mpprouter_health_sync.py which writes brain.db + alerts on FAIL).
 * Exit 0 if no FAIL, 1 if any FAIL, 2 on harness error.
 *
 *   node scripts/e2e/monitor-verified.mjs            # all verified routes
 *   node scripts/e2e/monitor-verified.mjs exa groq   # subset
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Transport } from 'mppx/client'
import { sanitize402Response } from '../../src/mpp/tempo-client.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT = join(__dirname, '../../src/services/mpp-catalog-snapshot.json')

/**
 * The routes we currently advertise as verified (OPERATOR_OVERLAY
 * chargeVerified/sessionVerified === true). Keep in sync with merchants.ts.
 * Each entry: serviceId + the specific endpoint path we verified, plus the
 * minimal body that triggers the merchant's 402 (no secrets, no real values).
 */
/**
 * The routes we currently advertise as verified (OPERATOR_OVERLAY
 * chargeVerified/sessionVerified === true). We only hand-maintain the service
 * id + minimal body here; the upstream URL and endpoint path are read FROM THE
 * SNAPSHOT so a path/URL change is picked up automatically (and we can't
 * hand-fat-finger a wrong path). `body` has no secrets/real values.
 *
 * Keep this id list in sync with the verified flags in src/services/merchants.ts.
 */
const VERIFIED = [
  { id: 'exa', body: { query: 'ping' } },
  { id: 'firecrawl', body: { url: 'https://example.com' } },
  { id: 'parallel', body: { objective: 'ping' } },
  // alchemy path has a `:network` placeholder — substitute a real chain so the
  // upstream returns its 402 instead of a routing 400/404.
  { id: 'alchemy', pathVars: { network: 'base-mainnet' }, body: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] } },
  { id: 'coingecko', body: { ids: 'bitcoin', vs_currencies: 'usd' } },
  { id: 'deepseek', body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 } },
  { id: 'groq', body: { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 } },
  // session-mode merchants (still zero-cost to probe — we only read the 402):
  { id: 'openai', body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 } },
  { id: 'openrouter', body: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 } },
]

function loadServices() {
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  return Array.isArray(snap) ? snap : snap.services || snap.catalog || []
}

/**
 * Resolve the upstream MERCHANT 402 URL for a verified route, from the snapshot.
 * The real upstream the Router pays is `serviceUrl` (the mpp proxy domain, e.g.
 * https://deepseek.mpp.paywithlocus.com), NOT `url` (the merchant's marketing
 * homepage). Path is the first paid POST endpoint in the snapshot.
 * Returns { url, path, intent } or null.
 */
function upstreamFor(services, id, pathVars) {
  const svc = services.find((s) => s.id === id)
  if (!svc) return null
  const base = (svc.serviceUrl || svc.url || '').replace(/\/$/, '')
  if (!base) return null
  const eps = svc.endpoints || []
  const ep = eps.find((e) => e.payment && e.method === 'POST') || eps.find((e) => e.payment) || eps[0]
  if (!ep || !ep.path) return null
  // Substitute `:var` placeholders in the path (e.g. alchemy's :network).
  let path = ep.path
  for (const [k, v] of Object.entries(pathVars || {})) {
    path = path.replace(`:${k}`, v)
  }
  return { url: base + path, path, intent: ep.payment?.intent }
}

/** True iff mppx's own parser accepts this response (same oracle as the fix). */
function mppxParses(resp) {
  try {
    const t = Transport.http()
    t.getChallenges ? t.getChallenges(resp) : t.getChallenge(resp)
    return true
  } catch {
    return false
  }
}

/** Pull the raw accepts[].network set from a payment-required header, or []. */
function networksOf(resp) {
  const h = resp.headers.get('payment-required')
  if (!h) return []
  try {
    const obj = JSON.parse(Buffer.from(h, 'base64').toString('utf8'))
    return Array.isArray(obj.accepts) ? obj.accepts.map((a) => a?.network).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * Probe with retry so a single transient network blip (DNS, TLS reset, timeout)
 * does NOT produce a FAIL + page. Only a genuinely unreachable upstream after N
 * attempts is treated as down. codex: "don't alert/demote on a single failure."
 */
async function probe(url, body, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      })
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
    }
  }
  throw lastErr
}

async function checkOne(services, route) {
  const up = upstreamFor(services, route.id, route.pathVars)
  if (!up) return { id: route.id, status: 'FAIL', reason: 'no upstream URL/path in snapshot' }
  const url = up.url

  let res
  try {
    res = await probe(url, route.body)
  } catch (e) {
    return { id: route.id, status: 'FAIL', reason: `upstream unreachable after retries: ${String(e.message || e).slice(0, 120)}`, url }
  }

  if (res.status !== 402) {
    return { id: route.id, status: 'FAIL', reason: `upstream did not return 402 (got ${res.status})`, url }
  }

  const rawNetworks = networksOf(res)
  const rawParses = mppxParses(res)

  // Run through the SAME sanitizer the production fix uses. sanitize402Response
  // only reads headers, so we rebuild a header-only Response to avoid any
  // body-stream reuse concerns.
  const headerOnly = new Response(null, { status: 402, headers: res.headers })
  const sanitized = sanitize402Response(headerOnly)
  const sanitizedParses = mppxParses(sanitized)
  const sanitizedHasWww = sanitized.headers.has('www-authenticate')

  // Classification (codex three-tier):
  if (!sanitizedParses && !sanitizedHasWww) {
    // After sanitizing, mppx still can't parse AND no Tempo fallback → the
    // payable path is gone. THIS is the stableemail class.
    return {
      id: route.id, status: 'FAIL', url,
      reason: 'no payable challenge after sanitize (mppx cannot parse and no www-authenticate)',
      rawNetworks,
    }
  }
  if (!rawParses && sanitizedParses) {
    // Raw header was unparseable (e.g. merchant added a non-EVM offer) but the
    // sanitizer recovered a payable path — exactly the case we now tolerate.
    return {
      id: route.id, status: 'WARN', url,
      reason: 'raw challenge unparseable by mppx but sanitizer recovers a payable path (tolerated drift)',
      rawNetworks,
    }
  }
  return { id: route.id, status: 'OK', url, rawNetworks }
}

async function main() {
  const only = process.argv.slice(2)
  const services = loadServices()
  const targets = only.length ? VERIFIED.filter((r) => only.includes(r.id)) : VERIFIED

  const results = []
  for (const route of targets) {
    process.stderr.write(`→ ${route.id} ... `)
    const r = await checkOne(services, route)
    results.push(r)
    process.stderr.write(`${r.status}${r.reason ? ' (' + r.reason + ')' : ''}\n`)
  }

  const fails = results.filter((r) => r.status === 'FAIL')
  const warns = results.filter((r) => r.status === 'WARN')
  process.stderr.write(
    `\n=== MONITOR SUMMARY === OK:${results.length - fails.length - warns.length} WARN:${warns.length} FAIL:${fails.length}\n`,
  )

  // Machine-readable report for the ainative sync layer.
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    total: results.length,
    ok: results.length - fails.length - warns.length,
    warn: warns.length,
    fail: fails.length,
    results,
  }, null, 2))

  process.exit(fails.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
