// Invoice capability encryption (design §6).
//
// The Stripe pay URL carries a replayable /pay/<blob> session hash. It is a
// capability: anyone holding it can resume and interact with a live Stripe
// Payin Session. We must therefore never store it in plaintext at rest.
//
// This module wraps the URL as an AES-GCM (256-bit) blob under a dedicated
// INVOICE_CAPABILITY_ENCRYPTION_KEY, with a random 96-bit IV per encryption and
// a key-id prefix so the key can be rotated (current key encrypts; a previous
// key can still decrypt in-flight records).
//
// Format (all base64url, colon-delimited so it is log-safe and self-describing):
//   v1:<keyId>:<base64url(iv)>:<base64url(ciphertext||tag)>
//
// Secret hygiene: the plaintext URL, the raw key, and the blob's plaintext must
// never be logged or returned in any API response. Callers hold the decrypted
// URL only in memory and only long enough to hand it to pay-invoice.

import type { Env } from '../index'

const FORMAT_VERSION = 'v1'
const DEFAULT_KEY_ID = 'v1'
const IV_BYTES = 12 // 96-bit IV, the AES-GCM standard.

export class CapabilityCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CapabilityCryptoError'
  }
}

// ── base64url helpers (no padding, URL/log safe) ────────────────────────────

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ── key resolution ──────────────────────────────────────────────────────────

interface ResolvedKeys {
  keyId: string
  current: string // base64 (standard) 32-byte key material
  previous: { keyId: string; material: string } | null
}

function resolveKeyMaterial(env: Env): ResolvedKeys {
  const current = env.INVOICE_CAPABILITY_ENCRYPTION_KEY
  if (!current) {
    // Fail-closed: with no key configured we refuse to store a capability at
    // all rather than fall back to plaintext.
    throw new CapabilityCryptoError('INVOICE_CAPABILITY_ENCRYPTION_KEY not configured')
  }
  const keyId = env.INVOICE_CAPABILITY_KEY_ID || DEFAULT_KEY_ID
  const prevMaterial = env.INVOICE_CAPABILITY_ENCRYPTION_KEY_PREVIOUS
  const prevKeyId = env.INVOICE_CAPABILITY_KEY_ID_PREVIOUS
  return {
    keyId,
    current,
    previous: prevMaterial && prevKeyId ? { keyId: prevKeyId, material: prevMaterial } : null,
  }
}

async function importAesKey(
  base64Key: string,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  let raw: Uint8Array
  try {
    // Standard base64 (with or without padding) — the key is operator-supplied.
    raw = base64UrlToBytes(base64Key)
  } catch {
    throw new CapabilityCryptoError('encryption key is not valid base64')
  }
  if (raw.length !== 32) {
    throw new CapabilityCryptoError('encryption key must be 32 bytes (AES-256)')
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage])
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Encrypt a capability string (the Stripe pay URL) with the current key.
 * Returns a self-describing `v1:<keyId>:<iv>:<ct>` blob. Throws
 * CapabilityCryptoError if no key is configured (fail-closed) — the caller must
 * then refuse to persist a plaintext fallback.
 */
export async function encryptCapability(plaintext: string, env: Env): Promise<string> {
  const keys = resolveKeyMaterial(env)
  const key = await importAesKey(keys.current, 'encrypt')
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ptBytes = new TextEncoder().encode(plaintext)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ptBytes),
  )
  return [
    FORMAT_VERSION,
    keys.keyId,
    bytesToBase64Url(iv),
    bytesToBase64Url(ct),
  ].join(':')
}

/**
 * Decrypt a capability blob produced by encryptCapability. Selects the key by
 * the blob's key-id (current or previous, for rotation). Throws
 * CapabilityCryptoError on any malformed blob, unknown key id, or auth-tag
 * failure — the caller must treat this as unrecoverable (design §12: capability
 * decrypt failure → manual_review, never reconstruct from elsewhere).
 */
export async function decryptCapability(blob: string, env: Env): Promise<string> {
  const parts = blob.split(':')
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new CapabilityCryptoError('malformed capability blob')
  }
  const [, blobKeyId, ivB64, ctB64] = parts
  const keys = resolveKeyMaterial(env)

  let material: string | null = null
  if (blobKeyId === keys.keyId) material = keys.current
  else if (keys.previous && blobKeyId === keys.previous.keyId) material = keys.previous.material
  if (material === null) {
    throw new CapabilityCryptoError('no key available for capability key id')
  }

  const key = await importAesKey(material, 'decrypt')
  let iv: Uint8Array
  let ct: Uint8Array
  try {
    iv = base64UrlToBytes(ivB64)
    ct = base64UrlToBytes(ctB64)
  } catch {
    throw new CapabilityCryptoError('capability blob has invalid base64')
  }
  let pt: ArrayBuffer
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  } catch {
    // Wrong key or tampered ciphertext — AES-GCM auth tag rejected it.
    throw new CapabilityCryptoError('capability decryption failed')
  }
  return new TextDecoder().decode(pt)
}
