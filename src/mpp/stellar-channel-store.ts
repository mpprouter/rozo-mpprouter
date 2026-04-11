/**
 * Stellar channel metadata store — operator-facing per-channel
 * records that the dispatch path (src/mpp/stellar-channel-dispatch.ts)
 * needs to rebuild a per-request `stellar.channel()` method instance.
 *
 * This store is NOT the cumulative tracker. `@stellar/mpp` itself
 * writes cumulative-voucher state under `stellar:channel:cumulative:*`
 * via the `Store.cloudflare(env.MPP_STORE)` wrapper, and its internal
 * verify loop is the authoritative monotonicity guard. This file
 * holds the SIDECAR metadata the router needs at dispatch time:
 *
 *   - `commitmentKey` — the Ed25519 public key the channel contract
 *     enforces at verify time. mppx needs this as a constructor
 *     parameter. The router cannot recover it from the credential
 *     alone; it has to persist it per channel.
 *   - `agentAccount` — the G... account that funded the channel.
 *     Purely informational for the operator.
 *   - `depositRaw` — the initial channel deposit in Stellar USDC
 *     base units (7 decimals). Operator reference only; the real
 *     balance lives on chain.
 *   - Timestamps.
 *
 * Key layout:
 *   stellarChannel:<channelContract>   → JSON-encoded StellarChannelState
 *
 * No collision with `stellar:channel:*` (mppx's own prefix — note
 * the colon separator), no collision with `tempoChannel:*`
 * (see src/mpp/channel-store.ts), no collision with `idempotency:*`
 * (see src/routes/proxy.ts). Verified against the store key audit
 * in internaldocs/v2-stellar-channel-notes.md §N4.
 */

import type { Env } from '../index'

/**
 * One Stellar payment channel between an agent and the router.
 *
 * `channelContract` is the Soroban contract address (C...) of a
 * pre-deployed channel contract. Agents open channels OUT OF BAND
 * (via scripts/admin/deploy-stellar-channel-for-agent.ts or a
 * similar helper) before sending any MPP credential that references
 * this channel. The router does NOT deploy contracts on demand;
 * if a credential references a channel whose KV record is missing,
 * the dispatch path returns 402 with an operator-facing error.
 */
export type StellarChannelState = {
  /** On-chain Soroban contract address, e.g. `CCW67...`. */
  channelContract: string
  /**
   * Ed25519 public key (G-strkey format) that the channel contract
   * verifies commitment signatures against. Usually the agent's
   * account public key — the agent signs vouchers with the same key
   * pair that owns the funding account.
   */
  commitmentKey: string
  /** Agent's Stellar account (G...). */
  agentAccount: string
  /**
   * Stellar SAC contract address for the token the channel was
   * opened against. V2 initial rollout is USDC-only; the value will
   * match `USDC_SAC['stellar:pubnet']` from src/mpp/stellar-server.ts.
   * Stored here anyway because per-asset channels are a foreseeable
   * V2.1 feature (XLM / other SAC tokens) and hard-coding USDC in
   * the dispatch path would make that migration lossy.
   */
  currency: string
  /** Stellar network id. V2 initial rollout is `'stellar:pubnet'`. */
  network: string
  /**
   * Initial deposit the agent funded the channel with, in Stellar
   * USDC base units (7 decimals) as a decimal string, e.g. `"10000000"`
   * for 1.00 USDC.
   *
   * Informational — the real remaining balance lives on chain and
   * the cumulative voucher watermark lives under mppx's own
   * `stellar:channel:cumulative:*` keys. This field exists so
   * operators can tell at a glance how much a channel was funded
   * for without a Soroban RPC round-trip.
   */
  depositRaw: string
  /** ISO-8601 timestamp of the on-chain open tx. */
  openedAt: string
}

