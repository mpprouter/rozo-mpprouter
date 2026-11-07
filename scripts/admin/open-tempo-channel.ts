#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/open-tempo-channel.ts — Open a Tempo session
 * payment channel for one merchant and persist its state to KV.
 *
 * This spends real money: it broadcasts an on-chain Tempo L2
 * transaction, signed with the router key from the macOS Keychain, that locks
 * `--deposit` of the merchant's quoted token into its escrow contract.
 *
 * Usage:
 *   npx tsx scripts/admin/open-tempo-channel.ts <merchantId> \
 *     --deposit N --expect-currency 0x... --max-deposit N \
 *     --old-channel <0x...|none> --snapshot-dir <path> [--yes]
 *
 * Without --yes it stops after the checks and spends nothing. It stops, before
 * spending, when the live 402 is not what was approved, when the wallet is not
 * the router's live address, when the route is still payable, or when the KV
 * slots are not as expected. After opening, a channel that fails any check is
 * NOT written to KV.
 *
 * Design note:
 * This script uses mppx's AUTO-MODE session helper (pass `deposit`
 * to `tempo.session(...)`) rather than the manual-mode primitive.
 * Auto mode does the full orchestration in one fetch call: probe
 * merchant → build open tx → broadcast → wait for settlement →
 * fire onChannelUpdate with the final ChannelEntry. We grab the
 * entry in the callback and persist it to KV.
 *
 * The router Worker's hot path still runs in manual mode (V1
 * `payMerchantSession` in src/mpp/tempo-client.ts) — this script
 * ONLY opens the channel. Once the KV entry exists, the Worker
 * reads it on every request without re-touching the chain.
 *
 * See internaldocs/v2-full-session-design.md §B for the broader
 * flow and the rationale for splitting "open" (auto) from
 * "voucher" (manual).
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { tempo } from 'mppx/client'
import { Session } from 'mppx/tempo'
import { createClient, http } from 'viem'
import { tempo as tempoChain } from 'viem/chains'

import {
  assertChallengeMatchesApproval,
  assertOpenedChannel,
  assertWithinDepositCeiling,
  guardedChallengeFetch,
  assertSlotsReady,
  installChannel,
  parseSessionChallenge,
  sameAddress,
  type SlotRecord,
  type SlotStore,
} from './lib/tempo-channel-migration'
import { loadTempoRouterAccount } from './lib/tempo-router-key'

// ----------------------------------------------------------------------------
// Paths
// ----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

// ----------------------------------------------------------------------------
// Merchant catalog (hand-resolved from mpp.dev/api/services on 2026-04-11)
//
// V2 hand-codes these because V3 will auto-sync from mpp.dev; see
// internaldocs/v2-full-session-design.md §B and §R2. Keep the id
// matching src/services/merchants.ts route ids so `inspect-channels.ts`
// can cross-reference.
// ----------------------------------------------------------------------------

type SessionMerchant = {
  id: string
  name: string
  /**
   * The Tempo MPP gateway URL exposed by mpp.dev. Probing this
   * unauthenticated returns a 402 session challenge; mppx auto
   * mode then handles the open.
   */
  serviceUrl: string
  /**
   * A payment-required endpoint on the merchant. Any endpoint
   * whose `payment.intent === 'session'` works for opening a
   * channel — the escrow contract is the same across all of a
   * merchant's session endpoints.
   */
  probePath: string
  probeMethod: 'GET' | 'POST' | 'PUT'
  /**
   * A minimal body that satisfies the endpoint's input contract
   * enough to trigger a 402. For chat endpoints this is a tiny
   * prompt; for infra endpoints it's an empty object. The
   * merchant returns 402 BEFORE running the actual work, so the
   * body content doesn't cost anything; it just needs to parse.
   */
  probeBody: unknown
}

