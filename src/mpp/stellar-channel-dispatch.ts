/**
 * Stellar channel verify dispatcher — per-request Mppx factory.
 *
 * V1 used a single shared Mppx instance for `stellar.charge`: one
 * constructor call at Worker cold start, serving every request.
 * That pattern DOES NOT WORK for `stellar.channel` because the
 * `stellar.channel()` constructor binds one specific channel
 * contract address and one commitment public key at creation time.
 * A router that serves many agent channels MUST instantiate a
 * fresh Mppx per request from the credential's channel address.
 *
 * See internaldocs/v2-stellar-channel-notes.md §N2 for the reason
 * this is fundamental to @stellar/mpp's design, not a workaround.
 *
 * Flow per incoming request with a `stellar.channel` credential:
 *   1. Deserialize the Authorization header into a Credential
 *      object. Extract `credential.challenge.request.channel` —
 *      the Soroban contract address the agent is referencing.
 *   2. Look up `stellarChannel:<channelContract>` in MPP_STORE
 *      via src/mpp/stellar-channel-store.ts to get the router's
 *      sidecar metadata, including the commitmentKey that the
 *      on-chain contract enforces.
 *   3. Build a fresh Mppx instance configured with exactly that
 *      channel + commitment key. mppx's cumulative tracking and
 *      replay protection live under `stellar:channel:*` (a
 *      different KV key prefix from our own `stellarChannel:*`),
 *      so persistent channel state carries across requests while
 *      our per-request Mppx is ephemeral.
 *   4. Call the resulting `mppx['stellar/channel'](...)` to
 *      verify the credential against the amount + channel the
 *      merchant is asking for. mppx returns either a 402
 *      challenge (reject) or a verified result with a
 *      `withReceipt` helper.
 *
 * The result object shape mirrors what `createStellarPayment`
 * (the charge-mode sibling in src/mpp/stellar-server.ts) returns
 * via its `stellar/charge` entry. This means `proxy.ts` can
 * dispatch on `authKind` at a single site and the two verify
 * branches produce compatible result objects for the downstream
 * merchant-pay phase to consume.
 */

import { stellar } from '@stellar/mpp/channel/server'
import { Mppx, Store } from 'mppx/server'
import { Credential } from 'mppx'
import { getChannelForAgent, getStellarChannel } from './stellar-channel-store'
import type { Env } from '../index'

/**
 * Error thrown when a `stellar.channel` credential's source
 * (agent G... address) has no `stellarAgent:<G>` index entry in
 * KV. This is the Stellar-side analog of `ChannelNotInstalledError`
 * from src/mpp/tempo-client.ts — an unknown agent should surface
 * loudly as a 402, not a 500.
 *
 * The router cannot transparently create a channel for a new
 * agent because the on-chain Soroban channel contract has to be
 * deployed out-of-band first (agent pays the deploy gas), then
 * an operator runs scripts/admin/register-stellar-channel.ts to
 * install the metadata into KV.
 */
export class StellarChannelNotRegisteredError extends Error {
  constructor(public readonly agentAccount: string) {
    super(
      `No stellarAgent:<G> index entry in KV for ${agentAccount}. ` +
        `Deploy the channel contract on Stellar and run ` +
        `scripts/admin/register-stellar-channel.ts to register it.`,
    )
    this.name = 'StellarChannelNotRegisteredError'
  }
}

/**
 * Parse the agent's Stellar account (G... public key) from a
 * `Payment` Authorization header. Returns null when the header
 * is absent, unparseable, or carries a non-`stellar.channel`
 * credential.
 *
 * The agent identity lives in `credential.source` as a did:pkh
 * URI of the form `did:pkh:stellar:<network>:G...`, produced by
 * the charge and channel clients in @stellar/mpp when they
 * serialize a credential. We extract the final segment (the G
 * address) and use it as the KV lookup key for the
 * stellarAgent secondary index.
 *
 * Why this is the right layer: the agent's Stellar account is a
 * cryptographic identity carried in the credential wire format.
 * The router does not need an out-of-band channel to learn who
 * the request is from — every voucher already identifies its
 * signer. This lets the router resolve the correct channel
 * contract by KV lookup alone, with zero changes to the
 * `stellar-mpp-sdk` client-side code.
 */
