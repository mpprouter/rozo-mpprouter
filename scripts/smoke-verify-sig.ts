/**
 * Sanity check: round-trip a Stellar Ed25519 signature through the
 * same verify path used by handleJobStatus().
 *
 *   npx tsx scripts/smoke-verify-sig.ts
 */
import { Keypair } from '@stellar/stellar-base'

const kp = Keypair.random()
const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
const sig = kp.sign(nonce)
const ok = Keypair.fromPublicKey(kp.publicKey()).verify(nonce, sig)
console.log('G         :', kp.publicKey())
console.log('nonce hex :', nonce.toString('hex'))
console.log('sig b64   :', sig.toString('base64'))
console.log('verify ok :', ok)

// Wrong key should fail
const wrong = Keypair.random()
const bad = Keypair.fromPublicKey(wrong.publicKey()).verify(nonce, sig)
console.log('wrong key verify:', bad, '(expected false)')
if (!ok || bad) {
  console.error('FAIL')
  process.exit(1)
}
console.log('OK')
