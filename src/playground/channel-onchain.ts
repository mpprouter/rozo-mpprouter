/**
 * On-chain verification for the non-custodial channel playground register
 * endpoint.
 *
 * The admin script scripts/admin/register-stellar-channel.ts deliberately
 * SKIPS on-chain verification because it trusts an operator. A public endpoint
 * cannot: an anonymous browser tells the router "here is a channel, please
 * honor its vouchers", and the router must independently confirm the channel
 * really pays the router, in the right token, funded by the claimed account,
 * with the claimed commitment key — before it writes anything to KV. This is
 * the trust boundary between the browser and the router's money.
 *
 * Two reads, both zero-cost (no funds move, no signing):
 *   1. getLedgerEntries on the channel's contract-instance entry → all of the
 *      channel's config (token / from / to / commitment_key / refund period)
 *      in one round trip. Every field is `.instance()` storage in the contract
 *      (see one-way-channel/contracts/channel/src/lib.rs __constructor), so it
 *      is all in the single instance ledger entry.
 *   2. simulateTransaction of the channel's read-only `balance()` getter → the
 *      real on-chain balance, to confirm the channel is actually funded.
 *
 * The network read is isolated in `readChannelOnChain` so the pure comparison
 * logic (`checkChannelMatches`) is trivially unit-testable without a live RPC.
 */

