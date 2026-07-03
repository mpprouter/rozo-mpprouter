#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/open-tempo-channel.ts — Open a Tempo session
 * payment channel for one merchant and persist its state to KV.
 *
 * This spends real money: it broadcasts an on-chain Tempo L2
 * transaction funded by TEMPO_ROUTER_PRIVATE_KEY that locks
 * `--deposit` USDC into the merchant's escrow contract.
 *
 * Usage:
 *   npx tsx scripts/admin/open-tempo-channel.ts <merchantId> [--deposit N]
 *
 * Examples:
 *   # Open a $1 channel for openrouter
 *   npx tsx scripts/admin/open-tempo-channel.ts openrouter --deposit 1
 *
 *   # Default deposit is $1 USDC
 *   npx tsx scripts/admin/open-tempo-channel.ts anthropic
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

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { tempo } from 'mppx/client'
import { createClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoChain } from 'viem/chains'

// ----------------------------------------------------------------------------
// Paths + dev vars (same pattern as inspect-channels.ts)
// ----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

function loadDevVars(): Record<string, string> {
  const path = resolve(REPO_ROOT, '.dev.vars')
  const raw = readFileSync(path, 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

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
      model: 'claude-3-5-sonnet-latest',
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

type Args = { merchantId: string; depositUsdc: string }

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2)
  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/admin/open-tempo-channel.ts <merchantId> [--deposit N]')
    console.error(`\nKnown merchant ids:\n${Object.keys(MERCHANTS).map((id) => `  ${id}`).join('\n')}`)
    process.exit(1)
  }
  const merchantId = args[0]
  let depositUsdc = '1'
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--deposit' && i + 1 < args.length) {
      depositUsdc = args[i + 1]
      i++
    }
  }
  if (!/^\d+(\.\d+)?$/.test(depositUsdc)) {
    console.error(`Invalid --deposit value: ${depositUsdc}. Expected a decimal USDC amount like "1" or "0.5".`)
    process.exit(1)
  }
  return { merchantId, depositUsdc }
}

// ----------------------------------------------------------------------------
// KV writer (shells out to wrangler — same as inspect-channels.ts)
// ----------------------------------------------------------------------------

