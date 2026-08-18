/**
 * Real-money verification of the refund fix (PR #93).
 *
 * MEASURED 2026-08-18, four paid calls on the deployed fix, all confirmed:
 *
 *   settlement                  refund tx      pool seq  latency
 *   e805c9c2 11:18:38Z          bcce6970       ...301     45s
 *   106880b2 11:22:47Z          98af3408       ...302    105s
 *   59d0e7fe 11:25:13Z          6c364b33       ...303     30s
 *   25f55261 11:25:35Z          522e7d3d       ...304     59s
 *
 * All four under the 2-minute target, sequences strictly incrementing with no
 * rejection and nothing parked, and every ledger row reached `refunded`. The
 * E2E wallet ended on its exact starting USDC balance: net cost $0.
 *
 * Makes a paid call whose merchant leg is expected to fail, then measures how
 * long the refund takes to confirm on chain and whether the public ledger row
 * flips from `refund_pending` to `refunded`.
 *
 * Reads STELLAR_SECRET from the environment only; never prints it.
 *
 * Usage: STELLAR_SECRET=S... node scripts/e2e/refund-timing-probe.mjs [label]
 */
import { Mppx } from 'mppx/client'
import { stellar } from '@stellar/mpp/charge/client'
import { Keypair } from '@stellar/stellar-sdk'

const BASE = 'https://apiserver.mpprouter.dev'
const PATH = '/v1/services/codex/graphql'
const label = process.argv[2] || 'call'

const secret = process.env.STELLAR_SECRET
if (!secret) throw new Error('STELLAR_SECRET is required')
const keypair = Keypair.fromSecret(secret)

// The router answers a 402 in BOTH dialects at once. The pinned mppx client
// (0.7.0) tries to decode the x402 `payment-required` header first and throws
// `InvalidJsonHeaderError` on the v2 shape the router now emits, before it
// ever looks at the `www-authenticate` MPP challenge it can actually satisfy.
// Strip that one header on the way back so the charge dialect is used. This
// only affects which challenge THIS probe answers; nothing is re-signed.
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init)
  if (response.status !== 402 || !response.headers.has('payment-required')) return response
  const headers = new Headers(response.headers)
  headers.delete('payment-required')
  return new Response(await response.arrayBuffer(), {
    status: response.status, statusText: response.statusText, headers,
  })
}

const mppx = Mppx.create({ methods: [stellar.charge({ keypair })], polyfill: false })

// The router itself rejects a body with no `query` string (400, pre-payment,
// costs nothing). So the query must be well-formed enough to pass the router
// and still be refused by the merchant: this one is syntactically valid but
// fails schema validation upstream, which GraphQL servers answer with a 4xx —
// a merchant-leg failure AFTER the charge dialect has already settled the
// customer's payment, which is exactly the shape that queues a refund.
const body = JSON.stringify({ query: '{ rozoRefundProbeFieldDoesNotExist }' })

const started = Date.now()
console.log(`[${label}] paying ${PATH} ...`)
const response = await mppx.fetch(`${BASE}${PATH}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
})
const text = await response.text()
const refundId = response.headers.get('refund-id')
console.log(JSON.stringify({
  label,
  status: response.status,
  paidInMs: Date.now() - started,
  refundId,
  refundStatus: response.headers.get('refund-status'),
  refundStatusUrl: response.headers.get('refund-status-url'),
  body: text.slice(0, 300),
}, null, 2))

if (!refundId) {
  console.log(`[${label}] NO REFUND QUEUED — merchant leg did not fail, or settlement never happened.`)
  process.exit(2)
}

// Poll the public refund status. It returns a signed receipt (with refund_tx)
// only once the on-chain return is confirmed.
const queuedAt = Date.now()
let receipt = null
for (let attempt = 0; attempt < 60; attempt += 1) {
  const status = await fetch(`${BASE}/v1/refunds/${refundId}`)
  const payload = await status.json()
  // While pending the endpoint returns a bare status object; once the return
  // confirms on chain it returns a SIGNED RECEIPT, whose fields live under
  // `receipt`. Detecting only a top-level `outcome` never sees the transition.
  if (payload.receipt) {
    receipt = payload.receipt
    break
  }
  if (attempt % 4 === 0) {
    console.log(`[${label}] t+${Math.round((Date.now() - queuedAt) / 1000)}s  ${payload.outcome ?? status.status}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 5000))
}

const elapsedS = Math.round((Date.now() - queuedAt) / 1000)
if (!receipt) {
  console.log(`[${label}] STILL PENDING after ${elapsedS}s`)
  process.exit(3)
}
console.log(`[${label}] REFUND CONFIRMED in ${elapsedS}s`)
console.log(JSON.stringify(receipt, null, 2))

if (receipt.payment_tx) {
  const ledger = await fetch(`${BASE}/v1/ledger?tx=${receipt.payment_tx}`)
  const row = await ledger.json()
  console.log(`[${label}] ledger row:`, JSON.stringify(row.entry ?? row))
}