import {
  Account,
  Address,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

/** Raw on-chain channel configuration, decoded into plain strings. */
export interface OnChainChannel {
  /** Token SAC contract address (C...). */
  token: string
  /** Funder account (G...). */
  from: string
  /** Recipient account (G...). */
  to: string
  /** commitment_key as lowercase hex of the raw 32-byte ed25519 public key. */
  commitmentKeyHex: string
  /** refund_waiting_period in ledgers. */
  refundWaitingPeriod: number
  /** Current on-chain channel balance, 7-decimal USDC atomic units, as string. */
  balanceRaw: string
}

/** What the router requires the on-chain channel to look like. */
export interface ChannelExpectation {
  routerPublic: string
  usdcSac: string
  funder: string
  /** Submitted commitment key in G-strkey form. */
  commitmentKeyG: string
  refundWaitingPeriod: number
  minDepositRaw: bigint
}

export type ChannelCheck =
  | { ok: true }
  | { ok: false; reason: string; detail: string }

/**
 * Pure comparison of the on-chain channel against what the router requires.
 * No I/O — every branch is a substitution attack the register endpoint must
 * refuse. Each mismatch gets its own reason so the caller (and the tests) can
 * tell exactly which invariant failed.
 */
export function checkChannelMatches(
  onchain: OnChainChannel,
  expected: ChannelExpectation,
): ChannelCheck {
  if (onchain.to !== expected.routerPublic) {
    return {
      ok: false,
      reason: 'recipient_mismatch',
      detail: 'channel recipient (to) is not this router',
    }
  }
  if (onchain.token !== expected.usdcSac) {
    return {
      ok: false,
      reason: 'token_mismatch',
      detail: 'channel token is not the pubnet USDC SAC',
    }
  }
  if (onchain.from !== expected.funder) {
    return {
      ok: false,
      reason: 'funder_mismatch',
      detail: 'channel funder does not match the submitted account',
    }
  }
  let submittedHex: string
  try {
    submittedHex = Buffer.from(
      StrKey.decodeEd25519PublicKey(expected.commitmentKeyG),
    ).toString('hex')
  } catch {
    return {
      ok: false,
      reason: 'invalid_commitment_key',
      detail: 'submitted commitment key is not a valid ed25519 public key',
    }
  }
  if (onchain.commitmentKeyHex.toLowerCase() !== submittedHex.toLowerCase()) {
    return {
      ok: false,
      reason: 'commitment_key_mismatch',
      detail: 'channel commitment key does not match the submitted key',
    }
  }
  if (onchain.refundWaitingPeriod !== expected.refundWaitingPeriod) {
    return {
      ok: false,
      reason: 'refund_period_mismatch',
      detail: `channel refund_waiting_period must be ${expected.refundWaitingPeriod}`,
    }
  }
  let balance: bigint
  try {
    balance = BigInt(onchain.balanceRaw)
  } catch {
    return { ok: false, reason: 'bad_balance', detail: 'on-chain balance unreadable' }
  }
  if (balance < expected.minDepositRaw) {
    return {
      ok: false,
      reason: 'insufficient_deposit',
      detail: 'channel is not funded above the minimum deposit',
    }
  }
  return { ok: true }
}

function networkPassphrase(network: string): string {
  return network === 'stellar:testnet' ? Networks.TESTNET : Networks.PUBLIC
}

/** Decode a DataKey unit-enum storage key (Vec[Symbol]) to its variant name. */
function dataKeyName(key: xdr.ScVal): string | null {
  if (key.switch().name !== 'scvVec') return null
  const vec = key.vec()
  if (!vec || vec.length !== 1) return null
  const sym = vec[0]
  if (sym.switch().name !== 'scvSymbol') return null
  return sym.sym().toString()
}

/**
 * Read the channel's on-chain configuration + balance. Throws on any RPC or
 * decode failure so the caller returns a 502 rather than trusting the client.
 */
export async function readChannelOnChain(
  env: { STELLAR_RPC_URL: string; STELLAR_NETWORK: string; STELLAR_ROUTER_PUBLIC: string },
  channelContract: string,
): Promise<OnChainChannel> {
  const server = new rpc.Server(env.STELLAR_RPC_URL, {
    allowHttp: env.STELLAR_RPC_URL.startsWith('http://'),
  })

  // 1) Contract instance entry — carries all `.instance()` storage in one read.
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(channelContract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )
  const entriesResp = await server.getLedgerEntries(instanceKey)
  const entry = entriesResp.entries?.[0]
  if (!entry) {
    throw new Error(`channel ${channelContract} has no contract-instance ledger entry`)
  }
  const instanceVal = entry.val.contractData().val()
  if (instanceVal.switch().name !== 'scvContractInstance') {
    throw new Error('unexpected instance ledger entry shape')
  }
  const storage = instanceVal.instance().storage() ?? []

  const config: Partial<Record<string, xdr.ScVal>> = {}
  for (const mapEntry of storage) {
    const name = dataKeyName(mapEntry.key())
    if (name) config[name] = mapEntry.val()
  }

  const tokenScv = config['Token']
  const fromScv = config['From']
  const toScv = config['To']
  const commitScv = config['CommitmentKey']
  const periodScv = config['RefundWaitingPeriod']
  if (!tokenScv || !fromScv || !toScv || !commitScv || !periodScv) {
    throw new Error('channel instance storage is missing required config keys')
  }

  const token = String(scValToNative(tokenScv))
  const from = String(scValToNative(fromScv))
  const to = String(scValToNative(toScv))
  const commitmentKeyHex = Buffer.from(commitScv.bytes()).toString('hex')
  const refundWaitingPeriod = Number(scValToNative(periodScv))

  // 2) balance() — read-only simulate, no signing, no fee spent.
  const contract = new Contract(channelContract)
  const source = new Account(env.STELLAR_ROUTER_PUBLIC, '0')
  const tx = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: networkPassphrase(env.STELLAR_NETWORK),
  })
    .addOperation(contract.call('balance'))
    .setTimeout(30)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`balance() simulation failed: ${sim.error}`)
  }
  const retval = sim.result?.retval
  if (!retval) {
    throw new Error('balance() simulation returned no value')
  }
  const balanceRaw = BigInt(scValToNative(retval) as bigint | number | string).toString()

  return { token, from, to, commitmentKeyHex, refundWaitingPeriod, balanceRaw }
}
