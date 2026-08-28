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
  const path = process.env.DEV_VARS_PATH || resolve(REPO_ROOT, '.dev.vars')
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

  const maskedAddress = `${account.address.slice(0, 6)}...${account.address.slice(-4)}`

  // Record the exact unpaid quote independently. Never print the full auth
  // challenge: it can contain merchant-specific opaque values.
  const quoteResponse = await fetch(merchantUrl, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
  })
  const challenge = quoteResponse.headers.get('www-authenticate') || ''
  const encodedRequest = challenge.match(/request="([^"]+)"/i)?.[1]
  let amount: string | null = null
  if (encodedRequest) {
    try {
      const decoded = JSON.parse(Buffer.from(encodedRequest, 'base64url').toString('utf8'))
      amount = typeof decoded.amount === 'string' ? decoded.amount : String(decoded.amount ?? '') || null
    } catch { /* malformed merchant challenge */ }
  }
  console.log(JSON.stringify({ event: 'merchant_probe_quote', merchant: new URL(merchantUrl).hostname, payer: maskedAddress, status: quoteResponse.status, amount_atomic_6dp: amount }))

  // Use auto-mode session manager to handle the 402 dance — this
  // mirrors what open-tempo-channel.ts does. maxDeposit caps it at
  // $1 so we don't accidentally drain the pool. The session manager
  // will reuse an existing channel if it finds one on-chain.
  // mppx 0.7.0: methods are registered on an Mppx client; tempo.charge is the
  // stateless per-call intent (what the router's playground path uses).
  const sm = Mppx.create({
    methods: [tempo.charge({ account })],
    polyfill: false,
  }) as any

  let response: Response
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

  const text = await response.text()
  let parsed: Record<string, any> = {}
  try { parsed = JSON.parse(text) } catch { /* non-JSON response */ }
  const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : null
  const responseKeys = Object.keys(parsed).slice(0, 20)
  const nested = parsed.result && typeof parsed.result === 'object' ? parsed.result as Record<string, any> : null
  console.log(JSON.stringify({
    event: 'merchant_probe_result',
    merchant: new URL(merchantUrl).hostname,
    status: response.status,
    model: typeof parsed.model === 'string' ? parsed.model : null,
    usage: usage ?? nested?.usage ?? null,
    has_choices: (Array.isArray(parsed.choices) && parsed.choices.length > 0) ||
      (Array.isArray(nested?.choices) && nested.choices.length > 0),
    response_keys: responseKeys,
    nested_result_keys: nested ? Object.keys(nested).slice(0, 20) : null,
    error: parsed.error ?? null,
    response_preview: text.slice(0, 500),
  }))
}

main().catch((err) => {
  console.error(err.message)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
