/**
 * x402 `exact` on Base: EIP-3009 TransferWithAuthorization from the shared
 * funder, signed REMOTELY (founder decision, option A): this Worker never
 * holds the funder key. The signing service (pay-invoice side,
 * X402_SIGN_SERVICE_URL, default https://agentapi.rozo.ai/sign-x402) owns the
 * key; we send it the exact authorization to sign and verify what comes back.
 *
 * Contract (POST, `authorization: Bearer <X402_SIGN_SHARED_SECRET>`):
 *   request  { network: "eip155:8453", asset, payTo, amountAtomic,
 *              validAfter: 0, validBefore: <unix s>, nonce: "0x<32 bytes>",
 *              idempotencyKey, reference: { paymentId } }
 *   200      { ok: true, funder, signature, authorization: {from,to,value,validAfter,validBefore,nonce} }
 *   errors   401 | 400 X402_SIGN_UNSUPPORTED | 403 X402_SIGN_PAYTO_BLOCKED |
 *            409 X402_SIGN_IDEMPOTENCY_CONFLICT | 429 X402_SIGN_CAP / X402_SIGN_DAILY_CAP |
 *            503 X402_SIGN_DISABLED
 *
 * The nonce is generated here (it goes into our ledger under the
 * (funder, asset, network, nonce) unique key). Before anything is returned to
 * an agent we check: funder == FUNDER_WALLET, the authorization echoes exactly
 * what we asked for, and the signature recovers to the funder over the
 * TransferWithAuthorization typed data (field layout as @x402/evm's exact
 * client).
 */

import { getAddress, recoverTypedDataAddress, toHex, type Hex } from 'viem'
import { BASE_MAINNET_CAIP2, BASE_USDC, type ValidatedRequirement } from './requirements'

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export const BASE_CHAIN_ID = 8453
export const DEFAULT_SIGN_SERVICE_URL = 'https://agentapi.rozo.ai/sign-x402'
export const SIGN_SERVICE_TIMEOUT_MS = 10_000

export interface EvmAuthorization {
  from: `0x${string}`
  to: `0x${string}`
  value: string
  validAfter: string
  validBefore: string
  nonce: Hex
}

export function randomEvmNonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

