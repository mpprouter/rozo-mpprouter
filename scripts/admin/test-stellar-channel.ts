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

/**
 * Public router path to hit. Defaults to the original openrouter
 * dogfood path so existing test invocations keep working. The
 * 8-merchant batch (Task A) overrides this via env to test
 * anthropic_messages, openai_chat, gemini_generate, dune_execute,
 * modal_exec, alchemy_rpc, tempo_rpc, storage_upload.
 */
const ROUTE_PATH = process.env.ROUTE_PATH ?? '/v1/services/openrouter/chat'

/**
 * JSON request body to send to the merchant. Defaults to a tiny
 * OpenRouter chat completion shape so the original openrouter test
 * still works. For other merchants the caller MUST set REQUEST_BODY
 * to a body that the merchant accepts (or the merchant will return
 * a 4xx instead of a 200 even though the channel/voucher work).
 *
 * Examples (single line, no newlines, valid JSON):
 *   REQUEST_BODY='{"model":"claude-3-5-sonnet-latest","max_tokens":1,
 *                  "messages":[{"role":"user","content":"hi"}]}'
 *   REQUEST_BODY='{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber",
 *                  "params":[]}'
 */
const DEFAULT_REQUEST_BODY = JSON.stringify({
  model: 'openai/gpt-4o-mini',
  messages: [
    { role: 'user', content: 'Say "session hello" in 5 words.' },
  ],
})
const REQUEST_BODY_RAW = process.env.REQUEST_BODY ?? DEFAULT_REQUEST_BODY

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

  // Which agent to run the test as. Defaults to the original
  // dogfood agent (MAINNET_PAYER) for backwards compatibility;
  // the multi-agent test flow sets AGENT_ENV=AGENT2_SECRET or
  // AGENT3_SECRET to run as a different agent.
  const agentEnvKey = process.env.AGENT_ENV ?? 'MAINNET_PAYER_SECRET'
  const agentSecret = envVars[agentEnvKey]
  if (!agentSecret) {
    throw new Error(`${agentEnvKey} not in ${envDevPath}`)
  }
  const keypair = Keypair.fromSecret(agentSecret)
  const agentG = keypair.publicKey()
  console.log(`  (using ${agentEnvKey} from ${envDevPath})`)

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

  // Parse the request body now (not at module load time) so a
  // malformed REQUEST_BODY env shows a clear error to the operator.
  let body: unknown
  try {
    body = JSON.parse(REQUEST_BODY_RAW)
  } catch (err: any) {
    throw new Error(
      `REQUEST_BODY is not valid JSON: ${err.message}\n` +
        `value: ${REQUEST_BODY_RAW.slice(0, 200)}`,
    )
  }

  // V2 §6-D2 bootstrap hint: on the FIRST request the router has
  // no Authorization header to look at, so it doesn't know we
  // want stellar.channel mode. We advertise our intent + identity
  // via URL query params:
  //   ?payment=channel  → tells router to emit a stellar.channel
  //                       402 (not the default stellar.charge)
  //   &agent=G...       → tells router which agent we are, so it
  //                       can look up the right channel contract
  //                       in the `stellarAgent:<G>` KV index
  // Once the 402 comes back and the mppx client signs a voucher
  // the retry will carry Authorization: Payment <cred>, and the
  // router will re-extract the agent from credential.source —
  // the query param becomes redundant but stays on the URL
  // because mppx preserves URL when retrying. That's fine; both
  // lookups resolve to the same G and the same channel contract.
  const urlWithHint = new URL(`${ROUTER_URL}${ROUTE_PATH}`)
  urlWithHint.searchParams.set('payment', 'channel')
  urlWithHint.searchParams.set('agent', agentG)

  console.log(`→ POST ${urlWithHint.toString()}`)
  console.log(`  body: ${JSON.stringify(body)}`)
  console.log('')

  const start = Date.now()
  let response: Response
  try {
    response = await fetch(urlWithHint.toString(), {
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