const MERCHANTS: Record<string, SessionMerchant> = {
  openrouter_chat: {
    id: 'openrouter_chat',
    name: 'OpenRouter',
    serviceUrl: 'https://openrouter.mpp.tempo.xyz',
    probePath: '/v1/chat/completions',
    probeMethod: 'POST',
    probeBody: {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'open channel probe' }],
    },
  },
  anthropic_messages: {
    id: 'anthropic_messages',
    name: 'Anthropic',
    serviceUrl: 'https://anthropic.mpp.tempo.xyz',
    probePath: '/v1/messages',
    probeMethod: 'POST',
    probeBody: {
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'probe' }],
    },
  },
  openai_chat: {
    id: 'openai_chat',
    name: 'OpenAI',
    serviceUrl: 'https://openai.mpp.tempo.xyz',
    probePath: '/v1/chat/completions',
    probeMethod: 'POST',
    probeBody: {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'open channel probe' }],
    },
  },
  gemini_generate: {
    id: 'gemini_generate',
    name: 'Google Gemini',
    serviceUrl: 'https://gemini.mpp.tempo.xyz',
    probePath: '/v1beta/models/gemini-1.5-flash:generateContent',
    probeMethod: 'POST',
    probeBody: {
      contents: [{ parts: [{ text: 'probe' }] }],
    },
  },
  dune_execute: {
    id: 'dune_execute',
    name: 'Dune',
    // 2026-04-11: mpp.dev/api/services lists Dune at the actual
    // api.dune.com host, NOT at dune.mpp.tempo.xyz. The earlier
    // v2-todo.md draft was wrong; verified by curling
    // https://mpp.dev/api/services and inspecting `dune.serviceUrl`.
    serviceUrl: 'https://api.dune.com',
    probePath: '/api/v1/sql/execute',
    probeMethod: 'POST',
    probeBody: { query: 'SELECT 1' },
  },
  modal_exec: {
    id: 'modal_exec',
    name: 'Modal',
    serviceUrl: 'https://modal.mpp.tempo.xyz',
    // 2026-04-11: /sandbox/exec returned a `tempo.charge` 402 — that
    // endpoint is per-call charge, not session. The session-bearing
    // endpoint per mpp.dev catalog is /sandbox/create (which opens
    // a long-lived sandbox + bills via session voucher). Probe via
    // /sandbox/create instead so the session 402 fires.
    probePath: '/sandbox/create',
    probeMethod: 'POST',
    probeBody: {},
  },
  alchemy_rpc: {
    id: 'alchemy_rpc',
    name: 'Alchemy',
    // 2026-04-11: mpp.dev/api/services lists Alchemy at mpp.alchemy.com,
    // NOT at alchemy.mpp.tempo.xyz. Path is /:network/v2 — eth-mainnet
    // is the network we use for the probe.
    serviceUrl: 'https://mpp.alchemy.com',
    probePath: '/eth-mainnet/v2',
    probeMethod: 'POST',
    probeBody: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
  },
  tempo_rpc: {
    id: 'tempo_rpc',
    name: 'Tempo RPC',
    serviceUrl: 'https://rpc.mpp.tempo.xyz',
    probePath: '/',
    probeMethod: 'POST',
    probeBody: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
  },
  storage_upload: {
    id: 'storage_upload',
    name: 'Object Storage',
    serviceUrl: 'https://storage.mpp.tempo.xyz',
    // 2026-04-11: mpp.dev catalog shows storage uses PUT /:key for
    // upload, GET /:key for download, DELETE /:key for delete.
    // No POST endpoint exists. Probe with a tiny PUT — the
    // merchant emits a session 402 BEFORE actually running the
    // upload, so the body content doesn't matter.
    probePath: '/probe-mpprouter-open',
    probeMethod: 'PUT',
    probeBody: { probe: true },
  },
}

// ----------------------------------------------------------------------------
// Argument parsing
// ----------------------------------------------------------------------------

type Args = {
  merchantId: string
  deposit: string
  maxDeposit: string
  expectCurrency: string
  oldChannelId: string | null
  snapshotDir: string
  yes: boolean
}

