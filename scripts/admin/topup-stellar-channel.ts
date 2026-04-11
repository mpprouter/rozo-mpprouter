#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/topup-stellar-channel.ts
 *
 * Top up an EXISTING Stellar payment channel by calling the
 * one-way-channel contract's `top_up(amount)` method. The funder
 * (the agent) signs the call and tokens move from the funder
 * account into the channel contract escrow on-chain.
 *
 * After the on-chain top-up succeeds, this script also rewrites
 * the `stellarChannel:<C>` KV record so `depositRaw` reflects the
 * NEW total deposit (old depositRaw + amount). The router uses
 * `depositRaw` only for the inspect-channels.ts display — mppx's
 * own monotone cumulative tracker is the real solvency guard —
 * but operators will be confused if the KV value drifts from the
 * chain, so we keep them in sync.
 *
 * Costs:
 *   - Soroban resource fee: ~0.001-0.01 XLM (just one contract
 *     invoke, no deploy)
 *   - The top-up amount itself (transferred from agent to channel)
 *
 * Usage:
 *   npx tsx scripts/admin/topup-stellar-channel.ts \
 *     --channel <C...> \
 *     --amount <stroops> \
 *     [--agent-env AGENT2_SECRET]
 *
 * Examples:
 *   # Add 0.1 XLM (1000000 stroops) to agent2's channel
 *   npx tsx scripts/admin/topup-stellar-channel.ts \
 *     --channel CAYS2LBUNO4STPRWVJ6H4LOCSWGQCFINAWIHID2GX67UDK3EJ4JJN6UW \
 *     --amount 1000000 \
 *     --agent-env AGENT2_SECRET
 *
 *   # Add 0.5 XLM to agent3's XLM channel
 *   npx tsx scripts/admin/topup-stellar-channel.ts \
 *     --channel CAQGTDOJKLWMLPY7BXP3TTCQONGME2JK3JE6MLII24XUDQQXZPX6HVWC \
 *     --amount 5000000 \
 *     --agent-env AGENT3_SECRET
 *
 * Arguments:
 *   --channel C...   Soroban channel contract address (required)
 *   --amount N       Top-up amount in base units (stroops for XLM,
 *                    USDC base units for USDC channels — both use 7
 *                    decimals on Stellar)
 *   --agent-env KEY  Env var name in stellar-mpp-sdk/.env.dev that
 *                    holds the agent's S... secret. Defaults to
 *                    MAINNET_PAYER_SECRET.
 *   --dry-run        Print what would happen, do nothing.
 *
 * Prerequisites:
 *   - The agent identified by --agent-env must equal the channel's
 *     `from` address (only the funder can top up). The script does
 *     NOT verify this on-chain — it relies on the Soroban contract
 *     reverting if you try to top up someone else's channel.
 *   - For USDC channels, the agent must have a USDC trustline AND
 *     enough USDC balance.
 *   - For XLM channels, the agent must have enough XLM (top-up
 *     amount + Soroban fees).
 *   - The channel must exist in MPP_STORE under
 *     `stellarChannel:<C...>`. The script reads it to find the
 *     current depositRaw and currency, then writes back the new
 *     depositRaw.
 */

import { execSync, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { Keypair } from '@stellar/stellar-sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

// ----------------------------------------------------------------------------
// env file loader (same shape as other admin scripts)
// ----------------------------------------------------------------------------

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    throw new Error(`env file not found: ${path}`)
  }
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
}

// ----------------------------------------------------------------------------
// Argument parsing
// ----------------------------------------------------------------------------

type Args = {
  channel: string
  amount: string
  agentEnvKey: string
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2)
  const out: Args = {
    channel: '',
    amount: '',
    agentEnvKey: 'MAINNET_PAYER_SECRET',
    dryRun: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--channel') out.channel = args[++i]
    else if (a === '--amount') out.amount = args[++i]
    else if (a === '--agent-env') out.agentEnvKey = args[++i]
    else if (a === '--dry-run') out.dryRun = true
  }
  if (!out.channel || !/^C[A-Z2-7]{55}$/.test(out.channel)) {
    console.error('--channel <C...> is required and must be a Soroban contract address')
    process.exit(1)
  }
  if (!out.amount || !/^\d+$/.test(out.amount)) {
    console.error('--amount <stroops> is required and must be a non-negative integer')
    process.exit(1)
  }
  if (out.amount === '0') {
    console.error('--amount must be > 0 (top_up with 0 is a no-op)')
    process.exit(1)
  }
  return out
}

// ----------------------------------------------------------------------------
// Stellar CLI helpers
// ----------------------------------------------------------------------------

function runStellar(args: string[], secret: string): string {
  const proc = spawnSync('stellar', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      STELLAR_ACCOUNT: secret,
    },
  })
  if (proc.status !== 0) {
    throw new Error(
      `stellar CLI failed (exit ${proc.status}):\n` +
        `stderr: ${proc.stderr}\n` +
        `stdout: ${proc.stdout}`,
    )
  }
  return proc.stdout.trim()
}

