#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/swap-tempo-token.ts — One-off swap on Tempo's native
 * stablecoin DEX to acquire a TIP20 token the router pool lacks.
 *
 * Why this exists (2026-07-29): the *.mpp.tempo.xyz merchants
 * (openai, anthropic, gemini, dune, openrouter) migrated their charge
 * currency from USDC.e (0x20c0…8b50) to NANOUSD (0x20c0…ec7a). The
 * router wallet held 0 NANOUSD, so every charge to those merchants
 * reverted with `TIP20 InsufficientBalance` AFTER the customer had
 * already paid Stellar-side. This script swaps pool USDC.e → NANOUSD.
 *
 * This SPENDS REAL MONEY from TEMPO_ROUTER_PRIVATE_KEY (.dev.vars).
 * Dry-run by default; pass --execute to broadcast.
 *
 * Usage:
 *   npx tsx scripts/admin/swap-tempo-token.ts --amount-out 10            # quote only
 *   npx tsx scripts/admin/swap-tempo-token.ts --amount-out 10 --execute  # swap
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createWalletClient, createPublicClient, http, formatUnits, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoChain } from 'viem/chains'
import { Actions, Addresses } from 'viem/tempo'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50' as const
const NANOUSD = '0x20c0000000000000000000008b4c619d2eedec7a' as const
const RPC = 'https://rpc.tempo.xyz'

function loadDevVar(key: string): string {
  // Single-key extraction; value never printed.
  const raw = readFileSync(resolve(REPO_ROOT, '.dev.vars'), 'utf8')
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t.startsWith(`${key}=`)) {
      let v = t.slice(key.length + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1)
      return v
    }
  }
  throw new Error(`${key} not found in .dev.vars`)
}

async function main() {
  const args = process.argv.slice(2)
  const execute = args.includes('--execute')
  const amountIdx = args.indexOf('--amount-out')
  const amountOutHuman = amountIdx >= 0 ? args[amountIdx + 1] : '10'
  const amountOut = parseUnits(amountOutHuman!, 6)

  const account = privateKeyToAccount(loadDevVar('TEMPO_ROUTER_PRIVATE_KEY') as `0x${string}`)
  const publicClient = createPublicClient({ chain: tempoChain, transport: http(RPC) })
  const wallet = createWalletClient({ account, chain: tempoChain, transport: http(RPC) })

  console.log(`router wallet: ${account.address}`)
  console.log(`target: buy ${amountOutHuman} NANOUSD paying USDC.e`)

  const quotedIn = await Actions.dex.getBuyQuote(publicClient as never, {
    tokenIn: USDC_E,
    tokenOut: NANOUSD,
    amountOut,
  })
  const maxIn = quotedIn + (quotedIn * 100n) / 10_000n // 1% slippage
  console.log(`quote: ${formatUnits(quotedIn, 6)} USDC.e (max ${formatUnits(maxIn, 6)} @1% slippage)`)

  if (!execute) {
    console.log('dry-run only. Re-run with --execute to broadcast.')
    return
  }

  const approveCall = Actions.token.approve.call({
    amount: maxIn,
    spender: Addresses.stablecoinDex,
    token: USDC_E,
  }) as { address: `0x${string}`; abi: unknown; functionName: string; args: unknown[] }
  const approveTx = await wallet.writeContract(approveCall as never)
  console.log(`approve tx: ${approveTx}`)
  await publicClient.waitForTransactionReceipt({ hash: approveTx })

  const buyCall = Actions.dex.buy.call({
    tokenIn: USDC_E,
    tokenOut: NANOUSD,
    amountOut,
    maxAmountIn: maxIn,
  }) as { address: `0x${string}`; abi: unknown; functionName: string; args: unknown[] }
  const buyTx = await wallet.writeContract(buyCall as never)
  console.log(`buy tx: ${buyTx}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash: buyTx })
  console.log(`status: ${receipt.status}`)

  const bal = await publicClient.readContract({
    address: NANOUSD,
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [account.address],
  })
  console.log(`NANOUSD balance now: ${formatUnits(bal as bigint, 6)}`)
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/0x[0-9a-fA-F]{64}/g, '0x<redacted>'))
  process.exit(1)
})
