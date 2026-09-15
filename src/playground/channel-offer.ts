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
 * resolve. So the offer is attached to THOSE endpoints' 402s, and it is
 * deliberately NOT added to the paid proxy's 402: the proxy's channel
 * branch reads the operator-managed stellarChannel:* registry and would not
 * honor a self-registered channel. Advertising it there would be an offer
 * the router cannot keep.
 *
 * Where in the 402 it goes: the JSON BODY, as an x402 envelope
 * `{ x402Version: 2, resource, accepts: [offer] }` merged into whatever the
 * response already says, next to the untouched mppx `WWW-Authenticate`
 * challenge. NOT the `Payment-Required` header: mppx 0.7.0's client decodes
 * that whole header against an `exact`-and-EVM-only schema, throws on any
 * other entry, and the throw discards the WWW-Authenticate challenge with it
 * (docs/archive/rootcause-invalid-base64-json-header-2026-06-24.md). The
 * first deploy of this offer used the header and broke every mppx channel
 * client on the first probe (pubnet E2E, 2026-09-15); it was rolled back
 * within minutes. The body is where x402 v1 carried `accepts[]`, mppx never
 * reads it, and an agent implementing the `channel` scheme is new code that
 * can read it. tests/channel-offer.test.ts runs mppx's own parser over our
 * 402 as the oracle so this cannot regress silently.
 *
 * Every value comes from the same config the register endpoint enforces, so
 * a channel opened from this offer is exactly a channel register accepts.
 */

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
 * The x402 envelope carrying the channel offer as the single `accepts[]`
 * entry, or null when there is no offer to make. Same shape as the
 * `Payment-Required` header body built in mpp/stellar-x402-server.ts, so a
 * client reads both with one parser; here it travels in the response body.
 */
export function channelOfferEnvelope(
  env: Env,
  resourceUrl: string,
  priceRaw?: bigint,
): Record<string, unknown> | null {
  const url = new URL(resourceUrl)
  const offer = channelOffer(env, url.origin, priceRaw)
  if (!offer) return null
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: resourceUrl },
    accepts: [offer],
  }
}

/**
 * Return a copy of `response` whose JSON body carries the channel offer
 * envelope (merged over the existing JSON fields, or as the whole body when
 * the response had none), or the same response when there is no offer or
 * the body is not JSON (an HTML challenge, say). Headers are preserved as
 * they are; nothing is added to `Payment-Required`.
 */
export async function withChannelOffer(
  response: Response,
  env: Env,
  resourceUrl: string,
  priceRaw?: bigint,
): Promise<Response> {
  const envelope = channelOfferEnvelope(env, resourceUrl, priceRaw)
  if (!envelope) return response
  const text = await response.text()
  let existing: Record<string, unknown> = {}
  if (text.trim() !== '') {
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return new Response(text, response)
      }
      existing = parsed
    } catch {
      return new Response(text, response)
    }
  }
  const headers = new Headers(response.headers)
  if (!headers.get('Content-Type')?.includes('json')) headers.set('Content-Type', 'application/json')
  // The response's own error code / message win; the envelope only adds the
  // x402 fields (and the generic error text when the body had none).
  return new Response(JSON.stringify({ ...envelope, ...existing }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
