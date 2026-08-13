/**
 * Playground channel voucher dispatch — resolves ONLY from the isolated
 * playground registry (pgChannel/pgAgent), never the production
 * stellarChannel/stellarAgent registry the paid proxy uses.
 *
 * P0-A fix: a channel registered by the production path or by pre-provenance
 * playground code must NOT be usable here. So this resolver reads the pg
 * namespace and re-asserts the provenance (WASM hash + to == collector +
 * schema version) that register stored, against the CURRENT config, before
 * building the verify engine.
 *
 * The verify engine itself is the SAME production primitive
 * (`createStellarChannelPayment`), which is generic over (channel,
 * commitmentKey) and whose mppx cumulative store is keyed by the unique channel
 * contract address — so there is no cross-talk with production channels, which
 * have different contract addresses.
 */

import {
  createStellarChannelPayment,
  extractAgentAccount,
  StellarChannelNotRegisteredError,
} from '../mpp/stellar-channel-dispatch'
import type { Env } from '../index'
import { getPgChannel, getPgChannelForAgent, pgChannelProvenanceOk } from './channel-pg-store'

export async function resolvePgChannelMppx(
  env: Env,
  authHeader: string | null,
  agentHint?: string | null,
): Promise<{
  mppx: ReturnType<typeof createStellarChannelPayment>
  channelContract: string
  agentAccount: string
  channelCurrency: string
  /** On-chain USDC deposit captured at register (7-decimal atomic string). The
   * hard cap on cumulative spend — the router must reject any voucher whose new
   * cumulative would exceed it. */
  depositRaw: string
}> {
  const agentAccount = extractAgentAccount(authHeader) ?? agentHint ?? null
  if (!agentAccount) {
    throw new Error(
      'No stellar.channel credential with parseable source in Authorization header and no ?agent= hint',
    )
  }
  if (!/^G[A-Z2-7]{55}$/.test(agentAccount)) {
    throw new Error(`invalid Stellar G address: ${agentAccount}`)
  }
  const channelContract = await getPgChannelForAgent(env, agentAccount)
  if (!channelContract) throw new StellarChannelNotRegisteredError(agentAccount)

  const state = await getPgChannel(env, channelContract)
  if (!state) throw new StellarChannelNotRegisteredError(agentAccount)

  // Re-assert provenance at USE time — a stored record that predates provenance
  // verification (wrong version) or a config drift (collector/WASM rotated)
  // fails closed here rather than being trusted.
  if (!pgChannelProvenanceOk(state, env)) {
    throw new StellarChannelNotRegisteredError(agentAccount)
  }

  const mppx = createStellarChannelPayment(env, channelContract, state.commitmentKey)
  return {
    mppx,
    channelContract,
    agentAccount: state.agentAccount,
    channelCurrency: state.currency,
    depositRaw: state.depositRaw,
  }
}
