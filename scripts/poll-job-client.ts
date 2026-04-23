/**
 * Reference client for the authenticated async-job polling flow.
 *
 *   npx tsx scripts/poll-job-client.ts <service> <jobId> [G_secret]
 *
 *   # If G_secret is omitted, reads STELLAR_SECRET from env.
 *
 * Exactly three steps — everything a client has to implement.
 *
 *   1. GET /v1/services/<svc>/jobs/<id>/challenge
 *        header: X-Stellar-Owner: G...
 *      → { nonce: <hex> }
 *
 *   2. sig = Ed25519.sign(G_secret, fromHex(nonce))
 *
 *   3. GET /v1/services/<svc>/jobs/<id>
 *        headers:
 *          X-Stellar-Owner:     G...
 *          X-Stellar-Nonce:     <hex>
 *          X-Stellar-Signature: base64(sig)
 *
 * The same pattern works in any language — the Stellar SDKs for
 * TS, Python, Go, Rust, iOS, and Android all expose
 * `Keypair.fromSecret(S).sign(bytes)`.
 */

import { Keypair } from '@stellar/stellar-base'

const ROUTER = process.env.MPP_ROUTER_URL || 'https://apiserver.mpprouter.dev'

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

async function main() {
  const [, , service, jobId, secretArg] = process.argv
  if (!service || !jobId) {
    console.error('usage: tsx scripts/poll-job-client.ts <service> <jobId> [S...secret]')
    process.exit(1)
  }
  const secret = secretArg || process.env.STELLAR_SECRET
  if (!secret) {
    console.error('Set STELLAR_SECRET env var or pass the S... secret as argv[3]')
    process.exit(1)
  }

  const kp = Keypair.fromSecret(secret)
  const owner = kp.publicKey()
  console.log(`[client] owner = ${owner}`)

  // Step 1: request a challenge nonce
  const challengeUrl = `${ROUTER}/v1/services/${service}/jobs/${jobId}/challenge`
  console.log(`[client] GET ${challengeUrl}`)
  const cRes = await fetch(challengeUrl, { headers: { 'X-Stellar-Owner': owner } })
  if (!cRes.ok) {
    console.error(`[client] challenge failed: ${cRes.status}`)
    console.error(await cRes.text())
    process.exit(2)
  }
  const { nonce, expiresAt } = (await cRes.json()) as { nonce: string; expiresAt: string }
  console.log(`[client] nonce=${nonce} (expires ${expiresAt})`)

  // Step 2: sign the nonce bytes with the Stellar secret
  const sig = kp.sign(Buffer.from(hexToBytes(nonce)))
  const sigB64 = sig.toString('base64')

  // Step 3: poll the job
  const pollUrl = `${ROUTER}/v1/services/${service}/jobs/${jobId}`
  console.log(`[client] GET ${pollUrl}`)
  const pRes = await fetch(pollUrl, {
    headers: {
      'X-Stellar-Owner': owner,
      'X-Stellar-Nonce': nonce,
      'X-Stellar-Signature': sigB64,
    },
  })
  console.log(`[client] poll status: ${pRes.status}`)
  const text = await pRes.text()
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2))
  } catch {
    console.log(text)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