function kvPut(key: string, value: string): void {
  // wrangler kv key put takes the value either as a positional
  // arg or from a file. Values with special chars (JSON with
  // quotes, newlines) break positional args across shells, so
  // we always go through a temp file.
  const tmpFile = resolve(tmpdir(), `mpp-kv-${Date.now()}.json`)
  writeFileSync(tmpFile, value)
  try {
    execSync(
      `npx wrangler kv key put --binding MPP_STORE '${key}' --path '${tmpFile}' --remote`,
      { encoding: 'utf8', cwd: REPO_ROOT, stdio: 'inherit' },
    )
  } finally {
    try {
      unlinkSync(tmpFile)
    } catch {
      // tmp cleanup best-effort
    }
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
  const { merchantId, depositUsdc } = parseArgs(process.argv)
  const merchant = MERCHANTS[merchantId]
  if (!merchant) {
    console.error(`Unknown merchant id: ${merchantId}`)
    console.error(`Known: ${Object.keys(MERCHANTS).join(', ')}`)
    process.exit(1)
  }

  const vars = loadDevVars()
  const pk = vars.TEMPO_ROUTER_PRIVATE_KEY
  if (!pk) throw new Error('Missing TEMPO_ROUTER_PRIVATE_KEY in .dev.vars')

  const account = privateKeyToAccount(pk as `0x${string}`)
  const rpcUrl = vars.TEMPO_RPC_URL ?? 'https://rpc.tempo.xyz'
  console.log(`Opening Tempo session channel for ${merchant.name} (${merchant.id})`)
  console.log(`  Router wallet:    ${account.address}`)
  console.log(`  Merchant service: ${merchant.serviceUrl}`)
  console.log(`  Probe endpoint:   ${merchant.probeMethod} ${merchant.probePath}`)
  console.log(`  Tempo RPC:        ${rpcUrl}`)
  console.log(`  Deposit:          ${depositUsdc} USDC (${toBaseUnits(depositUsdc, 6).toString()} base units)`)
  console.log('')

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
  // `maxDeposit` is the manager's HARD cap for both the initial open AND
  // any later topUp(). When resuming an existing channel whose cumulative is
  // already non-zero, a topUp to `cumulative + --deposit headroom` can exceed
  // a cap set to just `--deposit`, and the topUp is rejected ("exceeds local
  // maxDeposit"). So we set the cap to `--deposit` PLUS a 1 USDC buffer that
  // comfortably covers any existing cumulative (these channels carry only a
  // few thousand base units). This only RAISES the ceiling; the actual
  // on-chain deposit is still driven by the open/topUp amounts below.
  const maxDepositRaw = toBaseUnits(depositUsdc, 6) + toBaseUnits('1', 6)
  const maxDepositUsdc = (Number(maxDepositRaw) / 1e6).toString()

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
  const desiredHeadroomRaw = toBaseUnits(depositUsdc, 6)
  const requiredDepositRaw = BigInt(sm.cumulative) + desiredHeadroomRaw
  const currentDepositRaw = BigInt(capturedStored?.deposit ?? '0')
  if (currentDepositRaw < requiredDepositRaw) {
    const topUpRaw = requiredDepositRaw - currentDepositRaw
    console.log(
      `  ↑ Topping up on-chain deposit by ${topUpRaw} base units ` +
        `(current deposit ${currentDepositRaw} < required ${requiredDepositRaw}) ...`,
    )
    try {
      await sm.topUp(topUpRaw)
      console.log(`  ✅ Top-up broadcast; on-chain deposit now covers cumulative + headroom`)
    } catch (err: any) {
      console.error(`  ⚠️ topUp failed: ${err.message} — voucher headroom may be insufficient`)
    }
  }

  // Extract what we need from the SessionManager state + the
  // probe challenge. SessionManager doesn't expose escrowContract
  // on its public surface, but the probe response carries a
  // `challenge` field (via the PaymentResponse extension) that
  // has `methodDetails.escrowContract`.
  const challengeFromProbe = (probeResult as any).challenge
  const methodDetails = challengeFromProbe?.request?.methodDetails ?? {}
  const escrowContract = methodDetails.escrowContract ?? ''
  const payee = methodDetails.recipient ?? challengeFromProbe?.request?.recipient ?? ''
  const chainId = methodDetails.chainId ?? 0

  // Prefer escrowContract from the probe challenge; fall back to the
  // escrow address reported by the session manager's stored channel.
  const resolvedEscrow = escrowContract || capturedStored?.escrow || ''

  const state: PersistedChannelState = {
    channelId: sm.channelId as string,
    escrowContract: resolvedEscrow,
    payee,
    // Canonical Tempo USDC asset handle — verified the same for
    // all 9 session merchants on 2026-04-11 via mpp.dev/api/services.
    currency: '0x20c000000000000000000000b9537d11c60e8b50',
    chainId,
    authorizedSigner: account.address,
    // Cumulative the manager reported via sessionStore.set() — the amount
    // already authorized on this channel (0 for a truly fresh channel, or
    // the prior watermark when resuming an existing on-chain channel).
    cumulativeRaw: capturedStored?.cumulativeAmount ?? sm.cumulative.toString(),
    // Deposit reflects the on-chain channel deposit AFTER the top-up above:
    // cumulative + the requested `--deposit` headroom. We must NOT use the
    // manager's sessionStore.set() echo (it can report a stale figure equal
    // to the current cumulative, leaving ZERO voucher headroom → every
    // voucher fails "amount exceeds deposit"). `requiredDepositRaw` is what
    // the channel now holds on-chain after topUp().
    depositRaw: requiredDepositRaw.toString(),
    openedAt: new Date().toISOString(),
    // TIP-1034 descriptor captured via sessionStore.set() — required by
    // the Worker's TIP-1034 session method to produce manual vouchers.
    ...(capturedStored?.descriptor ? { descriptor: capturedStored.descriptor } : {}),
  }

  if (!state.escrowContract) {
    console.warn('  ⚠️  escrowContract not captured from probe challenge or sessionStore.')
    console.warn('      Router voucher signing WILL fail without this field.')
    console.warn('      Hand-fill via `wrangler kv key put` before flipping the route.')
  }
  if (!state.payee) {
    console.warn('  ⚠️  payee not captured. Not used by voucher signing but')
    console.warn('      shows blank in inspect-channels.ts.')
  }
  if (!state.descriptor) {
    console.warn('  ⚠️  TIP-1034 descriptor not captured via sessionStore.')
    console.warn('      This means the merchant may be using v1 protocol, or')
    console.warn('      sessionStore.set() was not called during the open sequence.')
    console.warn('      v2 merchants (anthropic, openai, gemini, openrouter) REQUIRE')
    console.warn('      descriptor in KV for the Worker to produce manual vouchers.')
  }

  // Persist to KV
  const kvKey = `tempoChannel:${merchant.id}`
  const kvValue = JSON.stringify(state, null, 2)
  console.log(`\n→ Writing to KV: ${kvKey}`)
  console.log(kvValue)
  console.log('')
  kvPut(kvKey, kvValue)
  console.log(`✅ KV write complete.\n`)

  console.log('Next step: run `npx tsx scripts/admin/inspect-channels.ts` to verify the new channel is visible.')
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
