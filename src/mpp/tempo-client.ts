/**
 * Tempo MPP Client — pays merchants on Tempo L2.
 *
 * Two modes:
 *
 * 1. Charge (`payMerchant`) — single-shot 402 settle per request.
 *    Used by fixed-price merchants (Firecrawl, Exa, Parallel). mppx
 *    client auto-handles the challenge: 402 → sign TIP-20 transfer
 *    from Router's EVM wallet → retry with credential → 200.
 *
 * 2. Session (`payMerchantSession`) — long-lived payment channel
 *    with streaming cumulative vouchers. Used by dynamic-price
 *    merchants (OpenRouter). The channel is opened ONCE on-chain
 *    via `scripts/open-channel.ts`, then every agent request
 *    bumps an off-chain cumulative voucher signed by the Router.
 *    mppx still handles the 402 dance; we supply the manual
 *    voucher context via the `onChallenge` hook.
 *
 * Why both on one client: the `Mppx.create` API registers a list
 * of methods and dispatches on the merchant's challenge intent
 * (`charge` vs `session`), so a single client can handle either
 * kind of merchant. We keep them in separate helpers because the
 * session path needs to read + write channel state in KV on every
 * request, and the charge path should not pay that overhead.
 */

import { Mppx, tempo, session as tempoSession } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'
import type { Env } from '../index'
import {
  bumpCumulative,
  getTempoChannel,
  type TempoChannelState,
} from './channel-store'

/**
 * Minimal shape of the ChannelEntry that mppx passes to the
 * `onChannelUpdate` callback. Defined here rather than imported
 * from `mppx/dist/tempo/client/ChannelOps.js` because that path
 * is a non-public internal module (see session-support-plan.md
 * §8 risks). If a future mppx release moves or renames the type
 * we only need to update this local stub, not a deep import path.
 */
type ChannelEntryLike = {
  channelId: `0x${string}`
  cumulativeAmount: bigint
  escrowContract: `0x${string}`
  chainId: number
  opened: boolean
}

/**
 * Error thrown by `payMerchantSession` when a merchant has not had
 * its channel opened yet. The proxy catches this and returns a 503
 * to the agent with a clear "session not installed" message so the
 * operator knows to run `scripts/open-channel.ts`.
 */
export class ChannelNotInstalledError extends Error {
  constructor(public readonly merchantId: string) {
    super(
      `No Tempo channel installed for merchant "${merchantId}". ` +
        `Run scripts/open-channel.ts to open one.`,
    )
    this.name = 'ChannelNotInstalledError'
  }
}

/**
 * Build an mppx client that can handle both tempo.charge and
 * tempo.session challenges.
 *
 * In manual session mode we pass an `onChannelUpdate` callback
 * that mppx calls after every voucher sign; that's where we
 * persist the new cumulative watermark back to KV. Without this
 * callback a cold Worker restart would sign a voucher using the
 * stored cumulative and immediately get rejected by the merchant
 * ("non-monotonic cumulative") because the merchant already has
 * a higher cumulative from the previous voucher.
 *
 * The charge method has no equivalent callback — it's stateless
 * per request, which is exactly why it fits a Worker cleanly.
 */
function createTempoClientInternal(
  env: Env,
  opts: {
    /**
     * onChallenge hook forwarded to Mppx.create. Used by the
     * session path to compute `cumulativeAmountRaw = stored + delta`
     * at the moment the 402 arrives, and to call `createCredential`
     * with the manual voucher context.
     */
    onChallenge?: Parameters<typeof Mppx.create>[0]['onChallenge']
    /**
     * Called by mppx after every successful voucher sign. We use
     * it to bump the KV watermark. mppx passes `cumulativeAmount`
     * as a bigint here, which matches what the KV store already
     * stores as a base-unit string.
     */
    onChannelUpdate?: (entry: ChannelEntryLike) => void | Promise<void>
  } = {},
) {
  const account = privateKeyToAccount(env.TEMPO_ROUTER_PRIVATE_KEY as `0x${string}`)

  // Two methods registered:
  //
  // 1. `tempo.charge` — single-shot intent, unchanged.
  // 2. `session` (the raw manual-mode `session()` from
  //    `mppx/dist/tempo/client/Session.js`, re-exported at the
  //    top level of `mppx/client` as `session`). We deliberately
  //    do NOT use `tempo.session` because that alias actually
  //    resolves to `sessionManager` — the AUTO-mode orchestrator
  //    that would try to open channels itself whenever it sees
  //    a 402. Manual mode is what lets us pre-open the channel
  //    via `scripts/open-channel.ts` and then feed per-request
  //    voucher context through `onChallenge`.
  //
  // No `deposit` parameter on the session method — its presence
  // is what flips the method into auto mode. Leaving it unset
  // keeps us in manual mode.
  const mppx = Mppx.create({
    methods: [
      tempo.charge({ account }),
      tempoSession({
        account,
        onChannelUpdate: opts.onChannelUpdate as any,
      }),
    ],
    polyfill: false,
    onChallenge: opts.onChallenge,
  } as any)

  return mppx
}

