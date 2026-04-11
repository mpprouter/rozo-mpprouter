#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/test-stellar-channel.ts
 *
 * Send a real session+session request through the deployed router:
 *   agent ──(stellar.channel voucher)──▶ router ──(tempo.session)──▶ OpenRouter
 *
 * The agent identity comes from stellar-mpp-sdk/.env.dev
 * (MAINNET_PAYER_SECRET), the same account that funded the
 * Stellar channel contract via deploy-stellar-channel-for-agent.ts.
 *
 * Flow:
 *   1. Load MAINNET_PAYER_SECRET, construct a Stellar Keypair.
 *      The agent uses its own account key as both the signer
 *      and the commitmentKey (matching what the deploy script
 *      passed as --commitment_key).
 *   2. Build an Mppx client with @stellar/mpp/channel/client's
 *      stellar.channel() method. This polyfills global fetch so
 *      any subsequent fetch() call transparently handles 402
 *      challenges by signing a voucher against the router's
 *      channel contract.
 *   3. POST /v1/services/openrouter/chat with a small chat body.
 *      Expected flow:
 *        a) Router probes OpenRouter, gets tempo.session 402.
 *        b) Router returns stellar.channel 402 to us (bound to
 *           our channel contract, which the router looked up
 *           via stellarAgent:<G> → stellarChannel:<C>).
 *        c) Mppx client signs voucher using commitmentKey,
 *           retries with Authorization: Payment <cred>.
 *        d) Router verifies voucher, bumps Stellar cumulative,
 *           pays OpenRouter via tempo.session, returns content.
 *   4. Print the response.
 *
 * Unlike the SDK's examples/channel-client.ts, this script:
 *   - Targets the deployed router at mpprouter.eng3798.workers.dev
 *     (not a local Express server)
 *   - Uses MAINNET_PAYER account (not testnet keys)
 *   - Does not explicitly open — the channel was pre-deployed
 *     by deploy-stellar-channel-for-agent.ts
 *
 * Usage:
 *   npx tsx scripts/admin/test-stellar-channel.ts
 */

import { readFileSync, existsSync } from 'node:fs'
import { Keypair } from '@stellar/stellar-sdk'
import { Mppx } from 'mppx/client'
import { stellar } from '@stellar/mpp/channel/client'

const ROUTER_URL =
  process.env.ROUTER_URL ?? 'https://mpprouter.eng3798.workers.dev'
const ROUTE_PATH = '/v1/services/openrouter/chat'

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

async function main() {
  const envDevPath =
    '/Users/happyfish/workspace/stellar/stellar-mpp-sdk/.env.dev'
  const envVars = loadEnvFile(envDevPath)
  const agentSecret = envVars.MAINNET_PAYER_SECRET
  if (!agentSecret) {
    throw new Error(`MAINNET_PAYER_SECRET not in ${envDevPath}`)
  }
  const keypair = Keypair.fromSecret(agentSecret)
  const agentG = keypair.publicKey()

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Stellar channel → Tempo session — full session+session E2E')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Agent (commitmentKey): ${agentG}`)
  console.log(`  Router URL:            ${ROUTER_URL}${ROUTE_PATH}`)
  console.log('')

  // Polyfill global fetch. Any subsequent fetch() call in this
  // process will transparently handle stellar.channel 402
  // challenges by signing a voucher.
  Mppx.create({
    methods: [
      stellar.channel({
        commitmentKey: keypair,
        sourceAccount: agentG,
        onProgress(event: any) {
          const ts = new Date().toISOString().slice(11, 23)
          switch (event.type) {
            case 'challenge':
              console.log(
                `[${ts}] 💳 402 challenge: amount=${event.amount}, channel=${event.channel.slice(0, 12)}...`,
              )
              console.log(
                `[${ts}]    new cumulative will be: ${event.cumulativeAmount}`,
              )
              break
            case 'signing':
              console.log(`[${ts}] ✍️  signing commitment…`)
              break
            case 'signed':
              console.log(
                `[${ts}] ✅ signed (cumulative=${event.cumulativeAmount})`,
              )
              break
          }
        },
      }),
    ],
  })

  const body = {
    model: 'openai/gpt-4o-mini',
    messages: [
      { role: 'user', content: 'Say "session hello" in 5 words.' },
    ],
  }

  console.log(`→ POST ${ROUTER_URL}${ROUTE_PATH}`)
  console.log(`  body: ${JSON.stringify(body)}`)
  console.log('')

  const start = Date.now()
  let response: Response
  try {
    response = await fetch(`${ROUTER_URL}${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err: any) {
    console.error(`\n❌ Request failed: ${err.message}`)
    if (err.stack) console.error(err.stack)
    process.exit(1)
  }
  const elapsed = Date.now() - start

  console.log('')
  console.log(`← HTTP ${response.status} in ${elapsed}ms`)
  const receipt = response.headers.get('payment-receipt')
  if (receipt) console.log(`  Payment-Receipt: ${receipt}`)
  const text = await response.text()
  try {
    const json = JSON.parse(text)
    console.log('  ── Response ──')
    console.log(JSON.stringify(json, null, 2).slice(0, 2000))
  } catch {
    console.log(`  body: ${text.slice(0, 1000)}`)
  }

  if (!response.ok) {
    console.error('\n❌ Non-2xx response.')
    process.exit(1)
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════')
  console.log('  ✅ Session+session E2E succeeded.')
  console.log('  Next: run `npx tsx scripts/admin/inspect-channels.ts`')
  console.log('        to verify both Stellar and Tempo cumulatives advanced.')
  console.log('═══════════════════════════════════════════════════════')
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
