/**
 * On-chain verification of a playground deposit, against public Horizon.
 *
 * ---------------------------------------------------------------------------
 * Threat model
 * ---------------------------------------------------------------------------
 * `session/open` takes an `intent_id` and a `tx_hash` from an untrusted
 * caller and turns them into spendable credit. Everything that could be
 * substituted must therefore be checked against the chain, not against the
 * request:
 *
 *   - **tx succeeded** — a failed transaction moves no funds but still has a
 *     hash and still appears on Horizon.
 *   - **memo matches the intent nonce** — this is what binds a payment to
 *     *this* intent. Without it, any payment to the router's receiving
 *     account (including one made for an entirely different product) could be
 *     claimed as a playground deposit.
 *   - **destination is the router's receiving account** — a payment to an
 *     attacker's own account would otherwise mint free credit.
 *   - **asset is pubnet USDC from Circle's issuer** — Stellar lets anyone
 *     issue an asset with the code "USDC". Checking the code alone means a
 *     self-issued worthless "USDC" buys real API calls. The issuer check is
 *     the load-bearing half.
 *   - **amount is exact** — not ">=", because the credited amount comes from
 *     the intent; a mismatch means the caller is claiming a different payment.
 *   - **operation source is the intent's account** — stops a third party's
 *     payment from being claimed by whoever spots it on-chain first. Combined
 *     with `intent_id` (returned only to the intent creator) and the memo,
 *     claim-jacking needs both a secret and a matching on-chain fact.
 *
 * The `(tx_hash, op_index)` pair is then consumed atomically in the ledger DO,
 * which is what stops the same payment being credited twice — including the
 * multi-operation case, where one transaction legitimately contains several
 * payments and each may be claimed at most once.
 */

/**
 * Circle's canonical USDC issuer on Stellar pubnet.
 *
 * Matches the pinned value in `src/routes/create-invoice.ts` (chain '1500',
 * stored there in `ASSET:ISSUER` form). Any asset with code "USDC" from any
 * other issuer is a different, worthless token.
 */
export const STELLAR_PUBNET_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

export const STELLAR_USDC_ASSET_CODE = 'USDC'

export const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org'

/** Ceiling on operations inspected per transaction — bounds an unbounded fetch. */
const MAX_OPERATIONS = 200

export type DepositFailure =
  | 'tx_not_found'
  | 'tx_failed'
  | 'memo_mismatch'
  | 'no_matching_payment'
  | 'horizon_unavailable'

export type DepositVerification =
  | { ok: true; opIndex: number }
  | { ok: false; reason: DepositFailure; detail?: string }

interface HorizonTransaction {
  successful?: boolean
  memo_type?: string
  memo?: string
}

interface HorizonOperation {
  type?: string
  asset_type?: string
  asset_code?: string
  asset_issuer?: string
  from?: string
  to?: string
  amount?: string
  source_account?: string
}

/**
 * Fixed-precision comparison of a Horizon amount string against an atomic
 * 7-decimal value. Horizon always renders Stellar amounts with exactly 7
 * decimals ("1.0000000"), which is why `formatUsdc7` produces that same fixed
 * width — but we compare the parsed integers rather than the strings so a
 * future Horizon formatting change cannot silently reject valid deposits.
 */
function horizonAmountToAtomic(amount: string): bigint | null {
  const m = amount.trim().match(/^(\d+)\.(\d{1,7})$|^(\d+)$/)
  if (!m) return null
  if (m[3] !== undefined) return BigInt(m[3]) * 10_000_000n
  return BigInt(m[1]) * 10_000_000n + BigInt(m[2].padEnd(7, '0'))
}

/**
 * Verify the deposit and return the index of the matching payment operation.
 *
 * When several operations in the same transaction match (a caller paying twice
 * in one tx), the FIRST unclaimed match wins; the ledger DO's
 * `(tx_hash, op_index)` guard means the second can be claimed by a second
 * intent but never by the same one twice.
 */
export async function verifyDeposit(args: {
  horizonUrl: string
  txHash: string
  memo: string
  destination: string
  account: string
  amountAtomic: bigint
  fetchImpl?: typeof fetch
}): Promise<DepositVerification> {
  const doFetch = args.fetchImpl ?? fetch
  const base = args.horizonUrl.replace(/\/+$/, '')

  // Reject anything that isn't a 64-hex transaction hash before it reaches
  // Horizon — this value goes into a URL path.
  if (!/^[0-9a-f]{64}$/i.test(args.txHash)) {
    return { ok: false, reason: 'tx_not_found', detail: 'malformed transaction hash' }
  }

  let txResp: Response
  try {
    txResp = await doFetch(`${base}/transactions/${args.txHash}`)
  } catch (e: any) {
    return { ok: false, reason: 'horizon_unavailable', detail: e?.message }
  }
  if (txResp.status === 404) return { ok: false, reason: 'tx_not_found' }
  if (!txResp.ok) {
    return { ok: false, reason: 'horizon_unavailable', detail: `status ${txResp.status}` }
  }

  const tx = (await txResp.json()) as HorizonTransaction
  if (tx.successful !== true) return { ok: false, reason: 'tx_failed' }

  // MEMO_TEXT only. A hash/id memo cannot carry our nonce, and accepting one
  // would mean accepting a transaction whose memo we never actually matched.
  if (tx.memo_type !== 'text' || tx.memo !== args.memo) {
    return { ok: false, reason: 'memo_mismatch' }
  }

  let opsResp: Response
  try {
    opsResp = await doFetch(
      `${base}/transactions/${args.txHash}/operations?limit=${MAX_OPERATIONS}&order=asc`,
    )
  } catch (e: any) {
    return { ok: false, reason: 'horizon_unavailable', detail: e?.message }
  }
  if (!opsResp.ok) {
    return { ok: false, reason: 'horizon_unavailable', detail: `status ${opsResp.status}` }
  }

  const opsBody = (await opsResp.json()) as { _embedded?: { records?: HorizonOperation[] } }
  const records = opsBody._embedded?.records ?? []

  for (let index = 0; index < records.length; index++) {
    const op = records[index]
    if (op.type !== 'payment') continue
    if (op.to !== args.destination) continue
    if (op.asset_code !== STELLAR_USDC_ASSET_CODE) continue
    if (op.asset_issuer !== STELLAR_PUBNET_USDC_ISSUER) continue
    // For a payment operation Horizon sets `from` to the operation's source
    // account; `source_account` is present when the op overrides the tx
    // source. Require whichever is authoritative to be the intent's account.
    const opSource = op.source_account ?? op.from
    if (opSource !== args.account) continue
    if (!op.amount) continue
    if (horizonAmountToAtomic(op.amount) !== args.amountAtomic) continue
    return { ok: true, opIndex: index }
  }

  return { ok: false, reason: 'no_matching_payment' }
}
