#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/seed-channel-cumulatives.ts — One-time KV → DO migration.
 *
 * Reads all `stellar:channel:cumulative:*` keys from production KV and
 * seeds them into the AtomicStoreDO via POST /admin/seed-atomic-store.
 *
 * The DO /seed handler is IDEMPOTENT and NON-DESTRUCTIVE:
 *   • If the DO already has a value for that key (e.g. the live payment path
 *     already wrote it after deploy) → no change, returns { seeded: false }.
 *   • If the key is absent in the DO → writes it, returns { seeded: true }.
 * Running this script twice is safe.
 *
 * Usage (after `wrangler deploy` has been run):
 *   ADMIN_SECRET=<value> npx tsx scripts/admin/seed-channel-cumulatives.ts
 *
 *   Or with PAYINVOICE_ADMIN_SECRET set in your environment (or .dev.vars):
 *   npx tsx scripts/admin/seed-channel-cumulatives.ts
 *
 * The admin secret is read from (in priority order):
 *   1. ADMIN_SECRET env var
 *   2. PAYINVOICE_ADMIN_SECRET env var
 *   3. PAYINVOICE_ADMIN_SECRET key in .dev.vars
 *
 * The production Worker URL defaults to https://mpprouter.rozo.ai but can be
 * overridden with WORKER_URL env var.
 *
 * Skipped keys:
 *   stellar:charge:challenge:* — short-lived replay keys (expire in minutes,
 *   accepted migration skip; no voucher replay risk once the DO is live).
 *
 * Example output:
 *   Discovered 3 stellar:channel:cumulative:* keys in KV
 *
 *   [1/3] stellar:channel:cumulative:CAQG...6HVW
 *         KV value: {"amount":"56424"}
 *         → seeded: true
 *
 *   [2/3] stellar:channel:cumulative:CAYS...N6UW
 *         KV value: {"amount":"105500"}
 *         → seeded: true
 *
 *   [3/3] stellar:channel:cumulative:CCMI...S5CW
 *         KV value: {"amount":"63924"}
 *         → seeded: true
 *
 *   Done. 3 seeded, 0 already existed, 0 errors.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

// ── Config ────────────────────────────────────────────────────────────────────

const CUMULATIVE_PREFIX = 'stellar:channel:cumulative:'
const DEFAULT_WORKER_URL = 'https://mpprouter.rozo.ai'

// ── .dev.vars loader (same as inspect-channels.ts) ───────────────────────────

