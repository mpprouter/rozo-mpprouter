#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/deploy-stellar-channel-for-agent.ts
 *
 * Deploys a one-way Stellar payment channel contract on mainnet
 * with the router as recipient, using the agent's MAINNET_PAYER
 * account (from .dev.vars) as both the funder and the commitment
 * key. Then writes the resulting metadata to MPP_STORE so the
 * router's dispatch path can verify vouchers from this agent.
 *
 * This is the "one-button bootstrap" for the dogfood case where
 * the operator and the test agent are the same entity. For real
 * multi-tenant production use, the agent would deploy its own
 * channel (using its own XLM for gas) and hand the contract
 * address + commitment public key to the operator out-of-band;
 * the operator would then run scripts/admin/register-stellar-channel.ts.
 *
 * What this script spends (from MAINNET_PAYER account):
 *   - Soroban resource fee for `contract upload` (~1-2 XLM)
 *   - Soroban resource fee for `contract deploy` (~1-2 XLM)
 *   - The channel deposit (--deposit, default 1000000 stroops = 0.1 XLM)
 *
 * Total: ~2-5 XLM. The deposit is recoverable via channel close
 * after the test is done; the resource fees are not.
 *
 * Prerequisites:
 *   - stellar CLI installed (cargo install --locked stellar-cli)
 *     verified path: /Users/happyfish/.cargo/bin/stellar
 *   - `stellar network ls` shows `mainnet`
 *   - WASM_PATH env var OR default path at
 *     /Users/happyfish/workspace/stellar/one-way-channel/target/wasm32v1-none/release/channel.wasm
 *   - .dev.vars contains MAINNET_PAYER_SECRET (via stellar-mpp-sdk/.env.dev or similar)
 *     and STELLAR_ROUTER_PUBLIC
 *   - MAINNET_PAYER account has ≥ 5 XLM for gas + deposit
 *
 * Usage:
 *   npx tsx scripts/admin/deploy-stellar-channel-for-agent.ts [--deposit 1000000]
 *
 * Arguments:
 *   --deposit N        Initial channel deposit in stroops (1 XLM = 10^7 stroops).
 *                      Default: 1000000 (0.1 XLM ≈ $0.012 at current XLM price).
 *   --wasm PATH        Override WASM_PATH env var.
 *   --dry-run          Print what we WOULD do; do not upload, deploy, or write KV.
 *
 * The router uses XLM (native) as the channel token for V2 dogfood.
 * USDC SAC support is a V2.1 follow-up once we confirm the XLM path
 * works end-to-end.
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
// .dev.vars loader — we read MAINNET_PAYER_SECRET from the stellar-mpp-sdk
// .env.dev file (same pattern the charge PAY=1 test uses).
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

const DEFAULT_WASM_PATH =
  '/Users/happyfish/workspace/stellar/one-way-channel/target/wasm32v1-none/release/channel.wasm'
const DEFAULT_DEPOSIT_STROOPS = '1000000' // 0.1 XLM
const REFUND_WAITING_PERIOD_LEDGERS = '100'
/**
 * Stellar mainnet native XLM Soroban Asset Contract (SAC) address.
 * Soroban contracts refer to native XLM via a specific SAC instance,
 * not the string "native" (that would be a Stellar account alias).
 * Verify with: `stellar contract id asset --asset native --network mainnet`
 */
const MAINNET_NATIVE_XLM_SAC = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'