/** The EIP-712 request for one authorization (exported for tests). */
export function buildTransferWithAuthorizationTypedData(req: ValidatedRequirement, auth: EvmAuthorization) {
  if (req.network !== BASE_MAINNET_CAIP2) throw new Error(`not an EVM requirement: ${req.network}`)
  return {
    domain: {
      name: String(req.extra.name),
      version: String(req.extra.version),
      chainId: BASE_CHAIN_ID,
      verifyingContract: getAddress(req.asset),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: getAddress(auth.from),
      to: getAddress(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  }
}

export interface EvmExactResult {
  /** x402 v2 `payload` for scheme exact on EVM. */
  payload: { authorization: EvmAuthorization; signature: Hex }
  nonce: Hex
  validBeforeUnix: number
  funder: `0x${string}`
}

export interface RemoteSignerConfig {
  url: string
  secret: string
  /** Address every response must sign from (FUNDER_WALLET). */
  expectedFunder: string
  fetchImpl: typeof fetch
  timeoutMs?: number
}

export interface RemoteSignRequest {
  nonce: Hex
  validBeforeUnix: number
  /** Stable per (agent key, idempotencyKey); see routes.ts. */
  idempotencyKey: string
  paymentReference: string
}

/** Outward error for the /sign caller; nothing is debited on any of these. */
export interface RemoteSignError {
  status: number
  code: string
  message: string
}

export function remoteSignerFromEnv(
  env: { X402_SIGN_SERVICE_URL?: string; X402_SIGN_SHARED_SECRET?: string },
  expectedFunder: string,
  fetchImpl: typeof fetch,
): RemoteSignerConfig | null {
  const url = (env.X402_SIGN_SERVICE_URL || DEFAULT_SIGN_SERVICE_URL).trim()
  const secret = env.X402_SIGN_SHARED_SECRET?.trim()
  if (!secret || !/^https:\/\//.test(url)) return null
  return { url, secret, expectedFunder, fetchImpl }
}

function mapRemoteError(status: number, code: string | undefined): RemoteSignError {
  switch (status) {
    case 401:
      return { status: 503, code: 'X402_SIGNER_NOT_CONFIGURED', message: 'The signing service rejected our credentials.' }
    case 400:
      return { status: 400, code: 'X402_SIGN_UNSUPPORTED', message: 'The signing service does not support this payment requirement.' }
    case 403:
      return { status: 403, code: 'X402_PAYTO_BLOCKED', message: 'This payTo is blocked by the signing service.' }
    case 409:
      return {
        status: 409, code: 'X402_IDEMPOTENCY_CONFLICT',
        message: 'This idempotencyKey was already used with different signing parameters. Use a new key for a new challenge.',
      }
    case 429:
      return code === 'X402_SIGN_DAILY_CAP'
        ? { status: 429, code: 'X402_SIGNER_DAILY_CAP_REACHED', message: 'The payer has reached its daily signing cap. Try again after 00:00 UTC.' }
        : { status: 429, code: 'X402_SIGNER_CAP_REACHED', message: 'The signing service refused this amount (cap). Try a smaller payment or later.' }
    case 503:
      if (code === 'X402_SIGN_DISABLED') {
        return { status: 503, code: 'X402_SIGNER_DISABLED', message: 'Base signing is switched off.' }
      }
      break
  }
  return { status: 503, code: 'X402_RETRY', message: 'The signing service is temporarily unavailable. Retry with the same idempotencyKey.' }
}

/**
 * Ask the signing service for one authorization and verify it. Timeouts, 5xx
 * and malformed answers are transient (503 X402_RETRY); a wrong funder or an
 * authorization that is not the one we asked for is 503
 * X402_SIGNER_NOT_CONFIGURED and is never released.
 */
export async function remoteSignEvmExact(
  cfg: RemoteSignerConfig,
  req: ValidatedRequirement,
  r: RemoteSignRequest,
): Promise<{ ok: EvmExactResult } | { error: RemoteSignError }> {
  if (req.network !== BASE_MAINNET_CAIP2) throw new Error(`not an EVM requirement: ${req.network}`)
  const body = {
    network: BASE_MAINNET_CAIP2,
    asset: getAddress(BASE_USDC),
    payTo: getAddress(req.payTo),
    amountAtomic: req.amount,
    validAfter: 0,
    validBefore: r.validBeforeUnix,
    nonce: r.nonce,
    idempotencyKey: r.idempotencyKey,
    reference: { paymentId: r.paymentReference },
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? SIGN_SERVICE_TIMEOUT_MS)
  let res: Response
  let json: any
  try {
    res = await cfg.fetchImpl(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    json = await res.json().catch(() => null)
  } catch (err) {
    console.warn(`[x402-sign] signing service unreachable: ${(err as Error).name}`)
    return { error: mapRemoteError(599, undefined) }
  } finally {
    clearTimeout(timer)
  }

  if (res.status !== 200 || !json || json.ok !== true) {
    const code = typeof json?.code === 'string' ? json.code : typeof json?.error?.code === 'string' ? json.error.code : undefined
    console.warn(`[x402-sign] signing service answered ${res.status} ${code ?? ''}`)
    return { error: mapRemoteError(res.status === 200 ? 502 : res.status, code) }
  }

  const misconfigured: RemoteSignError = {
    status: 503, code: 'X402_SIGNER_NOT_CONFIGURED', message: 'The signing service answered for an unexpected wallet or authorization.',
  }
  const funder = typeof json.funder === 'string' ? json.funder : ''
  if (!/^0x[0-9a-fA-F]{40}$/.test(funder) || funder.toLowerCase() !== cfg.expectedFunder.toLowerCase()) {
    console.error('[x402-sign] signing service funder differs from FUNDER_WALLET')
    return { error: misconfigured }
  }
  const a = json.authorization ?? {}
  const authorization: EvmAuthorization = {
    from: getAddress(funder),
    to: getAddress(req.payTo),
    value: req.amount,
    validAfter: '0',
    validBefore: String(r.validBeforeUnix),
    nonce: r.nonce,
  }
  const echoed =
    typeof a.from === 'string' && a.from.toLowerCase() === funder.toLowerCase() &&
    typeof a.to === 'string' && a.to.toLowerCase() === req.payTo.toLowerCase() &&
    String(a.value) === req.amount &&
    String(a.validAfter) === '0' &&
    String(a.validBefore) === String(r.validBeforeUnix) &&
    typeof a.nonce === 'string' && a.nonce.toLowerCase() === r.nonce.toLowerCase()
  if (!echoed) {
    console.error('[x402-sign] signing service authorization differs from the request')
    return { error: misconfigured }
  }
  const signature = json.signature
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { error: mapRemoteError(502, undefined) }
  }
  let recovered: string
  try {
    recovered = await recoverTypedDataAddress({
      ...buildTransferWithAuthorizationTypedData(req, authorization),
      signature: signature as Hex,
    })
  } catch {
    return { error: misconfigured }
  }
  if (recovered.toLowerCase() !== funder.toLowerCase()) {
    console.error('[x402-sign] signature does not recover to the funder')
    return { error: misconfigured }
  }
  return {
    ok: {
      payload: { authorization, signature: signature as Hex },
      nonce: r.nonce,
      validBeforeUnix: r.validBeforeUnix,
      funder: authorization.from,
    },
  }
}
