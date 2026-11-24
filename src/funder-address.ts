/**
 * The Base USDC funder wallet: the one source of truth for its address.
 *
 * It receives caller USDC (every Coinbase / Bitrefill / TRON / TON order's
 * settlement destination) and pays Coinbase invoices through agentapi's
 * remote signer. This module imports nothing, so webhook.ts,
 * stripe-fulfillment.ts, create-invoice.ts, bitrefill-binding.ts and
 * tron-ton-alpha.ts can all read it without an import cycle.
 *
 * Rotated 2026-11-24: the previous funder 0x2352Fa...1739 was compromised and
 * swept. The new key lives only in the remote signer (Supabase rozo-sg
 * PRIVATE_KEY); this Worker never holds it.
 */
export const BASE_FUNDER_ADDRESS = '0x282bE0C42E5c944b0285CEc363117AB077cC084A'

/**
 * The compromised funder (2026-11-24). NEVER a payout target, a balance to
 * check or a receiver for a new order: anything sent there is swept.
 *
 * Kept for one reason only: TRON / TON alpha orders created before the
 * rotation froze it inside their upstream order digest. tron-ton-alpha.ts
 * replays such an existing order with it (upstream refuses to create a new
 * order from a replay that conflicts, so this never opens one).
 */
export const RETIRED_FUNDER_ADDRESS_20261124 = '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739'
