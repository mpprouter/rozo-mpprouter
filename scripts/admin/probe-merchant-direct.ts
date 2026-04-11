#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/probe-merchant-direct.ts — bypass router, hit a
 * Tempo merchant directly with a tempo.session voucher signed by
 * the router's wallet. Used to debug whether a merchant 5xx is
 * the merchant's fault or the router's.
 *
 * Usage:
 *   MERCHANT_URL=https://anthropic.mpp.tempo.xyz/v1/messages \
 *     REQUEST_BODY='{"model":"claude-3-5-haiku-20241022","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}' \
 *     npx tsx scripts/admin/probe-merchant-direct.ts
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

function loadDevVars(): Record<string, string> {
  const path = resolve(REPO_ROOT, '.dev.vars')
  if (!existsSync(path)) throw new Error(`No .dev.vars at ${path}`)
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
  const merchantUrl = process.env.MERCHANT_URL
  if (!merchantUrl) throw new Error('Set MERCHANT_URL env')
  const requestBody = process.env.REQUEST_BODY ?? '{}'
  const method = process.env.METHOD ?? 'POST'

  const vars = loadDevVars()
  const pk = vars.TEMPO_ROUTER_PRIVATE_KEY
  if (!pk) throw new Error('No TEMPO_ROUTER_PRIVATE_KEY in .dev.vars')
  const account = privateKeyToAccount(pk as `0x${string}`)

  console.log(`Bypassing router, calling ${merchantUrl} directly with router wallet ${account.address}`)
  console.log(`Body: ${requestBody}`)
  console.log('')

  // Use auto-mode session manager to handle the 402 dance — this
  // mirrors what open-tempo-channel.ts does. maxDeposit caps it at
  // $1 so we don't accidentally drain the pool. The session manager
  // will reuse an existing channel if it finds one on-chain.
  const sm = tempo.session({
    account,
    decimals: 6,
    maxDeposit: '1',
  })

  console.log('→ Sending request via mppx auto-session...')
  let response: Awaited<ReturnType<typeof sm.fetch>>
  try {
    response = await sm.fetch(merchantUrl, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    })
  } catch (err: any) {
    console.error(`\n❌ mppx fetch threw: ${err.message}`)
    console.error(err.stack)
    process.exit(1)
  }

  console.log(`← HTTP ${response.status}`)
  console.log(`  channelId: ${sm.channelId ?? '(none)'}`)
  console.log(`  cumulative: ${sm.cumulative}`)
  console.log('')
  const text = await response.text()
  console.log(`  body (first 1000 chars):`)
  console.log(text.slice(0, 1000))
}

main().catch((err) => {
  console.error(err.message)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