/**
 * Pay a Tempo merchant for a single fixed-price request. The
 * mppx client handles the full 402 dance automatically via the
 * registered `tempo.charge` method.
 *
 * Unchanged from the pre-session Router — callers that speak
 * tempo.charge (Firecrawl, Exa, Parallel) must NOT switch to
 * `payMerchantSession`.
 */
export async function payMerchant(
  env: Env,
  merchantUrl: string,
  init?: RequestInit,
): Promise<Response> {
  const client = createTempoClientInternal(env)
  return client.fetch(merchantUrl, init)
}

/**
 * Add two base-unit cumulative amounts using BigInt so we don't
 * lose precision on amounts above 2^53. Both inputs and output
 * are non-negative integer strings.
 */
function addRaw(a: string, bRaw: string): string {
  return (BigInt(a) + BigInt(bRaw)).toString()
}

/**
 * Pay a Tempo merchant through an existing payment channel.
 *
 * Prerequisites:
 *   - `scripts/open-channel.ts` has been run for this merchantId
 *     and the resulting `TempoChannelState` is in KV.
 *   - The merchant speaks `tempo.session` on this route.
 *
 * Flow:
 *   1. Load the current channel state from KV — need the stored
 *      cumulativeRaw to compute the new voucher amount.
 *   2. Build a fresh mppx client for this request. The client's
 *      `onChallenge` hook intercepts the merchant's 402 challenge,
 *      reads the merchant-requested delta from it, computes
 *      `newCumulativeRaw = stored + delta`, and creates a
 *      manual-mode voucher credential.
 *   3. mppx retries the request with that credential and returns
 *      the merchant's final response.
 *   4. `onChannelUpdate` fires after the voucher is signed and
 *      bumps the KV watermark to the new cumulative.
 *
 * IMPORTANT: step 4 runs BEFORE we know whether the merchant
 * returned 2xx or 5xx. See §5 of session-support-plan.md — the
 * commit-after-2xx rule is enforced by the proxy layer, not
 * here. This helper will happily bump the cumulative for a
 * failed upstream request; the proxy either (a) only calls
 * this helper after Stellar settle has succeeded and trusts
 * that the next in-flight request will pick up the new watermark,
 * or (b) rolls the watermark forward on success by passing a
 * callback the proxy controls. We go with (a) because rollback
 * in an eventually-consistent KV is harder to get right than
 * "next voucher starts from wherever we landed, good or bad."
 *
 * The caller is responsible for handling ChannelNotInstalledError.
 */
export async function payMerchantSession(
  env: Env,
  merchantId: string,
  merchantUrl: string,
  init: RequestInit = {},
): Promise<{ response: Response; channelBefore: TempoChannelState }> {
  const channel = await getTempoChannel(env, merchantId)
  if (!channel) {
    throw new ChannelNotInstalledError(merchantId)
  }

  const client = createTempoClientInternal(env, {
    // Intercept the merchant's 402 challenge so we can compute the
    // cumulative-after-this-request ourselves. mppx then signs a
    // voucher with that value and retries.
    onChallenge: async (challenge, { createCredential }) => {
      // Session challenge request shape (after the zod transform
      // in tempo.session's request schema): amount is a base-unit
      // string like "10000" for $0.01 at 6 decimals. See
      // node_modules/mppx/dist/tempo/client/Session.d.ts.
      const delta = (challenge as any).request?.amount as string | undefined
      if (!delta || !/^\d+$/.test(delta)) {
        throw new Error(
          `tempo.session challenge for ${merchantId} missing valid base-unit amount: ${delta}`,
        )
      }
      const newCumulativeRaw = addRaw(channel.cumulativeRaw, delta)
      // Manual-mode context: tell mppx "sign a voucher action on
      // channel X at the new cumulative". mppx reads this in
      // Session.js's client handler and produces the credential
      // payload (voucher type, signed by `authorizedSigner` or
      // the root account).
      return createCredential({
        action: 'voucher',
        channelId: channel.channelId,
        cumulativeAmountRaw: newCumulativeRaw,
      } as any)
    },
    onChannelUpdate: async (entry: ChannelEntryLike) => {
      // mppx gives us the just-signed cumulative as a bigint.
      // Persist it to KV so a cold-isolate restart sees the
      // new watermark.
      //
      // We use `bumpCumulative` (monotone) instead of a blind
      // put so the KV side is safe even if two in-flight
      // requests race: the slower write will see an equal or
      // higher value and drop silently rather than rewinding.
      await bumpCumulative(env, merchantId, entry.cumulativeAmount.toString())
    },
  })

  const response = await client.fetch(merchantUrl, init)
  return { response, channelBefore: channel }
}

/**
 * Backwards-compat export — existing callers of `createTempoClient`
 * in scripts/tests should keep working. The new signature keeps
 * the single-arg form that just returns a vanilla client with
 * both methods registered.
 */
export function createTempoClient(env: Env) {
  return createTempoClientInternal(env)
}