type Args = {
  deposit: string
  wasm: string
  token: string
  wasmHash: string | undefined
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2)
  const out: Args = {
    deposit: DEFAULT_DEPOSIT_STROOPS,
    wasm: process.env.WASM_PATH ?? DEFAULT_WASM_PATH,
    token: MAINNET_NATIVE_XLM_SAC,
    // Allow skipping the upload step and going straight to deploy
    // with an already-uploaded WASM hash. Useful on retry after a
    // deploy failure — avoids paying the upload gas again.
    wasmHash: process.env.WASM_HASH,
    dryRun: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--deposit') {
      out.deposit = args[++i]
    } else if (a === '--wasm') {
      out.wasm = args[++i]
    } else if (a === '--wasm-hash') {
      out.wasmHash = args[++i]
    } else if (a === '--token') {
      out.token = args[++i]
    } else if (a === '--dry-run') {
      out.dryRun = true
    }
  }
  if (!/^\d+$/.test(out.deposit)) {
    console.error(`--deposit must be a non-negative integer (stroops), got: ${out.deposit}`)
    process.exit(1)
  }
  if (!existsSync(out.wasm)) {
    console.error(`WASM file not found: ${out.wasm}`)
    console.error('Build the one-way-channel contract first:')
    console.error('  git clone https://github.com/stellar-experimental/one-way-channel')
    console.error('  cd one-way-channel && stellar contract build')
    process.exit(1)
  }
  return out
}

// ----------------------------------------------------------------------------
// Stellar CLI helpers
// ----------------------------------------------------------------------------

/**
 * Run a stellar CLI command and return the stdout as string.
 * Passes the MAINNET_PAYER secret via --source-account. Secret is
 * passed directly to the CLI (no shell history leak) because we
 * use spawnSync with args array instead of a shell string.
 */