/**
 * Two KV key prefixes, both deliberately camelCased with NO colon
 * between `stellar` and the next word so they cannot be confused
 * with mppx's own `stellar:channel:*` (colon-separated) prefix.
 * See internaldocs/v2-stellar-channel-notes.md §N4 for the
 * full collision audit.
 *
 *   stellarChannel:<channelContract>  → StellarChannelState (primary)
 *   stellarAgent:<G-account>          → <channelContract>   (secondary index)
 *
 * The secondary index exists so the proxy dispatch can look up a
 * channel by the agent's Stellar account (extracted from
 * credential.source = 'did:pkh:stellar:pubnet:G...') without
 * knowing the channel contract address in advance. This is what
 * removes the chicken-and-egg bootstrap problem: the agent never
 * has to tell the router its channel address out of band — the
 * router reads the agent identity directly from the credential
 * wire format.
 *
 * V2 initial rollout assumes a one-to-one agent ↔ channel mapping
 * (one agent has exactly one open channel with the router). A
 * future multi-channel-per-agent story can extend the index to
 * `stellarAgent:<G>:<channel-nickname>` → <contract> but that is
 * out of scope for V2.
 */
const CHANNEL_PREFIX = 'stellarChannel:'
const AGENT_INDEX_PREFIX = 'stellarAgent:'

function channelKey(channelContract: string): string {
  return `${CHANNEL_PREFIX}${channelContract}`
}

function agentIndexKey(agentAccount: string): string {
  return `${AGENT_INDEX_PREFIX}${agentAccount}`
}

/**
 * Read the metadata record for a given channel contract. Returns
 * `null` if the channel has not been registered yet — the dispatch
 * path treats this as "unknown channel, reject with 402" rather
 * than silently creating one.
 */
export async function getStellarChannel(
  env: Env,
  channelContract: string,
): Promise<StellarChannelState | null> {
  const raw = await env.MPP_STORE.get(channelKey(channelContract))
  if (!raw) return null
  try {
    return JSON.parse(raw) as StellarChannelState
  } catch {
    // Corrupt or hand-edited value. Mirror the Tempo store's
    // behavior (src/mpp/channel-store.ts): swallow the error and
    // return null so one bad record doesn't break unrelated
    // stellar.charge or tempo.* traffic on the same Worker.
    return null
  }
}

/**
 * Look up the channel contract address an agent has registered
 * with the router. Reads the `stellarAgent:<G>` secondary index
 * that putStellarChannel maintains.
 *
 * Returns null if the agent has no registered channel. This is
 * the fast path for the proxy dispatch — one KV read to go from
 * "agent G address from credential.source" to "channel contract
 * address to build Mppx with".
 */
export async function getChannelForAgent(
  env: Env,
  agentAccount: string,
): Promise<string | null> {
  const contract = await env.MPP_STORE.get(agentIndexKey(agentAccount))
  return contract ?? null
}

/**
 * Overwrite the full metadata record for a channel AND write the
 * agent-index secondary record. Called by register / deploy
 * scripts during bootstrap.
 *
 * Both writes happen sequentially. On failure the store can be
 * left in a partial state (channel written but index missing, or
 * vice versa). Recovery: rerun the operator script, which is
 * idempotent for the happy case — the second write is an
 * overwrite with the same value.
 *
 * Blind put — does NOT merge with existing state. Callers that
 * want to preserve parts of the existing record must read-modify-
 * write explicitly.
 */
export async function putStellarChannel(
  env: Env,
  channelContract: string,
  state: StellarChannelState,
): Promise<void> {
  await env.MPP_STORE.put(channelKey(channelContract), JSON.stringify(state))
  // Also maintain the reverse agent index so the dispatch path
  // can resolve `credential.source` → channel contract in a
  // single KV read. If the same agent opens a second channel
  // this will overwrite the index — V2 assumes one channel per
  // agent and we rely on the operator not registering two
  // simultaneously. See `getChannelForAgent`.
  await env.MPP_STORE.put(agentIndexKey(state.agentAccount), channelContract)
}

/**
 * List every registered Stellar channel. Used by `inspect-channels.ts`
 * to render the Stellar section of the ledger view. Not called on
 * the hot path.
 *
 * KV's list() is eventually consistent across colos. For an
 * inspection tool running once per day by hand, that is fine.
 */
export async function listStellarChannels(
  env: Env,
): Promise<Array<{ channelContract: string; state: StellarChannelState }>> {
  const out: Array<{ channelContract: string; state: StellarChannelState }> = []
  let cursor: string | undefined
  do {
    const page = await env.MPP_STORE.list({ prefix: CHANNEL_PREFIX, cursor })
    for (const k of page.keys) {
      const channelContract = k.name.slice(CHANNEL_PREFIX.length)
      const state = await getStellarChannel(env, channelContract)
      if (state) out.push({ channelContract, state })
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return out
}
