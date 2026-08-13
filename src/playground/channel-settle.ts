/**
 * Option A online settlement for the channel playground.
 *
 * Users spend by signing cumulative vouchers to the dedicated collector, then
 * reclaim the unspent remainder with a UNILATERAL Freighter flow (close_start →
 * wait ~100 ledgers → refund). The router therefore has a narrow window to
 * COLLECT what was spent: after the funder calls close_start it must present
 * the latest voucher on-chain (via the channel's close) BEFORE the refund
 * window elapses, or those cents are lost (bounded loss).
 *
 * This runs from the existing every-2-minutes cron. Safety properties:
 *
 *  - P0-C FENCING: settlement acquires the SAME per-channel delivery lock a call
 *    holds across its upstream payment, and atomically marks the channel closed
 *    before the (final) on-chain close. A call in flight blocks settlement (and
 *    vice versa); a call arriving after the close finds the channel closed and
 *    rejects rather than paying upstream — so a paid call can never be stranded
 *    by a close that refunds the remainder.
 *  - P0-D COLLECTOR BINDING: before signing anything, the collector keypair's
 *    PUBLIC key is derived and asserted to equal PLAYGROUND_CHANNEL_TO. A
 *    mismatch aborts the whole run (never sign with a non-collector key). Only
 *    ISOLATED playground channels (pgChannel:*) that still pass provenance and
 *    pay to the collector are ever iterated — the production registry is never
 *    touched.
 *
 * The collector key is used ONLY as the close envelope signer and pays that
 * tx's XLM gas. If the key/var is unset or mismatched, settlement is skipped and
 * logged (fail-safe, bounded loss).
 */

import { close as sdkClose, getChannelState } from '@stellar/mpp/channel/server'
import { Keypair } from '@stellar/stellar-sdk'
import type { Env } from '../index'
import { parseUsd } from './amount'
import { channelCollector, channelPlaygroundEnabled } from './channel-config'
import { listPgChannels, pgChannelProvenanceOk } from './channel-pg-store'
import {
  fenceChannelPersistent,
  getLatestVoucher,
  markChannelClosed,
  markVoucherSettled,
  markVoucherWrittenOff,
} from './channel-voucher-store'
import {
  acquireChannelDeliveryLock,
  releaseChannelDeliveryLock,
  revalidateChannelDeliveryLock,
} from '../mpp/stellar-channel-dispatch'

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
    feePayer: { envelopeSigner: string; feeBumpSigner?: string }
    maxFeeBumpStroops?: number
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
 * True iff PLAYGROUND_CHANNEL_SIGNER_SECRET is set AND its public key equals the
 * configured collector (PLAYGROUND_CHANNEL_TO). This is the P0-D fail-closed
 * gate: we never sign a close with a key that is not the configured collector.
 */
export function collectorKeyMatches(env: Env): boolean {
  const secret = env.PLAYGROUND_CHANNEL_SIGNER_SECRET
  const collector = channelCollector(env)
  if (!secret || !collector) return false
  try {
    return Keypair.fromSecret(secret).publicKey() === collector
  } catch {
    return false
  }
}

/**
 * Settle one channel if due. Acquires the delivery lock FIRST (skips if a live
 * call holds it), then RE-READS the latest voucher UNDER the lock (P0-1) — never
 * a snapshot taken before the lock was held, which could be stale by a call
 * that committed a higher cumulative in the meantime. Marks the channel closed
 * to fence later calls, then submits the collector-signed close with that
 * latest voucher. Returns the tx hash, or null when nothing was due / the lock
 * was busy.
 */