function runStellar(args: string[], secret: string): string {
  const proc = spawnSync('stellar', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      // Let the CLI pick up secret via env if it wants, but we
      // also pass it explicitly via --source-account in args.
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
// KV writer — inline rather than shelling to register script so
// deploy + register is one atomic operator action. Reuses the
// wrangler CLI with a temp-file path to avoid shell quoting hell.
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

  // Load MAINNET_PAYER_SECRET from stellar-mpp-sdk/.env.dev (the
  // dogfood account we use for PAY=1 tests).
  const envDevPath = '/Users/happyfish/workspace/stellar/stellar-mpp-sdk/.env.dev'
  const envVars = loadEnvFile(envDevPath)
  const agentSecret = envVars.MAINNET_PAYER_SECRET
  if (!agentSecret) {
    throw new Error(`MAINNET_PAYER_SECRET not found in ${envDevPath}`)
  }

  // Load router public key from rozo-mpprouter/.dev.vars.
  const routerVars = loadEnvFile(resolve(REPO_ROOT, '.dev.vars'))
  const routerPublic = routerVars.STELLAR_ROUTER_PUBLIC
  if (!routerPublic) {
    throw new Error('STELLAR_ROUTER_PUBLIC not found in .dev.vars')
  }

  // Derive the agent's G address from its secret.
  const agentKp = Keypair.fromSecret(agentSecret)
  const agentG = agentKp.publicKey()
  // For V2 dogfood we use the agent's own account key as the
  // commitment key. This means the raw ed25519 public key bytes
  // that the channel contract stores as commitment_key are
  // exactly agentKp.rawPublicKey(). That same key can then
  // verify vouchers signed by agentKp.sign(...).
  //
  // The Stellar CLI's --commitment_key argument takes the raw
  // 32-byte key as hex (see demo/run-channel-e2e.sh line 127-138
  // in stellar-mpp-sdk for the reference usage).
  const commitmentPubHex = Buffer.from(agentKp.rawPublicKey()).toString('hex')

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Deploy Stellar Channel — agent ↔ router (mainnet)')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Agent funder:     ${agentG}`)
  console.log(`  Router recipient: ${routerPublic}`)
  console.log(`  Commitment key:   ${commitmentPubHex.slice(0, 16)}...`)
  console.log(`  Token SAC:        ${args.token}`)
  console.log(`  Deposit:          ${args.deposit} stroops (${Number(args.deposit) / 1e7} XLM)`)
  console.log(`  WASM file:        ${args.wasm}`)
  if (args.wasmHash) {
    console.log(`  WASM hash (reuse): ${args.wasmHash}`)
  }
  console.log(`  Network:          mainnet`)
  console.log('')

  if (args.dryRun) {
    console.log('[dry-run] Would now: stellar contract upload --wasm ...')
    console.log('[dry-run] Would now: stellar contract deploy --wasm-hash ... with constructor args:')
    console.log(`  token=${args.token} from=${agentG} commitment_key=<hex> to=${routerPublic} amount=${args.deposit} refund_waiting_period=${REFUND_WAITING_PERIOD_LEDGERS}`)
    console.log('[dry-run] Would now: write stellarChannel:<C> and stellarAgent:<G> to KV')
    console.log('\nNo on-chain or KV writes performed.')
    return
  }

  // Step 1: Upload the WASM (unless operator supplied a reusable
  // hash via --wasm-hash or WASM_HASH env — e.g. on retry after a
  // deploy-phase failure, avoiding paying upload gas twice).
  let wasmHash: string
  if (args.wasmHash) {
    console.log('═══ Step 1: skipped — reusing supplied WASM hash ═══')
    wasmHash = args.wasmHash
    console.log(`  Reusing: ${wasmHash}`)
  } else {
    console.log('═══ Step 1: stellar contract upload ═══')
    wasmHash = runStellar(
      [
        'contract',
        'upload',
        '--wasm',
        args.wasm,
        '--source-account',
        agentSecret,
        '--network',
        'mainnet',
      ],
      agentSecret,
    )
    console.log(`  ✅ WASM hash: ${wasmHash}`)
  }
  console.log('')

  // Step 2: Deploy the channel contract with constructor args.
  // The `token` arg is a Soroban Asset Contract (SAC) address, NOT
  // the literal string "native" — Stellar CLI resolves address
  // args by looking up account aliases, and "native" would be
  // parsed as an alias and fail. Use MAINNET_NATIVE_XLM_SAC
  // (`stellar contract id asset --asset native --network mainnet`)
  // for XLM, or a Stellar USDC SAC contract address for USDC.
  console.log('═══ Step 2: stellar contract deploy ═══')
  const contractAddress = runStellar(
    [
      'contract',
      'deploy',
      '--wasm-hash',
      wasmHash,
      '--source-account',
      agentSecret,
      '--network',
      'mainnet',
      '--',
      '--token',
      args.token,
      '--from',
      agentG,
      '--commitment_key',
      commitmentPubHex,
      '--to',
      routerPublic,
      '--amount',
      args.deposit,
      '--refund_waiting_period',
      REFUND_WAITING_PERIOD_LEDGERS,
    ],
    agentSecret,
  )
  console.log(`  ✅ Channel contract: ${contractAddress}`)
  console.log('')

  // Step 3: Write router KV records (primary + agent-index).
  // Must stay in sync with putStellarChannel in
  // src/mpp/stellar-channel-store.ts.
  console.log('═══ Step 3: Register in router KV ═══')
  const state = {
    channelContract: contractAddress,
    // commitmentKey in KV is the G-strkey form (router will
    // accept it as-is via stellar.channel({ commitmentKey: G... })
    // because the SDK parses both G-strkey and Keypair).
    commitmentKey: agentG,
    agentAccount: agentG,
    // Persist the actual SAC contract address used by this
    // channel, so inspect-channels.ts can show it and future
    // migrations to USDC / other tokens are unambiguous.
    currency: args.token,
    network: 'stellar:pubnet',
    depositRaw: args.deposit,
    openedAt: new Date().toISOString(),
  }

  const primaryKey = `stellarChannel:${contractAddress}`
  console.log(`→ ${primaryKey}`)
  console.log(JSON.stringify(state, null, 2))
  kvPut(primaryKey, JSON.stringify(state))
  console.log(`  ✅ Primary written`)
  console.log('')

  const agentIdxKey = `stellarAgent:${agentG}`
  console.log(`→ ${agentIdxKey} → ${contractAddress}`)
  kvPut(agentIdxKey, contractAddress)
  console.log(`  ✅ Agent-index written`)
  console.log('')

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Deploy + register complete.')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Explorer: https://stellar.expert/explorer/public/contract/${contractAddress}`)
  console.log('')
  console.log('Next: run `npx tsx scripts/admin/inspect-channels.ts` to verify.')
  console.log('Then: deploy router with `wrangler deploy` and test with stellar-mpp-sdk channel-client.')
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
