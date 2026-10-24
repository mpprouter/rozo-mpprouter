#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/topup-tempo-channel.ts — add deposit to an EXISTING router ->
 * merchant Tempo session channel (TIP-1034 escrow precompile), then record the
 * on-chain deposit in KV.
 *
 * MOVES MONEY (L3): broadcasts a Tempo transaction from the router's Tempo
 * pool wallet. Founder runs it himself, in Terminal.app, from a checkout of
 * this repo with .dev.vars present.
 *
 * Usage:
 *   npx tsx scripts/admin/topup-tempo-channel.ts <channelKey> --amount <USDC>          # dry run
 *   npx tsx scripts/admin/topup-tempo-channel.ts <channelKey> --amount <USDC> --yes    # broadcast
 *
 *   <channelKey> is the KV suffix: tempoChannel:<channelKey>, e.g. anthropic_messages.
 *
 * Why not open-tempo-channel.ts: that script opens a FRESH channel (new id,
 * cumulative reset), which strands whatever the old channel still holds. A
 * top-up keeps the channel id and the voucher watermark the Worker already
 * uses, so nothing else in KV changes except depositRaw.
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { Session } from 'mppx/tempo'
import { createClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoChain } from 'viem/chains'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ESCROW = '0x4d50500000000000000000000000000000000000'
const MAX_TOPUP_USDC = 50n * 1_000_000n

function loadDevVars(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(resolve(REPO_ROOT, '.dev.vars'), 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[t.slice(0, eq).trim()] = v
  }
  return out
}

function kvGet(key: string): string {
  return execSync(`npx wrangler kv key get --binding MPP_STORE '${key}' --remote`, {
    encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function kvPut(key: string, value: string): void {
  const tmp = resolve(tmpdir(), `mpp-kv-${Date.now()}.json`)
  writeFileSync(tmp, value)
  try {
    execSync(`npx wrangler kv key put --binding MPP_STORE '${key}' --path '${tmp}' --remote`, {
      encoding: 'utf8', cwd: REPO_ROOT, stdio: 'inherit',
    })
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
}

function toRaw(usdc: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(usdc)) throw new Error(`--amount must be a USDC decimal, got ${usdc}`)
  const [w, f = ''] = usdc.split('.')
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6))
}

const fmt = (raw: bigint) => (Number(raw) / 1e6).toFixed(6)

async function main() {
  const args = process.argv.slice(2)
  const channelKey = args[0]
  const amountIdx = args.indexOf('--amount')
  const yes = args.includes('--yes')
  if (!channelKey || channelKey.startsWith('-') || amountIdx === -1 || !args[amountIdx + 1]) {
    console.error('Usage: npx tsx scripts/admin/topup-tempo-channel.ts <channelKey> --amount <USDC> [--yes]')
    process.exit(2)
  }
  const amountRaw = toRaw(args[amountIdx + 1])
  if (amountRaw <= 0n || amountRaw > MAX_TOPUP_USDC) throw new Error('amount must be > 0 and <= 50 USDC per run')

  const kvKey = `tempoChannel:${channelKey}`
  const stored = JSON.parse(kvGet(kvKey))
  if (!stored.descriptor || !stored.channelId) throw new Error(`${kvKey} has no TIP-1034 descriptor; cannot top up`)
  if (String(stored.escrowContract).toLowerCase() !== ESCROW) throw new Error(`${kvKey} is not on the TIP-1034 escrow`)

  const account = privateKeyToAccount(loadDevVars().TEMPO_ROUTER_PRIVATE_KEY as `0x${string}`)
  if (account.address.toLowerCase() !== String(stored.descriptor.payer).toLowerCase()) {
    throw new Error('router key is not the channel payer; refusing')
  }
  const client = createClient({ chain: tempoChain, transport: http((loadDevVars().TEMPO_RPC_URL || 'https://rpc.tempo.xyz').split(',')[0].trim()), account })

  const before = await Session.Precompile.Chain.getChannelState(client as any, stored.channelId)
  const mask = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`
  console.log(`Channel ${kvKey} ${stored.channelId.slice(0, 10)}...`)
  console.log(`  payer (router pool) ${mask(account.address)}  payee ${mask(stored.descriptor.payee)}`)
  console.log(`  on-chain deposit ${fmt(BigInt(before.deposit))}  settled ${fmt(BigInt(before.settled))}  KV cumulative ${fmt(BigInt(stored.cumulativeRaw))}`)
  console.log(`  top-up            +${fmt(amountRaw)} USDC  ->  deposit ${fmt(BigInt(before.deposit) + amountRaw)}`)
  if (Number(before.closeRequestedAt) !== 0) throw new Error('channel has a pending close request; open a new channel instead')
  if (!yes) {
    console.log('\nDry run. Re-run with --yes to broadcast.')
    return
  }

  const hash = await Session.Precompile.Chain.topUpOnChain(client as any, stored.descriptor, amountRaw, ESCROW, {
    account,
    feeToken: stored.currency,
  })
  console.log(`  tx ${hash}`)
  let after = before
  for (let i = 0; i < 20; i++) {
    after = await Session.Precompile.Chain.getChannelState(client as any, stored.channelId)
    if (BigInt(after.deposit) > BigInt(before.deposit)) break
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (BigInt(after.deposit) <= BigInt(before.deposit)) throw new Error('deposit did not increase on chain; KV left unchanged')

  // Re-read KV right before writing and change ONLY depositRaw, so a voucher
  // the Worker signed while this ran (cumulativeRaw / lastVoucherAt) is kept.
  const fresh = JSON.parse(kvGet(kvKey))
  if (fresh.channelId !== stored.channelId) throw new Error(`${kvKey} now points at a different channel; KV left unchanged`)
  fresh.depositRaw = BigInt(after.deposit).toString()
  kvPut(kvKey, JSON.stringify(fresh, null, 2))
  console.log(`✅ on-chain deposit now ${fmt(BigInt(after.deposit))} USDC; KV depositRaw updated.`)
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`)
  process.exit(1)
})
