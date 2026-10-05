#!/usr/bin/env node
// Mint an internal rozotest_ payment id for native checkout testing.
// Usage: ROZO_TEST_LINK_SECRET=... node scripts/mint-test-invoice.mjs <usd>
// The secret is read from the environment only and never printed.
// Prints the id, then the checkout.rozo.ai test link (test mode banner; the
// payer pays real money, the bridge payout runs, the merchant side is skipped).
import { createHmac, randomBytes } from 'node:crypto'

const secret = process.env.ROZO_TEST_LINK_SECRET
if (!secret) { console.error('ROZO_TEST_LINK_SECRET is required'); process.exit(1) }
const cents = Math.round(Number(process.argv[2] ?? '1') * 100)
if (!Number.isInteger(cents) || cents < 1 || cents > 2000) { console.error('usd must be between 0.01 and 20'); process.exit(1) }
const nonce = randomBytes(8).toString('hex')
const sig = createHmac('sha256', secret).update(`${cents}.${nonce}`).digest('hex').slice(0, 16)
const id = `rozotest_${cents}_${nonce}_${sig}`
console.log(id)
console.log(`https://checkout.rozo.ai/test-invoice/${id}`)
