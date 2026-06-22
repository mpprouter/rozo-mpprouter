/**
 * Zero-cost 402 probe for the MPP Router provider suite.
 *
 * For every target provider: POST the lightest body WITHOUT paying and
 * read the 402 challenge. This verifies the quote layer end to end
 * (route exists → router issues a payment challenge → intent/amount/
 * pay_to look sane) WITHOUT spending a cent. It does NOT verify the
 * downstream settlement — only a real charge (pay-per-call) does that.
 *
 * Usage:
 *   node scripts/e2e/probe-402.mjs            # probe all providers
 *   node scripts/e2e/probe-402.mjs openai     # probe a subset
 *
 * Exit code 0 if every provider returned a usable 402 challenge (or a
 * clear non-payment error we can explain); non-zero if any route is
 * missing or the router itself is unhealthy.
 */

import { ROUTER_BASE, PROVIDERS } from './providers.mjs'

const only = process.argv.slice(2)
const targets = only.length ? PROVIDERS.filter((p) => only.includes(p.id)) : PROVIDERS

function classify(status, headers, bodyText) {
  const wwwAuth = headers.get('www-authenticate') || ''
  if (status === 402) {
    // Extract intent + amount from the challenge if present. In the MPP
    // dialect amount/pay_to live inside the base64 credential, not the
    // header, so we don't require them. But a usable challenge MUST carry
    // a recognized intent — without it the quote layer is degraded.
    const intent = /intent="?([a-z]+)"?/i.exec(wwwAuth)?.[1]?.toLowerCase()
    const amount = /amount="?([0-9.]+)"?/i.exec(wwwAuth)?.[1]
    if (intent !== 'charge' && intent !== 'session') {
      return {
        verdict: 'QUOTE_DEGRADED',
        detail: `402 but intent missing/unknown (got ${intent ?? 'none'}); www-authenticate=${wwwAuth.slice(0, 80) || 'empty'}`,
      }
    }
    return { verdict: 'QUOTE_OK', detail: `intent=${intent} amount=${amount ?? 'in-credential'}` }
  }
  if (status === 400 && /unknown public service route/i.test(bodyText)) {
    return { verdict: 'NO_ROUTE', detail: 'route not registered (needs overlay or wrong path)' }
  }
  if (status === 405) {
    return { verdict: 'WRONG_METHOD', detail: bodyText.slice(0, 120) }
  }
  if (status >= 500) {
    return { verdict: 'ROUTER_5XX', detail: `inbound layer broken: ${bodyText.slice(0, 120)}` }
  }
  return { verdict: `HTTP_${status}`, detail: bodyText.slice(0, 160) }
}

async function probeOne(p, path) {
  const url = `${ROUTER_BASE}${path}`
  try {
    const res = await fetch(url, {
      method: p.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p.body),
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    const c = classify(res.status, res.headers, text)
    return { status: res.status, ...c }
  } catch (e) {
    return { status: 0, verdict: 'NETWORK_ERR', detail: String(e?.message || e) }
  }
}

async function main() {
  // Health first.
  const h = await fetch(`${ROUTER_BASE}/health`, { signal: AbortSignal.timeout(15000) })
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }))
  if (h?.status !== 'ok') {
    console.error('ROUTER UNHEALTHY:', JSON.stringify(h))
    process.exit(2)
  }
  console.log(`router OK  pool=${h.stellar?.router_pool?.slice(0, 6)}...${h.stellar?.router_pool?.slice(-4)}\n`)

  let allOk = true
  const rows = []
  for (const p of targets) {
    // Probe the canonical (clean) path the suite wants.
    const r = await probeOne(p, p.publicPath)
    let row = { id: p.id, family: p.family, mode: p.mode, path: p.publicPath, ...r }
    rows.push(row)
    if (r.verdict !== 'QUOTE_OK') allOk = false
    const tag = r.verdict === 'QUOTE_OK' ? '✅' : '❌'
    console.log(`${tag} ${p.id.padEnd(11)} [${p.family}/${p.mode}] ${p.publicPath}`)
    console.log(`     HTTP ${r.status}  ${r.verdict}  ${r.detail}`)
  }

  console.log('\n--- summary ---')
  const ok = rows.filter((r) => r.verdict === 'QUOTE_OK').map((r) => r.id)
  const bad = rows.filter((r) => r.verdict !== 'QUOTE_OK').map((r) => `${r.id}(${r.verdict})`)
  console.log(`quote-layer OK (${ok.length}/${rows.length}): ${ok.join(', ') || 'none'}`)
  if (bad.length) console.log(`needs attention: ${bad.join(', ')}`)
  process.exit(allOk ? 0 : 1)
}

main()
