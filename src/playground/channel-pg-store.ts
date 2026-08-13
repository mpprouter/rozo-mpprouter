/**
 * ISOLATED playground channel registry.
 *
 * P0-A fix: the playground MUST NOT share the production `stellarChannel:*` /
 * `stellarAgent:*` registry that the paid proxy trusts. A channel registered
 * by the production path (or by pre-provenance playground code) would otherwise
 * bypass the WASM-hash / collector checks. So every playground channel lives in
 * its OWN KV namespace here, and the playground dispatch + settlement paths
 * resolve ONLY from it and re-assert the provenance that register stored.
 *
 *   pgChannel:<C>  → PgChannelState (primary, listable for the settlement cron)
 *   pgAgent:<G>    → <C>            (secondary index for voucher dispatch)
 *
 * These prefixes collide with NOTHING: not the production `stellarChannel:*` /
 * `stellarAgent:*`, not mppx's `stellar:channel:*`, not `tempoChannel:*`.
 */

import type { Env } from '../index'
import { channelCollector, channelWasmHash } from './channel-config'

/**
 * Provenance schema version stamped at register time. Bump whenever the on-chain
 * verification logic changes so that records written by older code are treated
 * as un-provenanced and rejected (never silently trusted on replay/dispatch).
 */
export const PG_PROVENANCE_VERSION = 1

export interface PgChannelState {
  channelContract: string
  /** Commitment ed25519 public key (G-strkey) the channel enforces. */
  commitmentKey: string
  /** Funder account (G...). */
  agentAccount: string
  /** USDC SAC. */
  currency: string
  network: string
  /** On-chain USDC balance at register time (7-decimal atomic string). */
  depositRaw: string
  /** The collector the channel pays TO — re-asserted against config on use. */
  to: string
  /** On-chain WASM hash verified at register — re-asserted against config on use. */
  wasmHash: string
  /** Provenance schema version — must equal PG_PROVENANCE_VERSION to be trusted. */
  provenanceVersion: number
  openedAt: string
}

const CHANNEL_PREFIX = 'pgChannel:'
const AGENT_PREFIX = 'pgAgent:'

const channelKey = (c: string) => `${CHANNEL_PREFIX}${c}`
const agentKey = (g: string) => `${AGENT_PREFIX}${g}`

export async function getPgChannel(env: Env, channelContract: string): Promise<PgChannelState | null> {
  const raw = await env.MPP_STORE.get(channelKey(channelContract))
  if (!raw) return null
  try {
    return JSON.parse(raw) as PgChannelState
  } catch {
    return null
  }
}

export async function getPgChannelForAgent(env: Env, agentAccount: string): Promise<string | null> {
  return (await env.MPP_STORE.get(agentKey(agentAccount))) ?? null
}

export async function putPgChannel(env: Env, state: PgChannelState): Promise<void> {
  await env.MPP_STORE.put(channelKey(state.channelContract), JSON.stringify(state))
  await env.MPP_STORE.put(agentKey(state.agentAccount), state.channelContract)
}

export async function listPgChannels(env: Env): Promise<PgChannelState[]> {
  const out: PgChannelState[] = []
  let cursor: string | undefined
  do {
    const page = await env.MPP_STORE.list({ prefix: CHANNEL_PREFIX, cursor })
    for (const k of page.keys) {
      const c = k.name.slice(CHANNEL_PREFIX.length)
      const s = await getPgChannel(env, c)
      if (s) out.push(s)
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return out
}

/**
 * Re-assert, at USE time (dispatch + settlement), the provenance a record
 * claims it passed at register time — against the CURRENT config. This is what
 * makes a stored record that predates provenance verification (wrong version),
 * or a config drift (collector/WASM rotated), fail closed rather than be
 * trusted. It never re-reads the chain; that heavy check happens once at
 * register. The version bump is the lever that invalidates old records.
 */
export function pgChannelProvenanceOk(state: PgChannelState, env: Env): boolean {
  if (state.provenanceVersion !== PG_PROVENANCE_VERSION) return false
  const collector = channelCollector(env)
  const wasmHash = channelWasmHash(env)
  if (!collector || !wasmHash) return false
  if (state.to !== collector) return false
  if (state.wasmHash.toLowerCase() !== wasmHash.toLowerCase()) return false
  return true
}
