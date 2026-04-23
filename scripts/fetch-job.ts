/**
 * One-shot: poll a StableStudio async job by signing the SIWX (EIP-4361)
 * challenge with TEMPO_ROUTER_PRIVATE_KEY from .dev.vars.
 *
 *   npx tsx scripts/fetch-job.ts <jobId>
 *   npx tsx scripts/fetch-job.ts cmobn9mi9000e04l51w62943i
 *
 * Mirrors src/mpp/siwx-signer.ts so results here should match what the
 * worker would serve at /v1/services/stablestudio/jobs/<id>.
 */

import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function loadDevVars(): Record<string, string> {
  const path = join(process.cwd(), '.dev.vars')
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

interface SiwxChallenge {
  domain: string
  statement?: string
  uri: string
  nonce: string
  issuedAt: string
  expirationTime: string
  chainId?: string
}

function parseSiwxChallenge(body: any): SiwxChallenge | null {
  const ext = body?.extensions?.['sign-in-with-x']?.info
  if (!ext?.domain || !ext?.nonce) return null
  return {
    domain: ext.domain,
    statement: ext.statement,
    uri: ext.uri,
    nonce: ext.nonce,
    issuedAt: ext.issuedAt,
    expirationTime: ext.expirationTime,
    chainId: ext.chainId,
  }
}

function buildSiweMessage(c: SiwxChallenge, address: string): string {
  // EIP-4361: `Chain ID` is numeric only. CAIP-2 prefix breaks verification.
  const numericChainId = (c.chainId || 'eip155:8453').replace(/^eip155:/, '')
  return [
    `${c.domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    c.statement || 'Sign in to verify your wallet identity',
    '',
    `URI: ${c.uri}`,
    `Version: 1`,
    `Chain ID: ${numericChainId}`,
    `Nonce: ${c.nonce}`,
    `Issued At: ${c.issuedAt}`,
    `Expiration Time: ${c.expirationTime}`,
  ].join('\n')
}

async function main() {
  const jobId = process.argv[2]
  if (!jobId) {
    console.error('usage: tsx scripts/fetch-job.ts <jobId>')
    process.exit(1)
  }
  const vars = loadDevVars()
  const key = vars.TEMPO_ROUTER_PRIVATE_KEY
  if (!key) throw new Error('TEMPO_ROUTER_PRIVATE_KEY missing from .dev.vars')

  const account = privateKeyToAccount(key as `0x${string}`)
  console.log(`[fetch-job] signer address: ${account.address}`)

  const url = `https://stablestudio.dev/api/jobs/${jobId}`
  console.log(`[fetch-job] probing ${url}`)

  const probe = await fetch(url)
  console.log(`[fetch-job] probe status: ${probe.status}`)
  if (probe.status !== 402) {
    console.log(await probe.text())
    return
  }
  const probeBody = await probe.json()
  const challenge = parseSiwxChallenge(probeBody)
  if (!challenge) {
    console.error('[fetch-job] no SIWX challenge in 402 body:')
    console.error(JSON.stringify(probeBody, null, 2))
    process.exit(2)
  }
  console.log(`[fetch-job] challenge nonce=${challenge.nonce} exp=${challenge.expirationTime}`)

  const message = buildSiweMessage(challenge, account.address)
  const signature = await account.signMessage({ message })
  const payload = {
    domain: challenge.domain,
    address: account.address,
    statement: challenge.statement || 'Sign in to verify your wallet identity',
    uri: challenge.uri,
    version: '1',
    chainId: challenge.chainId || 'eip155:8453',
    type: 'eip191',
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expirationTime: challenge.expirationTime,
    signature,
  }
  const header = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const res = await fetch(url, { headers: { 'Sign-In-With-X': header } })
  console.log(`[fetch-job] authed status: ${res.status}`)
  const text = await res.text()
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
