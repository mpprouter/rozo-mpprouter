/**
 * Deterministic channel-address derivation for the channel factory
 * (mpp-spec §3.4, registration check 1: "the address is what `factory`
 * deploys for that `salt`").
 *
 * Mirrors one-way-channel/contracts/channel-factory/src/lib.rs `open`:
 *
 *   deployment_salt = sha256(xdr(DeploymentSaltPreimage(from, salt)))
 *   channel         = deployer.with_current_contract(deployment_salt)
 *                             .deploy_v2(wasm_hash, ...)
 *
 * `DeploymentSaltPreimage` is a `#[contracttype]` tuple struct, which the
 * Soroban SDK encodes as an ScVal Vec `[Address, Bytes<32>]`. The deployed
 * address is then the standard Soroban contract id:
 *
 *   sha256(HashIdPreimage::ContractId { network_id,
 *          ContractIdPreimage::Address { address: factory, salt: deployment_salt } })
 *
 * Verified against the live pubnet factory `CCR2HE6C…` by simulating `open`
 * with a random salt and comparing the return value (see PR notes). Pure
 * function, no I/O: the register endpoint compares the result with the
 * client's `channel` and refuses on mismatch, so a caller can only register
 * a channel the factory itself deployed for (`from`, `salt`).
 */

import { Address, StrKey, hash, xdr } from '@stellar/stellar-sdk'

/** 32-byte hex salt as the spec transmits it (64 hex chars, any case). */
export const SALT_HEX = /^(0x)?[0-9a-fA-F]{64}$/

/** Parse the spec's hex salt into 32 raw bytes, or null if malformed. */
export function parseSaltHex(salt: unknown): Buffer | null {
  if (typeof salt !== 'string') return null
  const s = salt.trim()
  if (!SALT_HEX.test(s)) return null
  return Buffer.from(s.replace(/^0x/, ''), 'hex')
}

/**
 * The channel address (C…) the factory deploys for (`from`, `salt`) on the
 * network identified by `networkPassphrase`.
 */
export function deriveChannelAddress(
  factory: string,
  from: string,
  salt: Buffer,
  networkPassphrase: string,
): string {
  if (salt.length !== 32) throw new Error('salt must be 32 bytes')
  const preimage = xdr.ScVal.scvVec([
    new Address(from).toScVal(),
    xdr.ScVal.scvBytes(salt),
  ])
  const deploymentSalt = hash(preimage.toXDR())
  const contractIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(factory).toScAddress(),
          salt: deploymentSalt,
        }),
      ),
    }),
  )
  return StrKey.encodeContract(hash(contractIdPreimage.toXDR()))
}
