/**
 * Real-money charge E2E for the MPP Router provider suite.
 *
 * For each target provider this drives the production charge path:
 *   client pays Stellar USDC  →  Router pool  →  Router pays merchant
 *   via Tempo  →  merchant returns result.
 *
 * A 200 with a sane body proves the WHOLE chain (the only thing that
 * does — a 402 probe can't reach downstream settlement). Failures are
 * classified per the SOP responsibility table (us vs merchant vs
 * client).
 *
 * This SPENDS REAL USDC. Each call is the lightest body for that
 * provider; per-call cost ranges $0.001 (quicknode) to $0.06
 * (coingecko). The whole suite is well under $1.
 *
 * It shells out to the stellar-agent-wallet `pay-per-call` skill, which
 * owns the 402 → sign → retry loop. We never touch the private key
 * directly here beyond extracting it to a 0600 temp file that is
 * deleted on exit.
 *
 * Usage:
 *   node scripts/e2e/charge-e2e.mjs                  # all providers
 *   node scripts/e2e/charge-e2e.mjs openai deepseek  # subset
 *   MAX_AUTO_USD=0.10 node scripts/e2e/charge-e2e.mjs
 *
 * Env:
 *   STELLAR_ENV_FILE  path to .env holding STELLAR_PRIVATE_KEY
 *                     (default: rozoskilltest/.env)
 *   PAY_PER_CALL_DIR  path to the pay-per-call skill dir
 *                     (default: latest mpprouter plugin cache)
 *   MAX_AUTO_USD      per-call auto-pay ceiling (default 0.10)
 *   ROUTER_BASE_OVERRIDE  test against a non-prod router
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globSync } from 'node:fs'

import { ROUTER_BASE, PROVIDERS } from './providers.mjs'

const BASE = process.env.ROUTER_BASE_OVERRIDE || ROUTER_BASE
const MAX_AUTO_USD = process.env.MAX_AUTO_USD || '0.10'
const ENV_FILE =
  process.env.STELLAR_ENV_FILE ||
  `${process.env.HOME}/workspace/rozo/rozocontracts/rozoskilltest/.env`

function resolvePayPerCallDir() {
  if (process.env.PAY_PER_CALL_DIR) return process.env.PAY_PER_CALL_DIR
  const home = process.env.HOME
  const candidates = globSync(
    `${home}/.claude/plugins/cache/mpprouter/stellar-agent-wallet/*/skills/pay-per-call`,
  )
  if (!candidates.length) {
    throw new Error(
      'pay-per-call skill not found. Set PAY_PER_CALL_DIR or install the mpprouter plugin.',
    )
  }
  // Highest version last after sort.
  candidates.sort()
  return candidates[candidates.length - 1]
}

/**
 * Extract the Stellar secret key from the .env into a 0600 temp file.
 * We NEVER print the key. The file is deleted by the caller's finally.
 */
function extractSecretFile() {
  if (!existsSync(ENV_FILE)) throw new Error(`STELLAR_ENV_FILE not found: ${ENV_FILE}`)
  const lines = readFileSync(ENV_FILE, 'utf8').split('\n')
  let secret = null
  for (const l of lines) {
    if (l.startsWith('STELLAR_PRIVATE_KEY=')) {
      secret = l.slice('STELLAR_PRIVATE_KEY='.length).trim().replace(/^["']|["']$/g, '')
      break
    }
  }
  if (!secret) throw new Error('STELLAR_PRIVATE_KEY not found in env file')
  if (!secret.startsWith('S')) throw new Error('extracted value is not a Stellar secret key')
  const dir = mkdtempSync(join(tmpdir(), 'mpp-e2e-'))
  // Self-clean: if ANY step after the dir exists throws (writeFile, chmod),
  // delete the dir before re-throwing so a partially-written key file can
  // never be left on disk outside the caller's try/finally.
  try {
    const file = join(dir, 'stkey')
    writeFileSync(file, secret, { mode: 0o600 })
    chmodSync(file, 0o600)
    return { file, dir }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

/**
 * Defense in depth: scrub anything that looks like a Stellar secret key
 * (S + 55 base32 chars) from any text before it can reach stdout/stderr/
 * logs. We never print the key ourselves, but the child wallet tool's
 * error paths are not under our control — redact its output too.
 */
function redactSecrets(text) {
  if (!text) return text
  return String(text).replace(/S[A-Z2-7]{55}/g, 'S<redacted-stellar-secret>')
}

/**
 * Classify a pay-per-call result into the SOP responsibility verdict.
 * Returns { verdict, blame, detail }.
 */
function classify(p, { ok, stdout, stderr, json }) {
  // The router wraps merchant responses as { success: true, data: <body> }.
  // Unwrap so per-provider okCheck sees the real upstream body.
  const unwrap = (j) => (j && j.success === true && j.data ? j.data : j)
  if (ok && json && p.okCheck(unwrap(json))) {
    return { verdict: 'PASS', blame: 'none', detail: 'full chain OK, valid upstream body' }
  }
  if (ok && json) {
    return { verdict: 'PASS_WEAK', blame: 'none', detail: 'HTTP 200 but body shape unexpected (manual check)' }
  }
  const err = (stderr || '') + (stdout || '')
  if (/descriptor required for TIP-1034/i.test(err)) {
    return { verdict: 'FAIL', blame: 'us', detail: 'voucher missing TIP-1034 descriptor (mppx too old)' }
  }
  if (/session channel not installed/i.test(err)) {
    return { verdict: 'FAIL', blame: 'us', detail: 'session channel not opened for this merchant (503)' }
  }
  if (/pool balance insufficient/i.test(err)) {
    return { verdict: 'FAIL', blame: 'us', detail: 'router pool underfunded (503)' }
  }
  if (/cumulative.*deposit|channel underfunded|exceeds.*deposit/i.test(err)) {
    return { verdict: 'FAIL', blame: 'us', detail: 'channel deposit exhausted — needs topup / new channel' }
  }
  if (/502|merchant payment failed/i.test(err) && /5\d\d|internal error/i.test(err)) {
    return { verdict: 'FAIL', blame: 'merchant', detail: 'we paid OK, merchant returned 5xx (502)' }
  }
  if (/402/.test(err)) {
    return { verdict: 'FAIL', blame: 'us', detail: 'challenge could not be satisfied (402 loop)' }
  }
  return { verdict: 'FAIL', blame: 'unknown', detail: err.replace(/\s+/g, ' ').slice(0, 200) }
}

function payOne(p, secretFile, payDir) {
  const url = `${BASE}${p.publicPath}`
  const args = [
    'tsx',
    join(payDir, 'run.ts'),
    url,
    '--method',
    p.method,
    '--body',
    JSON.stringify(p.body),
    '--secret-file',
    secretFile,
    '--network',
    'pubnet',
    '--max-auto',
    MAX_AUTO_USD,
    '--yes',
    '--json',
  ]
  try {
    const stdout = execFileSync('npx', args, {
      cwd: join(payDir, '../..'),
      encoding: 'utf8',
      timeout: 90000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let json = null
    try {
      json = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop())
    } catch {}
    // Redact before anything from the child can be stored/logged.
    return { ok: true, stdout: redactSecrets(stdout), stderr: '', json }
  } catch (e) {
    return {
      ok: false,
      stdout: redactSecrets(e.stdout?.toString() || ''),
      stderr: redactSecrets(e.stderr?.toString() || String(e.message || e)),
      json: null,
    }
  }
}

async function main() {
  const only = process.argv.slice(2)
  const targets = only.length ? PROVIDERS.filter((p) => only.includes(p.id)) : PROVIDERS

  // Health gate.
  const h = await fetch(`${BASE}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }))
  if (h?.status !== 'ok') {
    console.error('ROUTER UNHEALTHY, aborting real-money run:', JSON.stringify(h))
    process.exit(2)
  }
  console.error(`router OK  base=${BASE}  max-auto=$${MAX_AUTO_USD}/call\n`)

  // Resolve everything that can throw BEFORE extracting the secret, so the
  // 0600 temp key file is created only inside the try/finally that deletes
  // it. (If resolvePayPerCallDir threw after extraction, the key would leak.)
  const payDir = resolvePayPerCallDir()
  const { file: secretFile, dir: secretDir } = extractSecretFile()
  const results = []
  try {
    for (const p of targets) {
      process.stderr.write(`→ ${p.id} (${p.family}/${p.mode}) ${p.publicPath} ... `)
      const raw = payOne(p, secretFile, payDir)
      const c = classify(p, raw)
      results.push({ id: p.id, family: p.family, mode: p.mode, path: p.publicPath, ...c })
      process.stderr.write(`${c.verdict} [${c.blame}] ${c.detail}\n`)
    }
  } finally {
    rmSync(secretDir, { recursive: true, force: true })
  }

  console.error('\n=== E2E SUMMARY ===')
  // Only a strict PASS (200 + okCheck passed) is green. PASS_WEAK (200 but
  // body shape unexpected — unwrap/okCheck failed) is NOT success: it needs
  // a human look and must not let the suite exit 0.
  const pass = results.filter((r) => r.verdict === 'PASS')
  const weak = results.filter((r) => r.verdict === 'PASS_WEAK')
  const ourFault = results.filter((r) => r.blame === 'us')
  const merchantFault = results.filter((r) => r.blame === 'merchant')
  console.error(`PASS: ${pass.length}/${results.length}  (${pass.map((r) => r.id).join(', ') || 'none'})`)
  if (weak.length) console.error(`PASS_WEAK (200, body unexpected — verify): ${weak.map((r) => r.id).join(', ')}`)
  if (ourFault.length) console.error(`OUR BUG: ${ourFault.map((r) => `${r.id}(${r.detail})`).join('; ')}`)
  if (merchantFault.length) console.error(`MERCHANT: ${merchantFault.map((r) => r.id).join(', ')}`)

  // Machine-readable report to stdout.
  console.log(JSON.stringify({ base: BASE, ts: new Date().toISOString(), results }, null, 2))
  process.exit(pass.length === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