const USAGE =
  'Usage: npx tsx scripts/admin/open-tempo-channel.ts <merchantId> --deposit N --max-deposit N ' +
  '--expect-currency 0x... --old-channel <0x...|none> --snapshot-dir <path> [--yes]'

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2)
  const flag = (name: string) => {
    const i = args.indexOf(name)
    return i === -1 ? undefined : args[i + 1]
  }
  const merchantId = args[0]
  const deposit = flag('--deposit')
  const maxDeposit = flag('--max-deposit')
  const expectCurrency = flag('--expect-currency')
  const oldChannel = flag('--old-channel')
  const snapshotDir = flag('--snapshot-dir')
  if (!merchantId || merchantId.startsWith('-') || !deposit || !maxDeposit || !expectCurrency || !oldChannel || !snapshotDir) {
    console.error(USAGE)
    console.error(`\nKnown merchant ids:\n${Object.keys(MERCHANTS).map((id) => `  ${id}`).join('\n')}`)
    process.exit(1)
  }
  for (const value of [deposit, maxDeposit]) {
    if (!/^\d+(\.\d{1,6})?$/.test(value)) {
      console.error(`Invalid amount: ${value}. Expected a decimal like "1" or "0.5".`)
      process.exit(1)
    }
  }
  return {
    merchantId,
    deposit,
    maxDeposit,
    expectCurrency,
    oldChannelId: oldChannel === 'none' ? null : oldChannel,
    snapshotDir,
    yes: args.includes('--yes'),
  }
}

// ----------------------------------------------------------------------------
// KV access (shells out to wrangler, no shell, always the remote namespace)
// ----------------------------------------------------------------------------

