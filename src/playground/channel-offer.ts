/**
 * The `scheme: "channel"` offer (mpp-spec §3.4 "Channel offer").
 *
 * A router serving many agents cannot be configured with a channel before the
 * agent opens it, so the 402 itself carries everything an agent needs to open
 * one against the factory and announce it: the asset, the recipient the
 * channel must be constructed with, the factory and its code hash, the
 * refund window the router enforces, the register endpoint and the minimum
 * deposit. The agent then registers (channel-register-auth.ts, check 6) and
 * the per-call flow is the unchanged MPP voucher.
 *
 * Where it is emitted. The offer names `extra.register`, and a channel
 * registered there lives in the ISOLATED playground registry (pgChannel:*),
 * which only the metered channel endpoints under /v1/playground/channel/*
 * resolve. So the offer is attached to THOSE endpoints' 402s, as an x402 v2
 * `Payment-Required` header next to the mppx `WWW-Authenticate` challenge,
 * and it is deliberately NOT added to the paid proxy's 402: the proxy's
 * channel branch reads the operator-managed stellarChannel:* registry and
 * would not honor a self-registered channel. Advertising it there would be
 * an offer the router cannot keep.
 *
 * Every value comes from the same config the register endpoint enforces, so
 * a channel opened from this offer is exactly a channel register accepts.
 */

import { safeBase64Encode } from '@x402/core/utils'
import type { Env } from '../index'
import { getStellarUsdcSac } from '../mpp/stellar-server'
import {
  CHANNEL_MIN_DEPOSIT_USD,
  CHANNEL_REFUND_WAITING_PERIOD,
  channelCollector,
  channelFactoryAddress,
  channelPlaygroundEnabled,
  channelWasmHash,
} from './channel-config'

export const CHANNEL_REGISTER_PATH = '/v1/playground/channel/register'

export interface ChannelOffer {
  scheme: 'channel'
  network: string
  asset: string
  payTo: string
  /** This call's voucher increment, 7-decimal atomic. Absent on a generic offer. */
  amount?: string
  extra: {
    factory: string
    wasmHash: string
    refundWaitingPeriodMinLedgers: number
    register: string
    /** Human-readable amount in `asset`, per spec. */
    minDeposit: string
  }
}

/**
 * Build the offer, or null when any trust anchor is missing (factory,
 * collector, WASM hash) or the channel surface is off. Null means "advertise
 * nothing": register would refuse the channel anyway (fail closed), so the
 * 402 must not invite the agent to open one.
 */
export function channelOffer(
  env: Env,
  origin: string,
  priceRaw?: bigint,
): ChannelOffer | null {
  if (!channelPlaygroundEnabled(env)) return null
  const factory = channelFactoryAddress(env)
  const collector = channelCollector(env)
  const wasmHash = channelWasmHash(env)
  if (!factory || !collector || !wasmHash) return null
  return {
    scheme: 'channel',
    network: env.STELLAR_NETWORK,
    asset: getStellarUsdcSac(env),
    payTo: collector,
    ...(priceRaw !== undefined ? { amount: priceRaw.toString() } : {}),
    extra: {
      factory,
      wasmHash,
      refundWaitingPeriodMinLedgers: CHANNEL_REFUND_WAITING_PERIOD,
      register: `${origin}${CHANNEL_REGISTER_PATH}`,
      minDeposit: CHANNEL_MIN_DEPOSIT_USD,
    },
  }
}

/**
 * x402 v2 `Payment-Required` header value carrying the channel offer as the
 * single `accepts[]` entry, or null when there is no offer to make. Same
 * envelope as buildX402PaymentRequiredHeader in mpp/stellar-x402-server.ts
 * so a client reads both 402 families with one parser.
 */
export function buildChannelPaymentRequiredHeader(
  env: Env,
  resourceUrl: string,
  priceRaw?: bigint,
): string | null {
  const url = new URL(resourceUrl)
  const offer = channelOffer(env, url.origin, priceRaw)
  if (!offer) return null
  return safeBase64Encode(
    JSON.stringify({
      x402Version: 2,
      error: 'Payment required',
      resource: { url: resourceUrl },
      accepts: [offer],
    }),
  )
}

/** Return a copy of `response` with the channel offer header attached (or the same response if there is no offer). */
export function withChannelOffer(
  response: Response,
  env: Env,
  resourceUrl: string,
  priceRaw?: bigint,
): Response {
  const header = buildChannelPaymentRequiredHeader(env, resourceUrl, priceRaw)
  if (!header) return response
  const headers = new Headers(response.headers)
  headers.set('Payment-Required', header)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
