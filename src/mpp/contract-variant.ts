/**
 * Contract-mode supersede orderId variants.
 *
 * The upstream Rozo payment-api freezes the pay-in mode at create time and an
 * orderId stays taken forever (even by an expired order), so an existing
 * classic order can never be upgraded to Stellar contract pay-in mode in
 * place. create-invoice instead creates a SEPARATE contract-mode order under
 * a deterministic variant of the Coinbase link id. Slots are versioned so an
 * expired variant does not dead-end the link: `<linkId>__contract`, then
 * `<linkId>__contract2`, `<linkId>__contract3`.
 *
 * Everything downstream that treats a Rozo `orderId` as the Coinbase link id
 * (webhook fulfillment, invoice-status inference) MUST normalize through
 * `baseLinkIdOf` first — the suffixed value is not a provider invoice id.
 */

const CONTRACT_VARIANT_SUFFIXES = ['__contract', '__contract2', '__contract3']

const CONTRACT_VARIANT_SUFFIX_RE = /__contract[23]?$/

/** Strip a contract-variant suffix, returning the real Coinbase link id. */
export function baseLinkIdOf(orderId: string): string {
  return orderId.replace(CONTRACT_VARIANT_SUFFIX_RE, '')
}

/** All contract-variant orderIds for a link, in allocation order. */
export function contractVariantIds(linkId: string): string[] {
  return CONTRACT_VARIANT_SUFFIXES.map((s) => `${linkId}${s}`)
}
