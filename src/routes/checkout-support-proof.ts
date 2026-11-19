import { doAtomicParams } from '../mpp/kv-atomic-store'

interface SupportTarget {
  orderId: string
  contactId: string
  conversationId: string
}

interface VerifiedCheckoutContext extends SupportTarget {
  expiresAt: number
}

interface Authorizers {
  // The issuing service must verify both checkout ownership and the Intercom contact binding.
  verifyCheckout: (request: Request) => Promise<VerifiedCheckoutContext | null>
  // The consuming service must authenticate the live conversation and derive the binding target server-side.
  verifyIntercom: (request: Request) => Promise<SupportTarget | null>
}

interface ProofRecord {
  digest: string
  expiresAt: number
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const CONTACT_ID = /^[a-zA-Z0-9_-]{1,128}$/
const CONVERSATION_ID = /^\d{1,32}$/
const PROOF = /^[a-f0-9]{64}$/

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function digest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return hex(new Uint8Array(digest))
}

async function targetKey(target: SupportTarget): Promise<string | null> {
  if (typeof target.orderId !== 'string' || !UUID.test(target.orderId)
    || typeof target.contactId !== 'string' || !CONTACT_ID.test(target.contactId)
    || typeof target.conversationId !== 'string' || !CONVERSATION_ID.test(target.conversationId)) {
    return null
  }
  return digest(JSON.stringify(['checkout-support:payin-ack:v1', target.orderId, target.contactId, target.conversationId]))
}

function parseRecord(value: string): ProofRecord | null {
  try {
    const record: Partial<ProofRecord> | null = JSON.parse(value)
    return typeof record?.digest === 'string' && PROOF.test(record.digest)
      && typeof record.expiresAt === 'number' && Number.isSafeInteger(record.expiresAt)
      ? { digest: record.digest, expiresAt: record.expiresAt } : null
  } catch {
    return null
  }
}

/** Server-only proof for a factual support acknowledgement. No HTTP route or payment privileges. */
export function checkoutSupportProof(
  namespace: DurableObjectNamespace,
  authorizers: Authorizers,
  maxAgeMs: number,
  now = Date.now,
) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error('Invalid support proof lifetime')
  const store = doAtomicParams(namespace, 'checkout-support')

  return {
    async issue(request: Request): Promise<string | null> {
      const context = await authorizers.verifyCheckout(request)
      if (!context || !Number.isSafeInteger(context.expiresAt)) return null
      const key = await targetKey(context)
      const expiresAt = Math.min(context.expiresAt, now() + maxAgeMs)
      if (!key || expiresAt <= now()) return null
      const proof = hex(crypto.getRandomValues(new Uint8Array(32)))
      const record = JSON.stringify({ digest: await digest(proof), expiresAt })
      const issued = await store.update(key, current => {
        if (expiresAt <= now()) return { op: 'noop', result: false }
        if (current !== null) {
          const existing = parseRecord(current)
          if (!existing || existing.expiresAt > now()) return { op: 'noop', result: false }
        }
        return { op: 'set', value: record, result: true }
      })
      return issued && expiresAt > now() ? proof : null
    },

    async consume(request: Request, proof: string): Promise<boolean> {
      if (!PROOF.test(proof)) return false
      const context = await authorizers.verifyIntercom(request)
      const key = context && await targetKey(context)
      if (!key) return false
      const presented = await digest(proof)
      const expiresAt = await store.update<number | null>(key, current => {
        const record = current === null ? null : parseRecord(current)
        if (!record || record.expiresAt <= now() || record.digest !== presented) return { op: 'noop', result: null }
        return { op: 'delete', result: record.expiresAt }
      })
      return expiresAt !== null && expiresAt > now()
    },
  }
}