export function extractAgentAccount(authHeader: string | null): string | null {
  if (!authHeader) return null
  const trimmed = authHeader.trim()
  if (!/^Payment\s+/i.test(trimmed)) return null
  try {
    const credential = Credential.deserialize(trimmed) as {
      challenge?: {
        method?: string
        intent?: string
      }
      source?: string
    }
    const method = credential.challenge?.method?.toLowerCase()
    const intent = credential.challenge?.intent?.toLowerCase()
    if (method !== 'stellar' || intent !== 'channel') return null
    const source = credential.source
    if (typeof source !== 'string' || source.length === 0) return null
    // Expected format: did:pkh:stellar:<network>:G...
    // Accept any network id; the KV index is keyed only by G address.
    const match = source.match(/^did:pkh:stellar:[^:]+:(G[A-Z2-7]{55})$/)
    if (!match) return null
    return match[1]
  } catch {
    return null
  }
}

/**
 * Build a per-request Mppx instance for a specific Stellar
 * channel. The returned Mppx has exactly one method registered:
 * `stellar.channel` bound to this channel contract + its
 * commitment key.
 *
 * The caller is responsible for not reusing this Mppx across
 * requests — doing so would at minimum leak per-channel state
 * between unrelated agents and at worst corrupt cumulative
 * tracking. Throw it away after one verify call.
 */
export function createStellarChannelPayment(
  env: Env,
  channelContract: string,
  commitmentKey: string,
) {
  // Shared store — mppx uses its own `stellar:channel:cumulative:*`
  // and `stellar:channel:challenge:*` key prefixes under this
  // store, which DO NOT collide with our `stellarChannel:*`
  // sidecar metadata or the existing `tempoChannel:*` /
  // `idempotency:*` keys. See internaldocs/v2-stellar-channel-notes.md §N4.
  const store = Store.cloudflare(env.MPP_STORE)

  const method = stellar.channel({
    channel: channelContract,
    commitmentKey,
    store,
    network: env.STELLAR_NETWORK as any,
    rpcUrl: env.STELLAR_RPC_URL,
    // V2 rollout decision (2026-04-11): no feePayer. Agent pays
    // its own XLM for Soroban resource fees because fee-bump
    // cannot cover them (see notes.md §N1). Router does not
    // sponsor network fees either — the savings per voucher are
    // ~0.00001 XLM which is not worth the code complexity.
  })

  // Same wrapper pattern as createStellarPayment — we get back an
  // Mppx whose `.stellar/channel` is the verify entry point.
  // `realm` and `secretKey` have to match the values used by the
  // charge-mode Mppx so that HMAC-bound challenges issued by one
  // side can still be recognized by the other (in case we ever
  // want to cross-verify, and for consistency).
  return Mppx.create({
    methods: [method],
    realm: 'apiserver.mpprouter.dev',
    secretKey: env.MPP_SECRET_KEY,
  })
}

/**
 * Resolve the Stellar channel for an incoming request by walking
 * the two-step KV lookup:
 *
 *   1. Parse the agent's G address out of `credential.source`.
 *   2. Read `stellarAgent:<G>` → channel contract address.
 *   3. Read `stellarChannel:<C>` → full state (commitmentKey etc).
 *   4. Build a per-request Mppx with that channel + commitment key.
 *
 * Step 1 is completely out-of-band-free: the agent's identity is
 * a cryptographic property of the credential, so the router
 * learns it without any header / query param / client-side
 * protocol extension. See `extractAgentAccount` for the parser.
 *
 * Throws `StellarChannelNotRegisteredError` if either KV lookup
 * misses. This bubbles up to proxy.ts which returns 402 with an
 * operator-facing hint.
 */
export async function resolveStellarChannelMppx(
  env: Env,
  authHeader: string | null,
): Promise<{
  mppx: ReturnType<typeof createStellarChannelPayment>
  channelContract: string
  agentAccount: string
}> {
  const agentAccount = extractAgentAccount(authHeader)
  if (!agentAccount) {
    // Defense in depth: if classifyAuth let us through without
    // extracting an agent, fail closed rather than leaking into
    // a default channel.
    throw new Error('No stellar.channel credential with parseable source in Authorization header')
  }
  const channelContract = await getChannelForAgent(env, agentAccount)
  if (!channelContract) {
    throw new StellarChannelNotRegisteredError(agentAccount)
  }
  const state = await getStellarChannel(env, channelContract)
  if (!state) {
    // Agent-index is stale: the secondary record still points to
    // a channel that the operator has since removed. Treat it
    // the same as "agent not registered" from the caller's
    // point of view — the operator needs to re-register.
    throw new StellarChannelNotRegisteredError(agentAccount)
  }
  const mppx = createStellarChannelPayment(
    env,
    channelContract,
    state.commitmentKey,
  )
  return {
    mppx,
    channelContract,
    agentAccount: state.agentAccount,
  }
}
