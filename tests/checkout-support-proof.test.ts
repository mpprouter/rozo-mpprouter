import { describe, expect, it, vi } from 'vitest'
import { checkoutSupportProof } from '../src/routes/checkout-support-proof'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

const TARGET = { orderId: '01234567-89ab-cdef-0123-456789abcdef', contactId: 'contact_1', conversationId: '123456' }
const REQUEST = new Request('https://checkout.internal/')

function fixture() {
  let time = 10_000
  const namespace = makeAtomicStoreMock()
  const instance = vi.spyOn(namespace, 'idFromName')
  const verifyCheckout = vi.fn(async (_request: Request): Promise<(typeof TARGET & { expiresAt: number }) | null> => (
    { ...TARGET, expiresAt: time + 100 }
  ))
  const verifyIntercom = vi.fn(async (_request: Request): Promise<typeof TARGET | null> => ({ ...TARGET }))
  const proof = checkoutSupportProof(namespace, { verifyCheckout, verifyIntercom }, 200, () => time)
  return { proof, instance, verifyCheckout, verifyIntercom, setTime: (t: number) => { time = t } }
}

describe('verified checkout support proof', () => {
  it('issues only for a trusted, current checkout session and isolates support storage', async () => {
    const { proof, instance, verifyCheckout } = fixture()
    verifyCheckout.mockResolvedValueOnce(null)
    expect(await proof.issue(REQUEST)).toBeNull()
    verifyCheckout.mockResolvedValueOnce({ ...TARGET, expiresAt: 9_999 })
    expect(await proof.issue(REQUEST)).toBeNull()
    expect(await proof.issue(REQUEST)).toMatch(/^[a-f0-9]{64}$/)
    expect(await proof.issue(REQUEST)).toBeNull()
    expect(instance).toHaveBeenCalledOnce()
    expect(instance).toHaveBeenCalledWith('checkout-support')
  })

  it('binds to the verified order and both Intercom identifiers without burning a valid proof on a mismatch', async () => {
    const { proof, verifyIntercom } = fixture()
    const token = await proof.issue(REQUEST)
    expect(token).not.toBeNull()
    for (const other of [null, { ...TARGET, contactId: 'contact_2' }, { ...TARGET, conversationId: '987654' },
      { ...TARGET, orderId: '12345678-89ab-cdef-0123-456789abcdef' }]) {
      verifyIntercom.mockResolvedValueOnce(other)
      expect(await proof.consume(REQUEST, token!)).toBe(false)
    }
    expect(await proof.consume(REQUEST, 'a'.repeat(64))).toBe(false)
    const results = await Promise.all([proof.consume(REQUEST, token!), proof.consume(REQUEST, token!)])
    expect(results.sort()).toEqual([false, true])
    expect(await proof.consume(REQUEST, token!)).toBe(false)
  })

  it('bounds expiry to the authenticated checkout session and configured proof lifetime', async () => {
    const { proof, verifyCheckout, setTime } = fixture()
    const first = await proof.issue(REQUEST)
    setTime(10_100)
    expect(await proof.consume(REQUEST, first!)).toBe(false)
    verifyCheckout.mockResolvedValueOnce({ ...TARGET, expiresAt: 20_000 })
    const second = await proof.issue(REQUEST)
    expect(second).not.toBe(first)
    setTime(10_300)
    expect(await proof.consume(REQUEST, second!)).toBe(false)
  })
})