function kvGet(key: string): string | null {
  try {
    const value = execFileSync('npx', ['wrangler', 'kv', 'key', 'get', '--binding', 'MPP_STORE', key, '--remote', '--text'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // wrangler appends a newline to stdout; it is not part of the stored value.
    return value.endsWith('\n') ? value.slice(0, -1) : value
  } catch (err) {
    // wrangler exits non-zero for both "no such key" and a real failure.
    const stderr = String((err as { stderr?: unknown }).stderr ?? '')
    if (/\b404\b|not found/i.test(stderr)) return null
    throw new Error(`KV read failed for ${key}: ${stderr.slice(0, 200)}`)
  }
}

function kvPut(key: string, value: string): void {
  // Values with quotes and newlines break positional args, so use a temp file.
  const tmpFile = resolve(tmpdir(), `mpp-kv-${Date.now()}.json`)
  writeFileSync(tmpFile, value, { mode: 0o600 })
  try {
    execFileSync('npx', ['wrangler', 'kv', 'key', 'put', '--binding', 'MPP_STORE', key, '--path', tmpFile, '--remote'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
  } finally {
    try {
      unlinkSync(tmpFile)
    } catch {
      // tmp cleanup best-effort
    }
  }
}

const kvStore: SlotStore = {
  get: kvGet,
  put: kvPut,
  wait: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000),
}

/** The routes this channel serves must be closed before a slot changes. */
async function assertRoutesClosed(channelKey: string): Promise<void> {
  const body = (await (await fetch('https://apiserver.mpprouter.dev/services')).json()) as {
    services?: Array<{ id: string; payment_enabled: boolean }>
  }
  const services = body.services ?? (body as unknown as Array<{ id: string; payment_enabled: boolean }>)
  const served = channelKey === 'anthropic_messages'
    ? ['anthropic_messages', 'anthropic_chat_completions']
    : [channelKey]
  for (const id of served) {
    const entry = services.find((s) => s.id === id)
    if (!entry) throw new Error(`/services has no entry for ${id}`)
    if (entry.payment_enabled) throw new Error(`${id} is still payable; delist it before moving its channel`)
  }
}

// ----------------------------------------------------------------------------
// Channel state we persist (mirror of src/mpp/channel-store.ts
// TempoChannelState — must stay in sync)
// ----------------------------------------------------------------------------

type PersistedChannelState = {
  channelId: string
  escrowContract: string
  payee: string
  currency: string
  chainId: number
  authorizedSigner: string
  cumulativeRaw: string
  depositRaw: string
  openedAt: string
  lastVoucherAt?: string
  /**
   * TIP-1034 channel descriptor — persisted from the `sessionStore.set()`
   * callback's `channel.descriptor` so the Worker can produce manual-mode
   * vouchers without re-querying the chain. Required by mppx 0.7.0+
   * when the merchant advertises `sessionProtocol: 'v2'`.
   */
  descriptor?: {
    authorizedSigner: string
    expiringNonceHash: string
    operator: string
    payee: string
    payer: string
    salt: string
    token: string
  }
}

// ----------------------------------------------------------------------------
// Decimal → base-unit conversion (Tempo USDC is 6 decimals)
// ----------------------------------------------------------------------------

function toBaseUnits(decimal: string, decimals: number): bigint {
  const [whole, frac = ''] = decimal.split('.')
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(whole + padded)
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const { merchantId, deposit, maxDeposit, expectCurrency, oldChannelId, snapshotDir, yes } = parseArgs(process.argv)
  const merchant = MERCHANTS[merchantId]
  if (!merchant) {
    console.error(`Unknown merchant id: ${merchantId}`)
    console.error(`Known: ${Object.keys(MERCHANTS).join(', ')}`)
    process.exit(1)
  }

  const account = loadTempoRouterAccount()
  const rpcUrl = process.env.TEMPO_RPC_URL ?? 'https://rpc.tempo.xyz'
  const depositRaw = toBaseUnits(deposit, 6)
  const maxDepositCeilingRaw = toBaseUnits(maxDeposit, 6)

  // Every check below runs before a transaction exists.
  const health = (await (await fetch('https://apiserver.mpprouter.dev/health')).json()) as {
    tempo?: { router_pool?: string }
  }
  if (!sameAddress(health.tempo?.router_pool, account.address)) {
    throw new Error('Keychain key does not derive the address /health reports; refusing')
  }
  const unpaid = await fetch(`${merchant.serviceUrl}${merchant.probePath}`, {
    method: merchant.probeMethod,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(merchant.probeBody),
  })
  if (unpaid.status !== 402) throw new Error(`merchant answered ${unpaid.status}, expected an unpaid 402`)
  const challenge = parseSessionChallenge(unpaid.headers.get('www-authenticate'))
  assertChallengeMatchesApproval(challenge, {
    currency: expectCurrency,
    depositRaw,
    maxDepositRaw: maxDepositCeilingRaw,
  })
  await assertRoutesClosed(merchant.id)
  const slotExpectation = {
    merchantId: merchant.id,
    oldChannelId,
    walletAddress: account.address,
    snapshot: (slots: { primary: string | null; alt: string | null }) => {
      mkdirSync(snapshotDir, { recursive: true, mode: 0o700 })
      const file = resolve(snapshotDir, `${merchant.id}-${Date.now()}.json`)
      writeFileSync(file, JSON.stringify(slots, null, 2), { mode: 0o600 })
      console.log(`  Slot snapshot:    ${file}`)
    },
  }
  assertSlotsReady(kvStore, slotExpectation)

  console.log(`Opening Tempo session channel for ${merchant.name} (${merchant.id})`)
  console.log(`  Router wallet:    ${account.address}`)
  console.log(`  Merchant service: ${merchant.serviceUrl}`)
  console.log(`  Probe endpoint:   ${merchant.probeMethod} ${merchant.probePath}`)
  console.log(`  Tempo RPC:        ${rpcUrl}`)
  console.log(`  Currency:         ${challenge.currency}`)
  console.log(`  Payee:            ${challenge.recipient}`)
  console.log(`  Escrow:           ${challenge.escrowContract}`)
  console.log(`  Chain:            ${challenge.chainId}`)
  console.log(`  Quote:            ${challenge.amount} base units`)
  console.log(`  Deposit:          ${deposit} (${depositRaw} base units), ceiling ${maxDeposit}`)
  console.log('')
  if (!yes) {
    console.log('Checks passed. Dry run: re-run with --yes to open the channel.')
    return
  }

  // viem Tempo client — the session manager needs a real viem
  // client to sign the on-chain open tx. We use the `tempo` chain
  // definition from viem/chains which already includes the Tempo
  // multi-call support via `prepareTransactionRequest({ calls: [...] })`
  // that createOpenPayload depends on.
  const client = createClient({
    chain: tempoChain,
    transport: http(rpcUrl),
    account,
  })

  // In mppx 0.7.0, `tempo.session` is the TIP-1034 session METHOD
  // (a Method.Client factory for use with Mppx.create), NOT a
  // SessionManager. The auto-mode orchestrator (which has `.fetch()`,
  // `.channelId`, `.cumulative`, `.opened`) is accessed via
  // `tempo.session.manager(...)`.
  //
  // mppx 0.7.0 dropped the `onChannelUpdate` parameter from
  // `tempo.session.manager()`. The correct hook is `sessionStore`:
  // the manager calls `sessionStore.set(channel)` whenever the
  // channel is opened or updated, passing a `StoredSessionChannel`
  // that includes the full TIP-1034 `descriptor`. We capture the
  // stored channel there so the KV write below can include it.
  //
  // `maxDeposit` is the manager's hard cap for the initial open and any later
  // topUp(). The approved ceiling is the cap, so an unexpected suggested deposit
  // cannot spend more than the operator signed off on.
  const maxDepositUsdc = maxDeposit

  let capturedStored: {
    descriptor: PersistedChannelState['descriptor']
    cumulativeAmount: string
    deposit: string
    escrow: string
  } | undefined

  const sm = tempo.session.manager({
    account,
    client,
    decimals: 6,
    // bootstrap:false → do NOT resume an existing channel from the merchant's
    // server-side session snapshot. The old test channels have their on-chain
    // deposit exhausted (cumulative at deposit cap), so resuming them leaves no
    // voucher headroom. Forcing a FRESH channel opens a new on-chain deposit we
    // fully control, sidestepping the exhausted legacy channels.
    bootstrap: false,
    maxDeposit: maxDepositUsdc,
    fetch: guardedChallengeFetch(challenge),
    sessionStore: {
      get() {
        // Fresh open — no prior channel to resume from.
        return null
      },
      set(channel) {
        // Called by the manager when the channel is opened (and on
        // subsequent voucher updates). `channel.descriptor` is the
        // full TIP-1034 ChannelDescriptor required by the Worker to
        // produce manual-mode vouchers (see src/mpp/tempo-client.ts).
        capturedStored = {
          descriptor: channel.descriptor as PersistedChannelState['descriptor'],
          cumulativeAmount: channel.cumulativeAmount,
          deposit: channel.deposit,
          escrow: channel.escrow,
        }
        console.log('  ✅ descriptor captured via sessionStore.set()')
      },
    },
  })

  // Probe the merchant. sm.fetch() handles the 402 → auto-open →
  // retry dance internally. On success the merchant returns a
  // final response (200 or, for a probe body that the merchant's
  // business logic rejects, 400/422 — both are fine, the channel
  // got opened as a side effect during the 402 retry).
  console.log(`→ Probing ${merchant.serviceUrl}${merchant.probePath} ...`)
  let probeResult: Awaited<ReturnType<typeof sm.fetch>>
  try {
    probeResult = await sm.fetch(`${merchant.serviceUrl}${merchant.probePath}`, {
      method: merchant.probeMethod,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(merchant.probeBody),
    })
  } catch (err: any) {
    console.error(`\n❌ Probe failed: ${err.message}`)
    console.error(err.stack)
    process.exit(1)
  }
  console.log(`← Probe response: HTTP ${probeResult.status}`)

  if (!sm.opened || !sm.channelId) {
    console.error('\n❌ Channel was not opened — sm.opened is false after probe.')
    console.error('   Possible causes:')
    console.error('     - Merchant returned non-402 (no challenge to respond to)')
    console.error('     - Merchant 402 didn\'t carry a session challenge')
    console.error('     - Open tx signing or broadcast failed inside mppx')
    console.error(`   Probe HTTP status was: ${probeResult.status}`)
    const body = await probeResult.text().catch(() => '(no body)')
    console.error(`   Probe body (first 500 chars): ${body.slice(0, 500)}`)
    process.exit(1)
  }

  console.log(`  ✅ Channel opened`)
  console.log(`     channelId:      ${sm.channelId}`)
  console.log(`     cumulative:     ${sm.cumulative}`)

  // When RESUMING an existing on-chain channel, the prior cumulative may
  // already be at/near the on-chain deposit, leaving no headroom for new
  // vouchers (merchant rejects with "amount exceeds deposit"). Top up the
  // on-chain deposit so that deposit >= cumulative + the requested headroom.
  // `--deposit N` is treated as the desired FREE headroom above the current
  // cumulative. topUp() broadcasts a real on-chain Tempo L2 deposit tx.
  const desiredHeadroomRaw = depositRaw
  const requiredDepositRaw = BigInt(sm.cumulative) + desiredHeadroomRaw
  const currentDepositRaw = BigInt(capturedStored?.deposit ?? '0')
  assertWithinDepositCeiling(requiredDepositRaw, maxDepositCeilingRaw)
  if (currentDepositRaw < requiredDepositRaw) {
    const topUpRaw = requiredDepositRaw - currentDepositRaw
    console.log(
      `  ↑ Topping up on-chain deposit by ${topUpRaw} base units ` +
        `(current deposit ${currentDepositRaw} < required ${requiredDepositRaw}) ...`,
    )
    try {
      await sm.topUp(topUpRaw)
      console.log(`  ✅ Top-up broadcast`)
    } catch (err: any) {
      // 2026-10-25: this used to log and carry on, then write the INTENDED
      // deposit to KV. anthropic_messages and openai_chat sat for months with
      // KV saying 1.001 / 2.001 USDC while the chain held 0.001, and failed
      // with "amount-exceeds-deposit" as soon as the merchant went
      // session-only. Fall through to the on-chain read-back below, which
      // records the real deposit and exits non-zero.
      console.error(`  ❌ topUp failed: ${err.message}`)
    }
  }

  // Read the deposit back from chain. KV must record what the escrow holds,
  // never what we asked for.
  const onChain = await Session.Precompile.Chain.getChannelState(client as any, sm.channelId as `0x${string}`)
  const onChainDepositRaw = BigInt(onChain.deposit)
  console.log(`  On-chain deposit:  ${onChainDepositRaw} base units (settled ${onChain.settled})`)

  // Stop here rather than warn: the Worker signs from these fields, and a bad
  // record makes it sign vouchers the merchant rejects. The channel stays open
  // on chain and is recoverable with requestClose, so report its id.
  const escrow = capturedStored?.escrow ?? ''
  const descriptor = capturedStored?.descriptor
  assertOpenedChannel(
    {
      channelId: sm.channelId as string,
      escrow,
      descriptor,
      derivedChannelId: descriptor
        ? Session.Precompile.Channel.computeId({
            ...(descriptor as any),
            chainId: challenge.chainId,
            escrow: escrow as `0x${string}`,
          })
        : '',
      onChain: {
        deposit: onChainDepositRaw,
        settled: BigInt(onChain.settled),
        closeRequestedAt: BigInt(onChain.closeRequestedAt),
      },
    },
    challenge,
    account.address,
    requiredDepositRaw,
  )

  const state: PersistedChannelState = {
    channelId: sm.channelId as string,
    escrowContract: escrow,
    payee: challenge.recipient,
    currency: challenge.currency,
    chainId: challenge.chainId,
    authorizedSigner: account.address,
    // Cumulative the manager reported via sessionStore.set(): the amount the
    // open's own probe already authorized on this channel.
    cumulativeRaw: capturedStored?.cumulativeAmount ?? sm.cumulative.toString(),
    // Deposit is read back from the escrow precompile, never the requested figure.
    depositRaw: onChainDepositRaw.toString(),
    openedAt: new Date().toISOString(),
    descriptor,
  }

  console.log(`\n→ Installing in KV: tempoChannel:${merchant.id}`)
  console.log(JSON.stringify(state, null, 2))
  installChannel(kvStore, slotExpectation, state as unknown as SlotRecord)
  console.log(`✅ KV write complete and read back.\n`)

  console.log('Next step: run `npx tsx scripts/admin/inspect-channels.ts` to verify the new channel is visible.')
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
