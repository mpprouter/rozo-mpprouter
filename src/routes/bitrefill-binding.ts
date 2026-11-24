/**
 * Bitrefill funder model: the facts MPP Router freezes into the intents order
 * at create time, and the helpers both sides of the contract must compute the
 * same way. Mirror of shawn-local-skills pay-invoice/bitrefill.ts; any change
 * here must land there in the same release (contract text in both PR bodies).
 *
 *   metadata.bitrefill = { v: 1, invoiceId, address (lowercase), amountAtomic,
 *                          expiresAt (ISO), feeBps, serviceFeeAtomic,
 *                          callerPaysAtomic, binding }
 *   binding = hex HMAC-SHA256(K, message), K = utf8(hex HMAC-SHA256(
 *             adminSecret, "rozo-bitrefill-binding-v1-key"))
 *   nonce   = keccak256(utf8("rozo:bitrefill:v1:" + invoiceId))
 */
import { keccak256, stringToHex, type Hex } from 'viem'
import { BASE_FUNDER_ADDRESS, RETIRED_FUNDER_ADDRESS_20261124 } from '../funder-address'
import { EVM_BLOCKED_ADDRESSES } from '../evm-blocked-addresses'

export const BITREFILL_BINDING_VERSION = 'rozo-bitrefill-binding-v1'
export const BITREFILL_METADATA_VERSION = 1
export const BITREFILL_NONCE_PREFIX = 'rozo:bitrefill:v1:'
/** Founder 2026-11-11: 1% service fee, charged in the order price. */
export const BITREFILL_FEE_BPS = 100

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
// The Base USDC funder (webhook.ts FUNDER_WALLET, create-invoice.ts
// SETTLEMENT_RECEIVER); a test pins all three equal. Read from the leaf module
// src/funder-address.ts to avoid an import cycle with webhook.ts.
export const BITREFILL_FUNDER = BASE_FUNDER_ADDRESS

// Compromised / attacker / lookalike EVM addresses from the ainative charter
// blacklist (ainative/CLAUDE.md), shared with the funder tier resolver
// (src/evm-blocked-addresses.ts), plus the retired funder. Lowercase.
export const BITREFILL_BLOCKED_RECEIVERS: ReadonlySet<string> = new Set([
  ...EVM_BLOCKED_ADDRESSES,
  RETIRED_FUNDER_ADDRESS_20261124.toLowerCase(), // compromised funder, swept 2026-11-24
])

/** Why a Bitrefill receiving address is refused, or null when acceptable. */
export function bitrefillReceiverRefusal(address: unknown): string | null {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) return 'not a 0x-prefixed 40-hex address'
  const a = address.toLowerCase()
  if (BITREFILL_BLOCKED_RECEIVERS.has(a)) return 'address is blocked'
  if (a === BITREFILL_FUNDER.toLowerCase()) return 'address is the Rozo funder'
  if (a === BASE_USDC) return 'address is the USDC contract'
  return null
}

export function isBitrefillUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

export function bitrefillNonce(invoiceId: string): Hex {
  return keccak256(stringToHex(`${BITREFILL_NONCE_PREFIX}${invoiceId}`))
}

export interface BitrefillFrozenFacts {
  invoiceId: string
  address: string
  amountAtomic: bigint
  expiresAt: string
  feeBps: number
  serviceFeeAtomic: bigint
  callerPaysAtomic: bigint
}

export function bitrefillBindingMessage(f: BitrefillFrozenFacts): string {
  return [
    BITREFILL_BINDING_VERSION,
    f.invoiceId,
    f.address.toLowerCase(),
    f.amountAtomic.toString(),
    f.expiresAt,
    String(f.feeBps),
    f.serviceFeeAtomic.toString(),
    f.callerPaysAtomic.toString(),
  ].join('|')
}

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function computeBitrefillBinding(adminSecret: string, f: BitrefillFrozenFacts): Promise<string> {
  const derived = await hmacHex(adminSecret, `${BITREFILL_BINDING_VERSION}-key`)
  return hmacHex(derived, bitrefillBindingMessage(f))
}

export async function bitrefillMetadataBlock(adminSecret: string, f: BitrefillFrozenFacts) {
  return {
    v: BITREFILL_METADATA_VERSION,
    invoiceId: f.invoiceId,
    address: f.address.toLowerCase(),
    amountAtomic: f.amountAtomic.toString(),
    expiresAt: f.expiresAt,
    feeBps: f.feeBps,
    serviceFeeAtomic: f.serviceFeeAtomic.toString(),
    callerPaysAtomic: f.callerPaysAtomic.toString(),
    binding: await computeBitrefillBinding(adminSecret, f),
  }
}

/** Parse metadata.bitrefill back; null when absent or malformed. */
export function readBitrefillFacts(order: any): (BitrefillFrozenFacts & { binding: string }) | null {
  let meta = order?.metadata
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta)
    } catch {
      return null
    }
  }
  if (!meta || typeof meta !== 'object' || meta.provider !== 'bitrefill') return null
  const b = meta.bitrefill
  if (!b || typeof b !== 'object' || b.v !== BITREFILL_METADATA_VERSION) return null
  const atomic = (v: unknown) => (typeof v === 'string' && /^[0-9]{1,18}$/.test(v) ? BigInt(v) : null)
  const amountAtomic = atomic(b.amountAtomic)
  const serviceFeeAtomic = atomic(b.serviceFeeAtomic)
  const callerPaysAtomic = atomic(b.callerPaysAtomic)
  if (
    !isBitrefillUuid(b.invoiceId) ||
    typeof b.address !== 'string' || !ADDRESS_RE.test(b.address) ||
    typeof b.expiresAt !== 'string' || !Number.isFinite(Date.parse(b.expiresAt)) ||
    typeof b.feeBps !== 'number' ||
    typeof b.binding !== 'string' || !/^[0-9a-f]{64}$/.test(b.binding) ||
    amountAtomic === null || serviceFeeAtomic === null || callerPaysAtomic === null
  ) {
    return null
  }
  return {
    invoiceId: b.invoiceId,
    address: b.address.toLowerCase(),
    amountAtomic,
    expiresAt: b.expiresAt,
    feeBps: b.feeBps,
    serviceFeeAtomic,
    callerPaysAtomic,
    binding: b.binding,
  }
}
