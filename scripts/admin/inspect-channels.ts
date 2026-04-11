#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/inspect-channels.ts — Read-only ledger view.
 *
 * Pure observation. No signing, no writes, no on-chain actions.
 * Safe to run as many times as you want; worst case is you spam
 * Horizon + Tempo RPC with a few GETs.
 *
 * Usage:
 *   npx tsx scripts/admin/inspect-channels.ts
 *
 * What it prints:
 *   1. Stellar pool USDC balance (via Horizon)
 *   2. Tempo pool USDC balance (via mppx's public account helper,
 *      or a raw eth_call on the asset handle)
 *   3. Every KV entry under `tempoChannel:*` with deposit +
 *      cumulative + remaining
 *   4. Placeholder for §6 stellar channel entries (not V2
 *      initial)
 *   5. Net position (T1 - T2 + chain cash)
 *
 * See internaldocs/v2-full-session-design.md §7 for the
 * accounting model this script implements.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ----------------------------------------------------------------------------
// .dev.vars loader (same pattern as tests/)
// ----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

function loadDevVars(): Record<string, string> {
  const path = resolve(REPO_ROOT, '.dev.vars')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(
      `Could not read ${path}. Copy .dev.vars.example (or ask the ` +
        `operator) and populate STELLAR_ROUTER_PUBLIC, TEMPO_ROUTER_ADDRESS.`,
    )
  }
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
}

// ----------------------------------------------------------------------------
// KV reader (shells out to wrangler)
// ----------------------------------------------------------------------------

/**
 * List all KV keys under a given prefix via `wrangler kv key list`.
 * wrangler prints JSON to stdout when invoked non-interactively.
 *
 * Returns an empty array if the binding is empty (not an error).
 */
function kvList(prefix: string): string[] {
  try {
    const out = execSync(
      `npx wrangler kv key list --binding MPP_STORE --prefix '${prefix}' --remote`,
      { encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    // wrangler's output: either pure JSON array or JSON with leading
    // "Listing ..." human text. Strip any non-JSON prefix.
    const firstBracket = out.indexOf('[')
    if (firstBracket === -1) return []
    const json = out.slice(firstBracket)
    const parsed = JSON.parse(json) as Array<{ name: string }>
    return parsed.map((k) => k.name)
  } catch (err: any) {
    // wrangler exits non-zero on "binding not found" vs "no keys".
    // In practice an empty list for a valid binding returns `[]`
    // and exit 0. Any other error we surface.
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
    // wrangler prints the raw value on stdout, or "Value not found"
    // on stderr if the key doesn't exist. If stdout is empty, the
    // key exists but has an empty value — treat as null.
    return out.length > 0 ? out : null
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() ?? ''
    if (stderr.includes('not found') || stderr.includes('Value not found')) {
      return null
    }
    throw new Error(`wrangler kv get failed for ${key}: ${err.message}\n${stderr}`)
  }
}

// ----------------------------------------------------------------------------
// Stellar pool balance (Horizon)
// ----------------------------------------------------------------------------

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
// Per wrangler.toml: STELLAR_NETWORK=stellar:pubnet. Horizon is
// the Stellar mainnet indexer.
const HORIZON_BASE = 'https://horizon.stellar.org'

type HorizonBalance = {
  asset_type: string
  asset_code?: string
  asset_issuer?: string
  balance: string
}

async function getStellarPoolUsdc(publicKey: string): Promise<string> {
  const res = await fetch(`${HORIZON_BASE}/accounts/${publicKey}`)
  if (!res.ok) {
    return `(horizon ${res.status})`
  }
  const account = (await res.json()) as { balances: HorizonBalance[] }
  const usdc = account.balances.find(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER,
  )
  if (!usdc) return '0.0000000 (no USDC trustline)'
  return `${usdc.balance} USDC`
}

// ----------------------------------------------------------------------------
// Tempo pool balance (RPC)
// ----------------------------------------------------------------------------

/**
 * Tempo L2 stores stablecoins as "asset handles" — a 32-byte
 * pseudo-address whose first 12 bytes are zero and whose last 8
 * bytes encode the native asset id. From the mpp.dev catalog, the
 * canonical Tempo USDC handle is
 * `0x20c000000000000000000000b9537d11c60e8b50`.
 *
 * Tempo RPC exposes a `tempo_getBalance(address, asset)` method
 * for native handles, which is what mppx's internal balance helper
 * uses. We call it directly here to avoid importing mppx's
 * non-public paths into a read-only inspection script.
 *
 * If that RPC method doesn't exist / errors, we fall back to
 * printing "(unavailable)" rather than crashing. The chain is
 * informational for this script, not load-bearing.
 */
const TEMPO_USDC_HANDLE = '0x20c000000000000000000000b9537d11c60e8b50'
const TEMPO_RPC = 'https://rpc.tempo.xyz'

async function getTempoPoolUsdc(address: string): Promise<string> {
  // First try: tempo_getBalance — the native-asset-aware method.
  try {
    const res = await fetch(TEMPO_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tempo_getBalance',
        params: [address, TEMPO_USDC_HANDLE],
      }),
    })
    if (res.ok) {
      const json = (await res.json()) as {
        result?: string
        error?: { message?: string }
      }
      if (json.result) {
        // Hex wei-style → BigInt → 6-decimal USDC string.
        const raw = BigInt(json.result)
        return `${formatUnits(raw, 6)} USDC`
      }
      if (json.error) {
        // tempo_getBalance not supported; fall through.
      }
    }
  } catch {
    // fall through
  }

  // Second try: eth_call on the asset handle as if it were an
  // ERC-20. This works on Tempo's EVM-compatibility layer for
  // wrapped assets.
  try {
    // balanceOf(address) selector = 0x70a08231
    const data = '0x70a08231' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    const res = await fetch(TEMPO_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_call',
        params: [{ to: TEMPO_USDC_HANDLE, data }, 'latest'],
      }),
    })
    if (res.ok) {
      const json = (await res.json()) as { result?: string }
      if (json.result && json.result !== '0x') {
        const raw = BigInt(json.result)
        return `${formatUnits(raw, 6)} USDC`
      }
    }
  } catch {
    // fall through
  }

  return '(unavailable — need a Tempo balance helper)'
}

