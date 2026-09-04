/**
 * Sponsor a provider's Stellar account creation.
 *
 * ## Why this is not a money-path change
 *
 * A Stellar address is just a keypair, and the only thing stopping a
 * Base-native provider from having one is the network's base reserve
 * (~1.5 XLM after the trustline entry) — a cost, not a capability. Paying
 * it for them removes the last reason to say "we're Base-only", and it
 * does so without going anywhere near the payout gate: we create an
 * account we hold no key to, and buyers pay it directly afterwards. There
 * is no moment at which a customer's funds are in our custody, which is
 * the whole distinction §1 of the spec turns on.
 *
 * ## What it costs and what bounds it
 *
 * XLM out of the existing `STELLAR_GAS_SECRET` sponsor, a fraction of a
 * dollar per provider. The bounds are deliberate and layered, because this
 * is an unauthenticated endpoint that spends:
 *
 *   - off unless `PROVIDER_SPONSOR_ENABLED === 'true'`;
 *   - a fixed funding amount, never caller-supplied;
 *   - one sponsorship per address, ever (KV marker);
 *   - a daily count cap across all callers.
 *
 * The endpoint fails closed on every error, including an unreadable
 * budget. An account that does not get created is a provider who waits;
 * an unbounded faucet is the gas sponsor drained by a script overnight.
 */

import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import type { Env } from '../index'

/**
 * XLM sent to a newly created account.
 *
 * Stellar's base reserve is 0.5 XLM per entry: 1 for the account itself
 * (2 entries) plus 0.5 for the USDC trustline the provider adds next,
 * which they cannot afford to add if we fund only the minimum. The
 * remainder covers their first few transaction fees. Fixed in code rather
 * than configurable: a caller-supplied amount on an unauthenticated
 * endpoint is a withdrawal API.
 */
const FUNDING_XLM = '2.5'

const SPONSOR_MARKER_PREFIX = 'providerSponsored:'
const DAILY_COUNT_PREFIX = 'providerSponsorCount:'
const DAILY_SPONSOR_CAP = 10

export type SponsorResult =
  | { ok: true; txHash: string; fundedXlm: string }
  | { ok: false; status: number; code: string; detail: string }

function refuse(status: number, code: string, detail: string): SponsorResult {
  return { ok: false, status, code, detail }
}

export async function sponsorStellarAccount(
  env: Env,
  address: string,
): Promise<SponsorResult> {
  if (env.PROVIDER_SPONSOR_ENABLED !== 'true') {
    return refuse(
      404,
      'not_found',
      'Account sponsorship is not enabled on this deployment.',
    )
  }
  if (!StrKey.isValidEd25519PublicKey(address)) {
    return refuse(400, 'bad_address', 'Not a valid Stellar public key (G…).')
  }
  if (!env.STELLAR_GAS_SECRET) {
    return refuse(503, 'sponsor_unavailable', 'No sponsor wallet configured.')
  }

  const marker = SPONSOR_MARKER_PREFIX + address
  if (await env.MPP_STORE.get(marker)) {
    return refuse(
      409,
      'already_sponsored',
      'This address has already been sponsored. One per address.',
    )
  }

  const countKey = DAILY_COUNT_PREFIX + new Date().toISOString().slice(0, 10)
  const rawCount = await env.MPP_STORE.get(countKey)
  const count = rawCount ? Number(rawCount) : 0
  if (!Number.isFinite(count) || count >= DAILY_SPONSOR_CAP) {
    return refuse(429, 'daily_cap', 'The daily sponsorship budget is spent. Retry tomorrow.')
  }

  const horizonUrl = (env.PLAYGROUND_HORIZON_URL || 'https://horizon.stellar.org').replace(/\/+$/, '')
  const server = new Horizon.Server(horizonUrl)

  let sponsor: Keypair
  try {
    sponsor = Keypair.fromSecret(env.STELLAR_GAS_SECRET)
  } catch {
    return refuse(503, 'sponsor_unavailable', 'Sponsor wallet secret is malformed.')
  }

  // Already funded? Creating an existing account fails on-chain anyway;
  // saying so plainly beats surfacing a Horizon op-result code.
  try {
    await server.loadAccount(address)
    await env.MPP_STORE.put(marker, new Date().toISOString())
    return refuse(
      409,
      'already_exists',
      'This account already exists on Stellar and needs no sponsorship.',
    )
  } catch {
    // Expected: a 404 from Horizon means the account is not yet created.
  }

  let sponsorAccount: Account
  try {
    sponsorAccount = await server.loadAccount(sponsor.publicKey())
  } catch (err: any) {
    return refuse(503, 'sponsor_unavailable', `Could not load the sponsor account: ${err?.message}.`)
  }

  const networkPassphrase =
    env.STELLAR_NETWORK === 'stellar:testnet' ? Networks.TESTNET : Networks.PUBLIC

  const tx = new TransactionBuilder(sponsorAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.createAccount({
        destination: address,
        startingBalance: FUNDING_XLM,
      }),
    )
    .setTimeout(60)
    .build()
  tx.sign(sponsor)

  // Reserve the budget BEFORE submitting. If the submission then fails we
  // have over-counted by one, which costs a provider a slot; the other
  // order lets a burst of successful submissions all read the same
  // pre-increment count and blow through the cap.
  await env.MPP_STORE.put(countKey, String(count + 1), { expirationTtl: 172_800 })

  try {
    const result = await server.submitTransaction(tx)
    await env.MPP_STORE.put(marker, new Date().toISOString())
    return { ok: true, txHash: result.hash, fundedXlm: FUNDING_XLM }
  } catch (err: any) {
    // Never echo the Horizon error body: it quotes our own submitted
    // envelope back, including the sponsor account and its sequence.
    const resultCodes = err?.response?.data?.extras?.result_codes
    const code =
      typeof resultCodes?.operations?.[0] === 'string'
        ? resultCodes.operations[0]
        : (resultCodes?.transaction ?? 'submission_failed')
    return refuse(502, 'submission_failed', `Stellar rejected the sponsorship (${code}).`)
  }
}

/** Asset handle for the USDC trustline a provider adds next. Exported for docs/tests. */
export function stellarUsdcAsset(): Asset {
  return new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
}