export async function settleOneChannel(
  env: Env,
  channelContract: string,
  deps: SettleDeps = DEFAULT_DEPS,
): Promise<string | null> {
  // Fence: take the SAME lock calls use. A live call holds it → skip this tick;
  // a leaked/expired lock is taken over (self-heal). Everything below runs
  // strictly under the lock.
  const lockId = crypto.randomUUID()
  const acquired = await acquireChannelDeliveryLock(env, channelContract, lockId)
  if (!acquired) return null
  try {
    // Authoritative read UNDER the lock — this is the latest committed voucher.
    const voucher = await getLatestVoucher(env, channelContract)
    if (!voucher) return null

    const state = await deps.getChannelState({
      channel: channelContract,
      network: env.STELLAR_NETWORK,
      rpcUrl: env.STELLAR_RPC_URL,
    })
    const closing = state.closeEffectiveAtLedger != null

    // Round-8: the moment the cron observes close_start, durably fence the
    // channel so ALL subsequent calls reject immediately (410) WITHOUT an RPC —
    // even if there is nothing to settle this tick. This closes the TOCTOU where
    // a funder spends on a closing channel and refunds before we collect.
    if (closing) await fenceChannelPersistent(env, channelContract)

    const cumulativeRaw = BigInt(voucher.cumulativeRaw)
    const unsettled = cumulativeRaw - BigInt(voucher.lastSettledRaw || '0')
    if (unsettled <= 0n) return null
    if (!closing && unsettled < SETTLE_THRESHOLD_RAW) return null

    // P0-3: getChannelState is a network RPC that could stall past the lock TTL,
    // during which a replacement call may pay/persist a higher voucher. Re-check
    // the fencing token immediately before the (final, irreversible) close — if
    // superseded, abort and let the next cron tick retry under a fresh lock and
    // a fresh latest-voucher read, rather than close with a now-stale voucher.
    if (!(await revalidateChannelDeliveryLock(env, channelContract, lockId))) {
      console.warn(
        `[channel-settle] lock superseded before close on ${channelContract}; retrying next tick`,
      )
      return null
    }

    // Mark closed BEFORE the (final) close so any call that acquires the lock
    // after we release it rejects instead of paying upstream. Write BOTH the
    // fast atomic marker and the durable KV fence so the dispatch gate rejects
    // regardless of lock state even after we release.
    await markChannelClosed(env, channelContract)
    await fenceChannelPersistent(env, channelContract)

    const signature = decodeVoucherSignature(voucher.signature)
    let txHash: string
    try {
      txHash = await deps.close({
        channel: channelContract,
        amount: cumulativeRaw,
        signature,
        // feeBumpSigner wraps the close in a FeeBumpTransaction at 10x the
        // inner fee (capped below). Without it the SDK builds the inner tx at
        // DEFAULT_FEE=100 stroops inclusion — the known mainnet-Soroban
        // timeout trap (same root cause as the frontend open/close fee bug):
        // the 2026-08-13 e2e run's $0.211 voucher was never collected because
        // every cron close timed out unincluded until the funder's refund
        // window elapsed.
        feePayer: {
          envelopeSigner: env.PLAYGROUND_CHANNEL_SIGNER_SECRET!,
          feeBumpSigner: env.PLAYGROUND_CHANNEL_SIGNER_SECRET!,
        },
        maxFeeBumpStroops: 10_000_000, // 1 XLM cap on the bumped fee
        network: env.STELLAR_NETWORK,
        rpcUrl: env.STELLAR_RPC_URL,
      })
    } catch (err: any) {
      // The funder's unilateral refund already emptied the channel: the close's
      // token transfer fails with "balance is not sufficient". The debt is
      // unrecoverable ON-CHAIN (bounded loss by design — deposit cap), so mark
      // it settled to stop the cron retrying a dead channel every 2 minutes,
      // and log the write-off amount for the operator ledger.
      if (String(err?.message ?? err).includes('balance is not sufficient')) {
        // Terminal write-off record FIRST (reconciliation source of truth:
        // forgiven debt, not collected funds), then advance the settled
        // watermark only to stop the cron retrying a dead channel.
        await markVoucherWrittenOff(
          env,
          channelContract,
          cumulativeRaw.toString(),
          'funder refunded before collection',
        )
        await markVoucherSettled(env, channelContract, cumulativeRaw.toString())
        console.error(
          `[channel-settle] WRITE-OFF ${voucher.amountDecimal} on ${channelContract}: ` +
            'channel already refunded by the funder before collection (bounded loss)',
        )
        return null
      }
      throw err
    }
    await markVoucherSettled(env, channelContract, cumulativeRaw.toString())
    console.log(
      `[channel-settle] collected ${voucher.amountDecimal} on ${channelContract} tx=${txHash}`,
    )
    return txHash
  } finally {
    await releaseChannelDeliveryLock(env, channelContract, lockId).catch(() => {})
  }
}

/**
 * Cron entry point: settle every ISOLATED playground channel that is due.
 * Fail-safe and fail-closed — no signer / a collector-key mismatch skips the
 * whole run (P0-D), and a per-channel failure never aborts the others.
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
  // P0-D: never sign with a key that is not the configured collector.
  if (!collectorKeyMatches(env)) {
    console.error(
      '[channel-settle] collector signer public key does NOT match PLAYGROUND_CHANNEL_TO — refusing to sign any close',
    )
    return
  }

  let channels: Awaited<ReturnType<typeof listPgChannels>> = []
  try {
    channels = await listPgChannels(env)
  } catch (e: any) {
    console.error(`[channel-settle] listing playground channels failed: ${e?.message}`)
    return
  }
  for (const state of channels) {
    try {
      // Only settle channels that still pass provenance and pay the collector.
      if (!pgChannelProvenanceOk(state, env)) continue
      // Cheap pre-gate to skip channels with no voucher at all; settleOneChannel
      // re-reads the authoritative latest voucher UNDER the lock (P0-1).
      const voucher = await getLatestVoucher(env, state.channelContract)
      if (!voucher) continue
      await settleOneChannel(env, state.channelContract, deps)
    } catch (e: any) {
      console.error(`[channel-settle] settle failed for ${state.channelContract}: ${e?.message}`)
    }
  }
}
