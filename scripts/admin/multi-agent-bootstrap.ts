#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/multi-agent-bootstrap.ts
 *
 * One-shot bootstrap for the multi-agent V2 §6 test:
 *
 *   1. Generate agent2 + agent3 Stellar keypairs (ed25519 random).
 *   2. Append them to stellar-mpp-sdk/.env.dev (gitignored file).
 *   3. From MAINNET_PAYER, send one transaction with TWO createAccount
 *      operations — 5 XLM each — to agent2 and agent3.
 *   4. From agent2 (now funded), submit changeTrust for USDC. Agent2
 *      must sign this itself (Stellar protocol requirement).
 *   5. From agent3 (also funded), submit changeTrust for USDC. Agent3
 *      is XLM-denominated in its CHANNEL, but V2 §6 Stellar.charge
 *      support is USDC-only on the router side, so agent3 still needs
 *      a USDC trust line + a small USDC balance to exercise the charge
 *      test path. This is the "B2" decision from 2026-04-11: agent3
 *      keeps XLM purity on its CHANNEL, but accepts a tiny USDC top-up
 *      for the charge-mode smoke test.
 *   6. From MAINNET_PAYER, send ONE transaction with TWO payment ops:
 *      0.2 USDC → agent2 (enough for 0.1 deposit + 0.1 charge smoke)
 *      0.05 USDC → agent3 (enough for one charge smoke test)
 *   7. Print a report. No KV writes, no channel deploys — those are
 *      separate scripts (deploy-stellar-channel-for-agent.ts).
 *
 * This script spends REAL mainnet funds from MAINNET_PAYER:
 *   - ~10 XLM in createAccount
 *   - ~0.25 USDC in payment
 *   - A few stroops in tx fees
 *
 * If ANY step fails, the script aborts and reports which step blew up.
 * Re-running is safe for append-to-.env.dev (duplicates are written
 * but don't break anything) but NOT safe for the on-chain steps — a
 * second run would either fail (account exists) or re-fund agents
 * that are already loaded.
 *
 * Usage:
 *   npx tsx scripts/admin/multi-agent-bootstrap.ts           # real run
 *   npx tsx scripts/admin/multi-agent-bootstrap.ts --dry-run # keypair+env only, skip chain
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import {
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc as sorobanRpc,
  Horizon,
} from '@stellar/stellar-sdk'

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

const ENV_DEV_PATH =
  '/Users/happyfish/workspace/stellar/stellar-mpp-sdk/.env.dev'
const HORIZON_URL = 'https://horizon.stellar.org'
const NETWORK_PASSPHRASE = Networks.PUBLIC

/**
 * Circle USDC on Stellar mainnet. Issuer is the Circle-controlled
 * account; we verified this earlier via MAINNET_PAYER's existing
 * USDC balance record.
 */
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC_ASSET = new Asset('USDC', USDC_ISSUER)

const AGENT2_FUND_XLM = '5'
const AGENT3_FUND_XLM = '5'
const AGENT2_USDC_TOPUP = '0.2'
const AGENT3_USDC_TOPUP = '0.05'

// Base fee well above the network minimum to avoid the "insufficient
// fee" race on busy ledgers. Each fee unit is 1 stroop (1e-7 XLM),
// and a 200 stroop/op fee is still fractions of a cent. TransactionBuilder
// multiplies this by the op count automatically.
const BASE_FEE = '200'

// ----------------------------------------------------------------------------
// .env.dev loader + writer
// ----------------------------------------------------------------------------

function loadEnvDev(): Record<string, string> {
  const raw = readFileSync(ENV_DEV_PATH, 'utf8')
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

function appendAgentToEnvDev(label: string, kp: Keypair): void {
  const now = new Date().toISOString()
  const block = [
    '',
    `# ${label} — generated ${now} by scripts/admin/multi-agent-bootstrap.ts`,
    `# Purpose: multi-agent E2E test for rozo-mpprouter V2 §6`,
    `${label}_PUBLIC=${kp.publicKey()}`,
    `${label}_SECRET=${kp.secret()}`,
    '',
  ].join('\n')
  appendFileSync(ENV_DEV_PATH, block)
}

// ----------------------------------------------------------------------------
// Stellar helpers
// ----------------------------------------------------------------------------

/**
 * Build a Horizon client for reads and tx submission. We use Horizon
 * rather than Soroban RPC because these operations are classic
 * Stellar (not contract invocations) and Horizon exposes
 * submitTransaction directly.
 */
const horizon = new Horizon.Server(HORIZON_URL)

async function loadAccount(publicKey: string) {
  return await horizon.loadAccount(publicKey)
}

/**
 * Wrap horizon.submitTransaction with a useful error message.
 * Horizon 400s carry the real reason inside response.data.extras
 * — by default the SDK surfaces a generic "Request failed with
 * status code 400" which is useless for debugging.
 */
async function submit(
  builder: TransactionBuilder,
  signers: Keypair[],
  label: string,
) {
  const tx = builder.setTimeout(180).build()
  for (const signer of signers) tx.sign(signer)
  try {
    const result = await horizon.submitTransaction(tx)
    console.log(`  ✅ ${label} — tx ${result.hash}`)
    return result
  } catch (err: any) {
    const extras = err?.response?.data?.extras
    const resultCodes = extras?.result_codes
    const envelope = extras?.envelope_xdr
    console.error(`  ❌ ${label} failed`)
    if (resultCodes) {
      console.error(`     result_codes: ${JSON.stringify(resultCodes)}`)
    }
    if (extras?.result_xdr) {
      console.error(`     result_xdr:   ${extras.result_xdr}`)
    }
    if (envelope) {
      console.error(`     envelope:     ${envelope.slice(0, 120)}...`)
    }
    throw err
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Multi-agent bootstrap for V2 §6 verification')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  env.dev:      ${ENV_DEV_PATH}`)
  console.log(`  Horizon:      ${HORIZON_URL}`)
  console.log(`  Network:      ${NETWORK_PASSPHRASE}`)
  console.log(`  USDC issuer:  ${USDC_ISSUER}`)
  console.log(`  Dry run:      ${dryRun}`)
  console.log('')

  // Load MAINNET_PAYER secret
  const envVars = loadEnvDev()
  const mainnetPayerSecret = envVars.MAINNET_PAYER_SECRET
  if (!mainnetPayerSecret) {
    throw new Error('MAINNET_PAYER_SECRET not found in .env.dev')
  }
  const mainnetPayerKp = Keypair.fromSecret(mainnetPayerSecret)

  // ─── Step 1: Generate keypairs ────────────────────────────────────
  console.log('═══ Step 1: Generate agent2 + agent3 keypairs ═══')
  const agent2 = Keypair.random()
  const agent3 = Keypair.random()
  console.log(`  agent2 G: ${agent2.publicKey()}`)
  console.log(`  agent3 G: ${agent3.publicKey()}`)
  console.log('')

  // ─── Step 2: Save to .env.dev ─────────────────────────────────────
  console.log('═══ Step 2: Append to .env.dev (gitignored) ═══')
  appendAgentToEnvDev('AGENT2', agent2)
  appendAgentToEnvDev('AGENT3', agent3)
  console.log(`  ✅ wrote AGENT2_PUBLIC / AGENT2_SECRET / AGENT3_PUBLIC / AGENT3_SECRET`)
  console.log('')

  if (dryRun) {
    console.log('[dry-run] Skipping on-chain steps.')
    return
  }

  // ─── Step 3: MAINNET_PAYER → both agents (single tx, 2 createAccount ops) ─
  console.log('═══ Step 3: Fund agents from MAINNET_PAYER ═══')
  console.log(`  Source: ${mainnetPayerKp.publicKey()}`)
  console.log(`  To:     agent2 ${agent2.publicKey()}  (${AGENT2_FUND_XLM} XLM)`)
  console.log(`          agent3 ${agent3.publicKey()}  (${AGENT3_FUND_XLM} XLM)`)
  const mpAcct = await loadAccount(mainnetPayerKp.publicKey())
  const fundBuilder = new TransactionBuilder(mpAcct, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.createAccount({
        destination: agent2.publicKey(),
        startingBalance: AGENT2_FUND_XLM,
      }),
    )
    .addOperation(
      Operation.createAccount({
        destination: agent3.publicKey(),
        startingBalance: AGENT3_FUND_XLM,
      }),
    )
  await submit(fundBuilder, [mainnetPayerKp], 'createAccount ×2')
  console.log('')

  // ─── Step 4: Agent2 changeTrust USDC ──────────────────────────────
  console.log('═══ Step 4: agent2 changeTrust USDC ═══')
  const agent2Acct = await loadAccount(agent2.publicKey())
  const trust2Builder = new TransactionBuilder(agent2Acct, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
  await submit(trust2Builder, [agent2], 'agent2 changeTrust USDC')
  console.log('')

  // ─── Step 5: Agent3 changeTrust USDC ──────────────────────────────
  // B2 decision (2026-04-11): agent3's CHANNEL is XLM, but we still
  // add a USDC trust line so agent3 can participate in the charge
  // smoke test (router charge is USDC-only). See script header.
  console.log('═══ Step 5: agent3 changeTrust USDC (for charge smoke test) ═══')
  const agent3Acct = await loadAccount(agent3.publicKey())
  const trust3Builder = new TransactionBuilder(agent3Acct, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
  await submit(trust3Builder, [agent3], 'agent3 changeTrust USDC')
  console.log('')

  // ─── Step 6: MAINNET_PAYER → agent2 + agent3 USDC payments ────────
  console.log('═══ Step 6: Top up USDC from MAINNET_PAYER ═══')
  console.log(`  To: agent2 (${AGENT2_USDC_TOPUP} USDC)`)
  console.log(`      agent3 (${AGENT3_USDC_TOPUP} USDC)`)
  // Reload MAINNET_PAYER to get the fresh sequence number after step 3.
  const mpAcct2 = await loadAccount(mainnetPayerKp.publicKey())
  const usdcBuilder = new TransactionBuilder(mpAcct2, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: agent2.publicKey(),
        asset: USDC_ASSET,
        amount: AGENT2_USDC_TOPUP,
      }),
    )
    .addOperation(
      Operation.payment({
        destination: agent3.publicKey(),
        asset: USDC_ASSET,
        amount: AGENT3_USDC_TOPUP,
      }),
    )
  await submit(usdcBuilder, [mainnetPayerKp], 'USDC payment ×2')
  console.log('')

  // ─── Step 7: Verify end state ─────────────────────────────────────
  console.log('═══ Step 7: Verify balances ═══')
  for (const [label, kp] of [
    ['agent2', agent2] as const,
    ['agent3', agent3] as const,
  ]) {
    const acct = await loadAccount(kp.publicKey())
    const native = acct.balances.find((b: any) => b.asset_type === 'native')
    const usdc = acct.balances.find(
      (b: any) => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER,
    )
    console.log(
      `  ${label}: XLM=${native?.balance ?? '—'}, USDC=${usdc?.balance ?? '—'}`,
    )
  }
  console.log('')

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Bootstrap complete. Next steps:')
  console.log('  1. npx tsx scripts/admin/deploy-stellar-channel-for-agent.ts \\')
  console.log('       --agent-env AGENT2_SECRET \\')
  console.log('       --token CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75 \\')
  console.log('       --deposit 1000000  # 0.1 USDC at 7 decimals')
  console.log('  2. npx tsx scripts/admin/deploy-stellar-channel-for-agent.ts \\')
  console.log('       --agent-env AGENT3_SECRET \\')
  console.log('       --wasm-hash ab3bb0da02d07610872b4a2f5dbbe9cf0a40e0544f63981097604f9d08d2a164 \\')
  console.log('       --deposit 1000000  # 0.1 XLM')
  console.log('  3. npx tsx scripts/admin/test-stellar-channel.ts  # with AGENT_ENV switch')
  console.log('═══════════════════════════════════════════════════════')
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
