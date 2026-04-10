/**
 * Test client: Stellar agent → MPP Router → Tempo merchant
 *
 * Usage:
 *   STELLAR_SECRET=S... npx tsx test/test-client.ts
 *
 * This simulates what a Stellar agent would do:
 *   1. Create an mppx client with Stellar charge method
 *   2. Fetch through the MPP Router proxy
 *   3. The SDK handles the 402 dance automatically
 */

import { Mppx } from 'mppx/client'
import { stellar } from '@stellar/mpp/charge/client'
import { Keypair } from '@stellar/stellar-sdk'

const ROUTER_URL = process.env.ROUTER_URL || 'https://apiserver.mpprouter.dev'
const STELLAR_SECRET = process.env.STELLAR_SECRET

if (!STELLAR_SECRET) {
  console.error('Usage: STELLAR_SECRET=S... npx tsx test/test-client.ts')
  console.error('')
  console.error('The Stellar account needs:')
  console.error('  - XLM for base reserve')
  console.error('  - USDC trustline')
  console.error('  - USDC balance (at least $0.01)')
  process.exit(1)
}

const keypair = Keypair.fromSecret(STELLAR_SECRET)
console.log(`Agent address: ${keypair.publicKey()}`)
console.log(`Router URL: ${ROUTER_URL}`)
console.log('')

// Create mppx client with Stellar charge method
const mppx = Mppx.create({
  methods: [
    stellar.charge({
      keypair,
      // network and rpcUrl will be inferred from the 402 challenge
    }),
  ],
  polyfill: false,
})

// Test 1: Check router health
console.log('--- Test 1: Health check ---')
const healthRes = await fetch(`${ROUTER_URL}/health`)
const health = await healthRes.json()
console.log(JSON.stringify(health, null, 2))
console.log('')

// Test 2: List public services
console.log('--- Test 2: Services ---')
const servicesRes = await fetch(`${ROUTER_URL}/v1/services/catalog`)
const services = await servicesRes.json() as { services: any[] }
console.log(`${services.services.length} public routes available`)
console.log('')

// Test 3: Proxy to Parallel (search API, $0.01 per query)
console.log('--- Test 3: Proxy to Parallel search ---')
console.log('Sending request through Router to /v1/services/parallel/search...')
console.log('(The SDK will handle the 402 payment automatically)')
console.log('')

try {
  const startTime = Date.now()

  const response = await mppx.fetch(
    `${ROUTER_URL}/v1/services/parallel/search`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'stellar blockchain payments' }),
    },
  )

  const elapsed = Date.now() - startTime

  console.log(`Status: ${response.status}`)
  console.log(`Time: ${elapsed}ms`)

  if (response.ok) {
    const data = await response.json()
    console.log('Response:', JSON.stringify(data, null, 2).substring(0, 500))
    console.log('')
    console.log('SUCCESS — Agent paid via Stellar USDC, got content from Tempo merchant!')
  } else {
    const text = await response.text()
    console.log('Response:', text.substring(0, 500))
    console.log('')
    console.log(`FAILED — Status ${response.status}`)
  }
} catch (error: any) {
  console.error('Error:', error.message)
  console.error('')
  console.error('This is expected if:')
  console.error('  - The Router 402 challenge format is not yet standard MPP format')
  console.error('  - The SDK cannot parse the challenge')
  console.error('  - The agent account has no USDC')
}
