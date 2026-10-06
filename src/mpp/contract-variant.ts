/**
 * Sibling orderIds for one payment link.
 *
 * The upstream Rozo payment-api keeps an orderId taken forever (even by an
 * expired order), so the same link can only get a second Rozo order under a
 * different orderId. create-invoice uses two deterministic families:
 *
 * - Contract-mode supersede: the pay-in mode is frozen at create time, so an
 *   existing classic order can never be upgraded to Stellar contract pay-in
 *   in place. A SEPARATE contract-mode order is created under
 *   `<linkId>__contract`, then `__contract2`, `__contract3`.
 * - Re-order after an unfunded expiry: when every earlier order for the link
 *   expired without receiving funds and the provider link itself is still
 *   unpaid and valid, a fresh order is created under `<linkId>__retry2`, then
 *   `__retry3` ... `__retry6`. The slots are deterministic so a concurrent
 *   create for the same link collides on upstream's (appId, orderId) unique
 *   key instead of minting a second live order.
 *
 * Everything downstream that treats a Rozo `orderId` as the provider invoice
 * id (webhook fulfillment, invoice-status inference, Stripe invoiceKey) MUST
 * normalize through `baseLinkIdOf` first: the suffixed value is not a provider
 * invoice id, and every sibling shares the ONE per-link fulfillment record so
 * the invoice can only ever be settled once.
 */

const CONTRACT_VARIANT_SUFFIXES = ['__contract', '__contract2', '__contract3']

const RETRY_SUFFIXES = ['__retry2', '__retry3', '__retry4', '__retry5', '__retry6']

const SIBLING_SUFFIX_RE = /__(?:contract[23]?|retry[2-6])$/

/** Strip a sibling-order suffix, returning the real provider link id. */
export function baseLinkIdOf(orderId: string): string {
  return orderId.replace(SIBLING_SUFFIX_RE, '')
}

/** All contract-variant orderIds for a link, in allocation order. */
export function contractVariantIds(linkId: string): string[] {
  return CONTRACT_VARIANT_SUFFIXES.map((s) => `${linkId}${s}`)
}

/** All re-order slots for a link, in allocation order (oldest first). */
export function retryOrderIds(linkId: string): string[] {
  return RETRY_SUFFIXES.map((s) => `${linkId}${s}`)
}
