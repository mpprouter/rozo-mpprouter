#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/register-stellar-channel.ts — Register an
 * already-deployed Stellar channel contract into the router's KV.
 *
 * Prereq: the channel contract MUST already be deployed on
 * Stellar mainnet. Use scripts/admin/deploy-stellar-channel-for-agent.ts
 * to deploy one, or deploy it manually with the Stellar CLI.
 *
 * This script is a pure KV-write operation. It does NOT:
 *   - Read on-chain state
 *   - Verify the channel contract exists
 *   - Spend any funds
 *   - Check commitmentKey against the on-chain contract
 *
 * It trusts the operator's arguments. If you register a garbage
 * channel address, the router will happily try to verify against
 * it and mppx will fail the Soroban simulate at verify time.
 *
 * Usage:
 *   npx tsx scripts/admin/register-stellar-channel.ts \
 *     --channel C... \
 *     --agent G... \
 *     --commitment G... \
 *     --deposit 10000000
 *
 * Arguments:
 *   --channel    Soroban channel contract address (C..., 56 chars)
 *   --agent      Stellar G... address that funded the channel
 *                (will also be the value the router looks up from
 *                credential.source). V2 assumes this is the
 *                agent's account public key.
 *   --commitment Ed25519 public key (G... strkey form) that the
 *                channel contract enforces at verify time. Usually
 *                equals --agent (agent signs vouchers with its
 *                own account key).
 *   --deposit    Initial deposit in base units (stroops for XLM,
 *                or 7-decimal base units for Stellar USDC SAC).
 *                Informational only — the real balance lives on
 *                chain; this field is for inspect-channels.ts.
 *   --currency   (optional) Stellar SAC contract address of the
 *                token. Defaults to XLM native. For USDC use
 *                CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75
 *                (pubnet USDC SAC).
 *   --network    (optional) 'stellar:pubnet' or 'stellar:testnet'.
 *                Defaults to 'stellar:pubnet'.
 *
 * After running: verify with scripts/admin/inspect-channels.ts.
 * The Stellar channels section should show the new entry.
 */

import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

// ----------------------------------------------------------------------------
// Argument parsing (minimal, no external dep)
// ----------------------------------------------------------------------------

type Args = {
  channel: string
  agent: string
  commitment: string
  deposit: string
  currency: string
  network: string
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2)
  const values: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const val = args[i + 1]
    if (val === undefined || val.startsWith('--')) {
      console.error(`Missing value for --${key}`)
      process.exit(1)
    }
    values[key] = val
    i++
  }

  if (!values.channel || !values.agent || !values.commitment || !values.deposit) {
    console.error(
      'Usage: npx tsx scripts/admin/register-stellar-channel.ts \\\n' +
        '  --channel C... \\\n' +
        '  --agent G... \\\n' +
        '  --commitment G... \\\n' +
        '  --deposit <base-units> \\\n' +
        '  [--currency native|C...] \\\n' +
        '  [--network stellar:pubnet|stellar:testnet]',
    )
    process.exit(1)
  }

  // Validate Soroban contract address (starts with C, 56 chars)
  if (!/^C[A-Z2-7]{55}$/.test(values.channel)) {
    console.error(
      `--channel must be a 56-char Soroban contract address starting with C, got: ${values.channel}`,
    )
    process.exit(1)
  }
  // Validate agent + commitment are G addresses
  for (const field of ['agent', 'commitment'] as const) {
    if (!/^G[A-Z2-7]{55}$/.test(values[field])) {
      console.error(
        `--${field} must be a 56-char Stellar public key starting with G, got: ${values[field]}`,
      )
      process.exit(1)
    }
  }
  // Deposit must be a non-negative integer
  if (!/^\d+$/.test(values.deposit)) {
    console.error(
      `--deposit must be a non-negative integer in base units, got: ${values.deposit}`,
    )
    process.exit(1)
  }

  return {
    channel: values.channel,
    agent: values.agent,
    commitment: values.commitment,
    deposit: values.deposit,
    currency: values.currency ?? 'native',
    network: values.network ?? 'stellar:pubnet',
  }
}

// ----------------------------------------------------------------------------
// KV writer (shells out to wrangler, same pattern as open-tempo-channel.ts)
// ----------------------------------------------------------------------------

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
    } catch {
      // best-effort cleanup
    }
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv)

  console.log('Registering Stellar channel metadata in router KV')
  console.log(`  channel contract:  ${args.channel}`)
  console.log(`  agent account:     ${args.agent}`)
  console.log(`  commitment key:    ${args.commitment}`)
  console.log(`  deposit (raw):     ${args.deposit}`)
  console.log(`  currency:          ${args.currency}`)
  console.log(`  network:           ${args.network}`)
  console.log('')

  // Build the StellarChannelState record. The shape must match
  // src/mpp/stellar-channel-store.ts exactly.
  const state = {
    channelContract: args.channel,
    commitmentKey: args.commitment,
    agentAccount: args.agent,
    currency: args.currency,
    network: args.network,
    depositRaw: args.deposit,
    openedAt: new Date().toISOString(),
  }

  // Write the primary record.
  const primaryKey = `stellarChannel:${args.channel}`
  console.log(`→ Writing primary record: ${primaryKey}`)
  console.log(JSON.stringify(state, null, 2))
  console.log('')
  kvPut(primaryKey, JSON.stringify(state))
  console.log(`✅ Primary record written.\n`)

  // Write the agent-index secondary record (maps agent G → channel C).
  // This must stay in sync with putStellarChannel's behavior in
  // src/mpp/stellar-channel-store.ts. We write it as raw text
  // (the channel contract address) not JSON, to match what
  // getChannelForAgent expects.
  const agentIndexKey = `stellarAgent:${args.agent}`
  console.log(`→ Writing agent-index: ${agentIndexKey} → ${args.channel}`)
  kvPut(agentIndexKey, args.channel)
  console.log(`✅ Agent-index written.\n`)

  console.log('Next: run `npx tsx scripts/admin/inspect-channels.ts` to verify.')
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
