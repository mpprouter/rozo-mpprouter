/**
 * SIWX (Sign In With X) signer for upstream services that require
 * wallet-based authentication on polling endpoints.
 *
 * Uses the Router's Tempo EVM wallet (TEMPO_ROUTER_PRIVATE_KEY) to
 * sign EIP-191 messages in the CAIP-122 / EIP-4361 format. This
 * lets the router poll async job results on behalf of agents who
 * paid with Stellar USDC.
 */

import { privateKeyToAccount } from 'viem/accounts'

interface SiwxChallenge {
  domain: string
  statement?: string
  uri: string
  nonce: string
  issuedAt: string
  expirationTime: string
  /** CAIP-2 chain id from the challenge (e.g. "eip155:8453"). */
  chainId?: string
}

/**
 * Parse a SIWX challenge from a 402 response body.
 *
 * StableStudio (and x402-compatible services) embed the challenge at:
 *   body.extensions["sign-in-with-x"].info
 */
function parseSiwxChallenge(body: unknown): SiwxChallenge | null {
  if (typeof body !== 'object' || body === null) return null
  const ext = (body as any).extensions?.['sign-in-with-x']?.info
  if (!ext || typeof ext.domain !== 'string' || typeof ext.nonce !== 'string') return null
  return {
    domain: ext.domain,
    statement: ext.statement,
    uri: ext.uri,
    nonce: ext.nonce,
    issuedAt: ext.issuedAt,
    expirationTime: ext.expirationTime,
    chainId: typeof ext.chainId === 'string' ? ext.chainId : undefined,
  }
}

/**
 * Build the EIP-4361 (SIWE) message text from a SIWX challenge.
 *
 * Note: EIP-4361 requires `Chain ID` to be the numeric chain id only
 * (e.g. `8453`), NOT the CAIP-2 form (`eip155:8453`). Servers verifying
 * the signature reconstruct the message with the numeric form, so if
 * we include the `eip155:` prefix the signature will not match and the
 * server returns `siwx_invalid_signature`.
 */
function buildSiweMessage(challenge: SiwxChallenge, address: string): string {
  const numericChainId = challenge.chainId
    ? challenge.chainId.replace(/^eip155:/, '')
    : '8453'
  return [
    `${challenge.domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    challenge.statement || 'Sign in to verify your wallet identity',
    '',
    `URI: ${challenge.uri}`,
    `Version: 1`,
    `Chain ID: ${numericChainId}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt}`,
    `Expiration Time: ${challenge.expirationTime}`,
  ].join('\n')
}

/**
 * Fetch a URL that requires SIWX authentication. Handles the
 * 402 → parse challenge → sign → retry flow automatically.
 *
 * Returns the authenticated response. Throws if the 402 challenge
 * cannot be parsed or the retry also fails.
 */
export async function fetchWithSiwx(
  url: string,
  tempoPrivateKey: string,
): Promise<Response> {
  const account = privateKeyToAccount(tempoPrivateKey as `0x${string}`)

  // Step 1: Probe — expect 402 with SIWX challenge
  const probeRes = await fetch(url)
  if (probeRes.status !== 402) {
    // No auth needed or already resolved — return as-is
    return probeRes
  }

  const probeBody = await probeRes.json()
  const challenge = parseSiwxChallenge(probeBody)
  if (!challenge) {
    throw new Error(`SIWX challenge not found in 402 response from ${url}`)
  }

  // Step 2: Sign the SIWE message with the Tempo EVM wallet
  const messageText = buildSiweMessage(challenge, account.address)
  const signature = await account.signMessage({ message: messageText })

  const siwxPayload = {
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

  const siwxHeader = btoa(JSON.stringify(siwxPayload))

  // Step 3: Retry with SIWX auth header
  const authRes = await fetch(url, {
    headers: { 'Sign-In-With-X': siwxHeader },
  })

  return authRes
}