function loadDevVars(): Record<string, string> {
  const path = resolve(REPO_ROOT, '.dev.vars')
  try {
    const raw = readFileSync(path, 'utf8')
    const out: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function getAdminSecret(): string {
  // 1. Explicit override (useful for CI or one-off runs)
  if (process.env.ADMIN_SECRET) return process.env.ADMIN_SECRET
  // 2. Standard env var name
  if (process.env.PAYINVOICE_ADMIN_SECRET) return process.env.PAYINVOICE_ADMIN_SECRET
  // 3. .dev.vars fallback
  const devVars = loadDevVars()
  if (devVars.PAYINVOICE_ADMIN_SECRET) return devVars.PAYINVOICE_ADMIN_SECRET
  throw new Error(
    'Admin secret not found. Set ADMIN_SECRET or PAYINVOICE_ADMIN_SECRET in env or .dev.vars.',
  )
}

// ── KV helpers (same pattern as inspect-channels.ts) ─────────────────────────

function kvList(prefix: string): string[] {
  try {
    const out = execSync(
      `npx wrangler kv key list --binding MPP_STORE --prefix '${prefix}' --remote`,
      { encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const firstBracket = out.indexOf('[')
    if (firstBracket === -1) return []
    const parsed = JSON.parse(out.slice(firstBracket)) as Array<{ name: string }>
    return parsed.map((k) => k.name)
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() ?? ''
    if (stderr.includes('not found')) return []
    throw new Error(`wrangler kv list failed: ${err.message}\n${stderr}`)
  }
}

function kvGet(key: string): string | null {
  try {
    const out = execSync(
      `npx wrangler kv key get --binding MPP_STORE '${key}' --remote`,
      { encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return out.length > 0 ? out : null
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() ?? ''
    if (
      stderr.includes('Value not found') ||
      stderr.includes('404: Not Found') ||
      stderr.includes('not found') ||
      err.message?.includes('404')
    ) {
      return null
    }
    throw new Error(`wrangler kv get failed for '${key}': ${err.message}\n${stderr}`)
  }
}

// ── Display helper: mask middle of a long key, keep prefix + last 4 ──────────

function shortKey(key: string): string {
  // Show the full prefix (stellar:channel:cumulative:) then abbreviated address.
  const prefixEnd = key.indexOf(':', 'stellar:channel:cumulative:'.length - 1)
  const addrPart = key.slice(CUMULATIVE_PREFIX.length)
  if (addrPart.length <= 12) return key
  return `${CUMULATIVE_PREFIX}${addrPart.slice(0, 6)}...${addrPart.slice(-4)}`
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const workerUrl = process.env.WORKER_URL ?? DEFAULT_WORKER_URL
  const adminSecret = getAdminSecret() // throws if missing
  const seedEndpoint = `${workerUrl}/admin/seed-atomic-store`

  console.log(`\n=== Stellar channel cumulative KV → DO seed migration ===`)
  console.log(`  Worker:   ${workerUrl}`)
  console.log(`  Endpoint: POST /admin/seed-atomic-store`)
  console.log(`  Secret:   (loaded from env / .dev.vars — not printed)\n`)

  // Discover all cumulative keys in KV.
  console.log(`Listing KV keys with prefix '${CUMULATIVE_PREFIX}' ...`)
  const keys = kvList(CUMULATIVE_PREFIX)

  if (keys.length === 0) {
    console.log('  No cumulative keys found in KV. Nothing to migrate.')
    return
  }

  console.log(`Discovered ${keys.length} key(s):\n`)

  // Read all values from KV up front so we can show a clear before/after.
  type KvEntry = { key: string; value: string }
  const kvEntries: KvEntry[] = []

  for (const key of keys) {
    const value = kvGet(key)
    if (value === null) {
      console.warn(`  WARNING: key '${shortKey(key)}' exists in listing but has no value. Skipping.`)
      continue
    }
    kvEntries.push({ key, value: value.trim() })
  }

  if (kvEntries.length === 0) {
    console.log('All discovered keys had empty values. Nothing to seed.')
    return
  }

  // POST all entries to the seed endpoint in a single request.
  // The route processes them sequentially inside the Worker.
  console.log(`Posting ${kvEntries.length} entr${kvEntries.length === 1 ? 'y' : 'ies'} to ${seedEndpoint} ...\n`)

  let resp: globalThis.Response
  try {
    resp = await fetch(seedEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-secret': adminSecret,
      },
      body: JSON.stringify({ entries: kvEntries }),
    })
  } catch (err: any) {
    throw new Error(`Network error calling ${seedEndpoint}: ${err?.message ?? 'unknown'}`)
  }

  if (resp.status === 401) {
    throw new Error('401 Unauthorized — check that x-admin-secret matches PAYINVOICE_ADMIN_SECRET.')
  }
  if (resp.status === 500) {
    const body = await resp.text()
    throw new Error(`Worker returned 500: ${body}`)
  }
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Worker returned ${resp.status}: ${body}`)
  }

  const data = (await resp.json()) as { results: Array<{ key: string; seeded: boolean; reason?: string }> }

  let nSeeded = 0
  let nExisted = 0
  let nError = 0

  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i]
    // Find the original KV value for display (amounts are not secrets).
    const kv = kvEntries.find((e) => e.key === r.key)
    console.log(`[${i + 1}/${data.results.length}] ${shortKey(r.key)}`)
    if (kv) {
      console.log(`      KV value: ${kv.value}`)
    }
    if (r.seeded) {
      console.log(`      → seeded: true`)
      nSeeded++
    } else if (r.reason === 'exists') {
      console.log(`      → already exists in DO (live path wrote it first) — no change`)
      nExisted++
    } else {
      console.log(`      → unexpected result: ${JSON.stringify(r)}`)
      nError++
    }
    console.log('')
  }

  console.log(
    `Done. ${nSeeded} seeded, ${nExisted} already existed (no change), ${nError} unexpected.\n`,
  )

  if (nError > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