// ----------------------------------------------------------------------------
// KV helpers (shell out to wrangler)
// ----------------------------------------------------------------------------

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
      stderr.includes('not found')
    ) {
      return null
    }
    throw new Error(`wrangler kv get failed: ${err.message}\n${stderr}`)
  }
}

function kvPut(key: string, value: string): void {
  const tmpFile = resolve(tmpdir(), `mpp-kv-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(tmpFile, value)
  try {
    execSync(
      `npx wrangler kv key put --binding MPP_STORE '${key}' --path '${tmpFile}' --remote`,
      { encoding: 'utf8', cwd: REPO_ROOT, stdio: 'inherit' },
    )
  } finally {
    try {
      unlinkSync(tmpFile)
    } catch {}
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv)

  // Load agent secret from stellar-mpp-sdk/.env.dev (same convention
  // as deploy-stellar-channel-for-agent.ts).
  const envDevPath = '/Users/happyfish/workspace/stellar/stellar-mpp-sdk/.env.dev'
  const envVars = loadEnvFile(envDevPath)
  const agentSecret = envVars[args.agentEnvKey]
  if (!agentSecret) {
    throw new Error(`${args.agentEnvKey} not found in ${envDevPath}`)
  }
  const agentKp = Keypair.fromSecret(agentSecret)
  const agentG = agentKp.publicKey()

  // Read the existing KV record so we can:
  //   1. Know the current depositRaw (to compute the new total)
  //   2. Sanity-check that the agent matches state.agentAccount
  const kvKey = `stellarChannel:${args.channel}`
  const raw = kvGet(kvKey)
  if (!raw) {
    throw new Error(
      `KV record ${kvKey} not found. Either the channel was never registered ` +
        `or the contract address is wrong. Run inspect-channels.ts to list known channels.`,
    )
  }
  type StellarState = {
    channelContract: string
    commitmentKey: string
    agentAccount: string
    currency: string
    network: string
    depositRaw: string
    openedAt: string
  }
  const state = JSON.parse(raw) as StellarState
  if (state.agentAccount !== agentG) {
    throw new Error(
      `Agent mismatch: --agent-env ${args.agentEnvKey} resolves to ${agentG} ` +
        `but channel ${args.channel} was opened by ${state.agentAccount}. ` +
        `Only the original funder can top up.`,
    )
  }

  const oldDeposit = BigInt(state.depositRaw)
  const topUp = BigInt(args.amount)
  const newDeposit = oldDeposit + topUp

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Top up Stellar channel — agent ↔ router (mainnet)')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Channel:        ${args.channel}`)
  console.log(`  Currency SAC:   ${state.currency}`)
  console.log(`  Funder:         ${agentG}`)
  console.log(`  Old deposit:    ${oldDeposit.toString()} (${Number(oldDeposit) / 1e7} XLM-equiv)`)
  console.log(`  Top-up amount:  ${topUp.toString()} (${Number(topUp) / 1e7} XLM-equiv)`)
  console.log(`  New deposit:    ${newDeposit.toString()} (${Number(newDeposit) / 1e7} XLM-equiv)`)
  console.log('')

  if (args.dryRun) {
    console.log('[dry-run] Would invoke: stellar contract invoke')
    console.log(`            ${args.channel} -- top_up --amount ${args.amount}`)
    console.log(`[dry-run] Would update KV ${kvKey} depositRaw -> ${newDeposit.toString()}`)
    return
  }

  // Step 1: Invoke top_up on the channel contract.
  console.log('═══ Step 1: stellar contract invoke top_up ═══')
  const out = runStellar(
    [
      'contract',
      'invoke',
      '--id',
      args.channel,
      '--source-account',
      agentSecret,
      '--network',
      'mainnet',
      '--send=yes',
      '--',
      'top_up',
      '--amount',
      args.amount,
    ],
    agentSecret,
  )
  console.log(`  ✅ Top-up call succeeded.`)
  if (out) console.log(`  CLI output: ${out}`)
  console.log('')

  // Step 2: Update the KV sidecar so inspect-channels.ts shows the
  // new deposit. The cumulative tracker (mppx's own key) is
  // unchanged — vouchers signed before AND after the top-up still
  // count against the same monotone watermark.
  console.log('═══ Step 2: Update router KV depositRaw ═══')
  const newState: StellarState = { ...state, depositRaw: newDeposit.toString() }
  kvPut(kvKey, JSON.stringify(newState))
  console.log(`  ✅ KV updated: ${kvKey} depositRaw -> ${newState.depositRaw}`)
  console.log('')

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Top up complete.')
  console.log('═══════════════════════════════════════════════════════')
  console.log('')
  console.log('Next: run `npx tsx scripts/admin/inspect-channels.ts` to verify.')
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
