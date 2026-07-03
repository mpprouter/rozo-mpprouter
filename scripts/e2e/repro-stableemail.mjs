/**
 * Controlled, ZERO-COST reproduction of the stableemail/send
 * "Invalid base64 JSON header" 502 Argens reported.
 *
 * It drives the EXACT router charge path (mppx tempo.charge client →
 * client.fetch(merchantUrl)) against the live upstream merchant
 * https://stableemail.dev/api/send, and prints the full stack trace of
 * whatever mppx throws — so we can see WHICH decode step
 * (challenge / credential / settle-response) raises InvalidJsonHeaderError.
 *
 * SAFETY: uses a freshly generated, zero-balance EVM key. If mppx ever
 * reaches the on-chain broadcast step, it fails for "insufficient funds"
 * — it CANNOT move money. The InvalidJsonHeaderError we are chasing is
 * thrown during header decode, strictly before any broadcast, so a
 * zero-balance key is enough to reproduce it at zero cost.
 *
 * We compare against api.exa.ai/search (known-good charge) to prove the
 * harness itself works (exa should fail only at the broadcast/funds step,
 * NOT at header decode).
 *
 *   node scripts/e2e/repro-stableemail.mjs
 */

import { Mppx, tempo, Transport } from 'mppx/client'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// Fresh throwaway key — zero balance, cannot settle. Generated per run.
const throwaway = generatePrivateKey()
const account = privateKeyToAccount(throwaway)

// Mirror of src/mpp/tempo-client.ts sanitizeMerchant402Fetch — kept in
// sync by hand so this standalone repro can exercise the fix without
// importing the Env-coupled factory. If the prod sanitizer changes,
// update this too.
const EVM_CAIP2 = /^eip155:\d+$/
function parses(resp) {
  try {
    const t = Transport.http()
    if (t.getChallenges) t.getChallenges(resp)
    else t.getChallenge(resp)
    return true
  } catch {
    return false
  }
}
function sanitizeFetch(baseFetch) {
  return async (input, init) => {
    const response = await baseFetch(input, init)
    if (response.status !== 402) return response
    const pr = response.headers.get('payment-required')
    if (!pr) return response
    if (parses(response)) return response
    const hasWww = response.headers.has('www-authenticate')
    let rewritten = null
    try {
      const obj = JSON.parse(Buffer.from(pr, 'base64').toString('utf8'))
      if (obj && Array.isArray(obj.accepts)) {
        const filtered = obj.accepts.filter(
          (a) => typeof a?.network === 'string' && EVM_CAIP2.test(a.network),
        )
        if (filtered.length > 0 && filtered.length < obj.accepts.length) {
          const h = new Headers(response.headers)
          h.set('payment-required', Buffer.from(JSON.stringify({ ...obj, accepts: filtered })).toString('base64'))
          rewritten = new Response(response.body, { status: 402, statusText: response.statusText, headers: h })
        }
      }
    } catch {}
    if (rewritten && parses(rewritten)) return rewritten
    if (hasWww) {
      const h = new Headers(response.headers)
      h.delete('payment-required')
      return new Response(response.body, { status: 402, statusText: response.statusText, headers: h })
    }
    return response
  }
}

function buildChargeClient({ sanitized }) {
  return Mppx.create({
    methods: [tempo.charge({ account })],
    polyfill: false,
    ...(sanitized ? { fetch: sanitizeFetch(globalThis.fetch) } : {}),
  })
}

async function run(label, url, body, { sanitized } = { sanitized: false }) {
  console.log(`\n=== ${label} ${sanitized ? '[WITH FIX]' : '[NO FIX]'}  ${url} ===`)
  const client = buildChargeClient({ sanitized })
  try {
    const res = await client.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    console.log(`  fetch resolved: HTTP ${res.status}`)
    const txt = await res.text()
    console.log('  body:', txt.slice(0, 200))
  } catch (err) {
    console.log(`  THREW: ${err?.name}: ${err?.message}`)
    // Is this THE error Argens sees?
    if (/Invalid base64 JSON header/i.test(err?.message || '')) {
      console.log('  >>> MATCH: this is the "Invalid base64 JSON header" error <<<')
    }
    // Print the stack so we see which mppx module/decoder raised it.
    const stack = (err?.stack || '').split('\n').slice(0, 16).join('\n')
    console.log('  stack:\n' + stack.replace(/^/gm, '    '))
    // If mppx attaches a cause (decode failures often do), surface it.
    if (err?.cause) {
      console.log('  cause:', err.cause?.name, err.cause?.message)
    }
  }
}

const SE = ['STABLEEMAIL', 'https://stableemail.dev/api/send', { to: 'x@example.com', subject: 'x', body: 'x' }]
const EXA = ['EXA', 'https://api.exa.ai/search', { query: 'hello' }]

// 1. Reproduce the bug (no fix): both should throw InvalidJsonHeaderError.
await run(...SE, { sanitized: false })
await run(...EXA, { sanitized: false })

// 2. With the fix: decode must NO LONGER throw. The fetch should now get
//    past challenge parsing and fail LATER (no funds / no balance) — that
//    proves the "Invalid base64 JSON header" is gone. Any throw here must
//    NOT be InvalidJsonHeaderError.
console.log('\n----- WITH FIX (sanitizer) -----')
await run(...SE, { sanitized: true })
await run(...EXA, { sanitized: true })

console.log('\n(done — no money moved; throwaway key had zero balance)')