/**
 * BigInt → human-readable decimal string with given decimals.
 * Mirrors `baseUnitsToDecimalString` from src/routes/proxy.ts
 * but operates on bigint directly.
 */
function formatUnits(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString()
  const neg = raw < 0n
  const abs = neg ? -raw : raw
  const s = abs.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  const body = frac.length === 0 ? whole : `${whole}.${frac}`
  return neg ? `-${body}` : body
}

// ----------------------------------------------------------------------------
// Tempo channel state parsing
// ----------------------------------------------------------------------------

type TempoChannelState = {
  channelId: string
  escrowContract: string
  payee: string
  currency: string
  chainId: number
  authorizedSigner: string
  cumulativeRaw: string
  depositRaw: string
  openedAt: string
  lastVoucherAt?: string
}

function shortHex(h: string, head = 6, tail = 4): string {
  if (h.length <= head + tail + 3) return h
  return `${h.slice(0, head)}…${h.slice(-tail)}`
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const vars = loadDevVars()
  const stellarPublic = vars.STELLAR_ROUTER_PUBLIC
  const tempoAddress = vars.TEMPO_ROUTER_ADDRESS
  if (!stellarPublic) throw new Error('Missing STELLAR_ROUTER_PUBLIC in .dev.vars')
  if (!tempoAddress) throw new Error('Missing TEMPO_ROUTER_ADDRESS in .dev.vars')

  const now = new Date().toISOString()
  console.log(`=== ROUTER LEDGER @ ${now} ===\n`)

  // Pool balances (queried in parallel for a faster TTFB on the
  // operator's terminal)
  console.log('Pool balances (chain):')
  const [stellarUsdc, tempoUsdc] = await Promise.all([
    getStellarPoolUsdc(stellarPublic),
    getTempoPoolUsdc(tempoAddress),
  ])
  console.log(`  Stellar ${stellarPublic}:`)
  console.log(`           ${stellarUsdc}`)
  console.log(`  Tempo   ${tempoAddress}:`)
  console.log(`           ${tempoUsdc}`)
  console.log('')

  // Tempo channels
  console.log('--- Tempo channels (router → merchant) ---')
  const tempoKeys = kvList('tempoChannel:')
  if (tempoKeys.length === 0) {
    console.log('  (no channels installed)')
  } else {
    console.log(
      '  merchant              channelId       deposit     cumulative  remaining   last',
    )
    let totalDepositRaw = 0n
    let totalCumulativeRaw = 0n
    for (const key of tempoKeys.sort()) {
      const merchantId = key.slice('tempoChannel:'.length)
      const raw = kvGet(key)
      if (!raw) {
        console.log(`  ${merchantId.padEnd(20)} (empty value)`)
        continue
      }
      let state: TempoChannelState
      try {
        state = JSON.parse(raw) as TempoChannelState
      } catch (err: any) {
        console.log(`  ${merchantId.padEnd(20)} (parse error: ${err.message})`)
        continue
      }
      const deposit = BigInt(state.depositRaw)
      const cumulative = BigInt(state.cumulativeRaw)
      const remaining = deposit - cumulative
      totalDepositRaw += deposit
      totalCumulativeRaw += cumulative
      const last = state.lastVoucherAt
        ? state.lastVoucherAt.slice(11, 19)
        : '-'
      console.log(
        `  ${merchantId.padEnd(20)} ${shortHex(state.channelId).padEnd(14)} ` +
          `${formatUnits(deposit, 6).padStart(10)}  ${formatUnits(cumulative, 6).padStart(10)}  ` +
          `${formatUnits(remaining, 6).padStart(10)}  ${last}`,
      )
    }
    console.log(
      `  ${'TOTAL'.padEnd(20)} ${`${tempoKeys.length} channels`.padEnd(14)} ` +
        `${formatUnits(totalDepositRaw, 6).padStart(10)}  ${formatUnits(totalCumulativeRaw, 6).padStart(10)}`,
    )
  }
  console.log('')

  // Stellar channels — §6 stretch, not yet deployed
  console.log('--- Stellar channels (agent → router) ---')
  const stellarKeys = kvList('stellarChannel:')
  if (stellarKeys.length === 0) {
    console.log('  (V2 §6 not yet deployed — none expected)')
  } else {
    // Forward-compat: if anyone hand-writes a stellarChannel entry
    // before §6 ships, show it.
    for (const key of stellarKeys) {
      const raw = kvGet(key) ?? '(empty)'
      console.log(`  ${key}: ${raw.slice(0, 100)}`)
    }
  }
  console.log('')

  // Position summary — simplified because we don't parse chain
  // strings back to bigint here (stellarUsdc is a free-form
  // string from Horizon). Operator eyeballs the relationship.
  console.log('--- Position ---')
  console.log(`  Stellar pool:          ${stellarUsdc}`)
  console.log(`  Tempo pool:            ${tempoUsdc}`)
  console.log(`  Tempo channels open:   ${tempoKeys.length}`)
  console.log(`  Stellar channels open: ${stellarKeys.length}`)
  console.log('')
  console.log('(Net position math lands in V2.1 when we parse the pool')
  console.log(' strings back to bigint. For now: eyeball that pool +')
  console.log(' locked deposits ≈ initial float.)')
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
