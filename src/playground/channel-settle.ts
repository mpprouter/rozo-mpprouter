/**
 * Option A online settlement for the channel playground.
 *
 * Users spend by signing cumulative vouchers to the dedicated collector
 * account, then reclaim the unspent remainder with a UNILATERAL Freighter flow
 * (close_start → wait ~100 ledgers → refund). The router therefore has a narrow
 * window to COLLECT what was spent: after the funder calls close_start it must
 * present the latest voucher on-chain (via the channel's close/settle) BEFORE
 * the refund window elapses, or those cents are lost (bounded loss).
 *
 * This runs from the existing every-2-minutes cron. Every ~2 min it reads each
 * registered channel's on-chain state and, if the channel is closing (dispute
 * detected) or the unsettled amount crosses a small threshold, submits a
 * `close` signed by the COLLECTOR key (PLAYGROUND_CHANNEL_SIGNER_SECRET). The
 * ~10-min window gives several ticks of headroom.
 *
 * SECURITY: the collector key is passed ONLY as `feePayer.envelopeSigner` to
 * the SDK's `close()` — it signs the settle/close envelope and pays that tx's
 * XLM gas, nothing else. It never touches the treasury (STELLAR_ROUTER_PUBLIC)
 * and can move funds only out of a channel that already pays TO the collector.
 * If the key/var is unset, settlement is skipped and logged (fail-safe).
 */

import { close as sdkClose, getChannelState } from '@stellar/mpp/channel/server'
import type { Env } from '../index'
import { listStellarChannels } from '../mpp/stellar-channel-store'
import { parseUsd } from './amount'
import { channelPlaygroundEnabled } from './channel-config'
import {
  getLatestVoucher,
  markVoucherSettled,
  type LatestVoucher,
} from './channel-voucher-store'

/** Collect once the unsettled amount reaches this, even without a close_start. */
const SETTLE_THRESHOLD_RAW = parseUsd('0.2')

/** Injected on-chain seam so tests need no live RPC or real signer. */
export interface SettleDeps {
  getChannelState: (p: {
    channel: string
    network?: string
    rpcUrl?: string
  }) => Promise<{ closeEffectiveAtLedger: number | null; currentLedger: number }>
  close: (p: {
    channel: string
    amount: bigint
    signature: Uint8Array
    feePayer: { envelopeSigner: string }
    network?: string
    rpcUrl?: string
  }) => Promise<string>
}

const DEFAULT_DEPS: SettleDeps = {
  getChannelState: p => getChannelState(p as any) as any,
  close: p => sdkClose(p as any),
}

/**
 * Decode the credential's signature string into the raw 64-byte ed25519
 * signature the contract's `close`/`settle` expects. Accepts hex (128 chars)
 * or base64.
 */
export function decodeVoucherSignature(sig: string): Uint8Array {
  const s = sig.trim()
  if (/^[0-9a-fA-F]{128}$/.test(s)) return new Uint8Array(Buffer.from(s, 'hex'))
  const buf = Buffer.from(s, 'base64')
  if (buf.length !== 64) throw new Error(`voucher signature is not 64 bytes (got ${buf.length})`)
  return new Uint8Array(buf)
}

/**
 * Decide whether a channel needs settling right now and, if so, submit the
 * collector-signed close with the latest stored voucher. Returns the tx hash
 * when a settlement was submitted, or null when nothing was due.
 */
export async function settleOneChannel(
  env: Env,
  channelContract: string,
  voucher: LatestVoucher,
  deps: SettleDeps = DEFAULT_DEPS,
): Promise<string | null> {
  const cumulativeRaw = BigInt(voucher.cumulativeRaw)
  const settledRaw = BigInt(voucher.lastSettledRaw || '0')
  const unsettled = cumulativeRaw - settledRaw
  if (unsettled <= 0n) return null

  const state = await deps.getChannelState({
    channel: channelContract,
    network: env.STELLAR_NETWORK,
    rpcUrl: env.STELLAR_RPC_URL,
  })
  const closing = state.closeEffectiveAtLedger != null
  if (!closing && unsettled < SETTLE_THRESHOLD_RAW) return null

  const signature = decodeVoucherSignature(voucher.signature)
  const txHash = await deps.close({
    channel: channelContract,
    amount: cumulativeRaw,
    signature,
    feePayer: { envelopeSigner: env.PLAYGROUND_CHANNEL_SIGNER_SECRET! },
    network: env.STELLAR_NETWORK,
    rpcUrl: env.STELLAR_RPC_URL,
  })
  await markVoucherSettled(env, channelContract, cumulativeRaw.toString())
  console.log(
    `[channel-settle] collected ${voucher.amountDecimal} on ${channelContract} tx=${txHash}`,
  )
  return txHash
}

/**
 * Cron entry point: settle every registered playground channel that is due.
 * Fail-safe — a missing collector key skips settlement (bounded loss), and a
 * per-channel failure never aborts the others.
 */
export async function settlePlaygroundChannels(
  env: Env,
  deps: SettleDeps = DEFAULT_DEPS,
): Promise<void> {
  if (!channelPlaygroundEnabled(env)) return
  if (!env.PLAYGROUND_CHANNEL_SIGNER_SECRET) {
    console.warn('[channel-settle] PLAYGROUND_CHANNEL_SIGNER_SECRET unset — skipping settlement')
    return
  }
  let channels: Array<{ channelContract: string }> = []
  try {
    channels = await listStellarChannels(env)
  } catch (e: any) {
    console.error(`[channel-settle] listing channels failed: ${e?.message}`)
    return
  }
  for (const { channelContract } of channels) {
    try {
      const voucher = await getLatestVoucher(env, channelContract)
      if (!voucher) continue
      await settleOneChannel(env, channelContract, voucher, deps)
    } catch (e: any) {
      console.error(`[channel-settle] settle failed for ${channelContract}: ${e?.message}`)
    }
  }
}
