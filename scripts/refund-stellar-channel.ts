#!/usr/bin/env -S npx tsx
/**
 * Buyer-side escape hatch for a one-way Stellar payment channel.
 *
 * This does not call MPP Router. The channel funder signs directly with a
 * local Stellar CLI identity, so it still works when the Router is offline.
 *
 * Usage:
 *   npm run refund-channel -- status --channel <C...>
 *   npm run refund-channel -- start  --channel <C...> --source <identity>
 *   npm run refund-channel -- claim  --channel <C...> --source <identity>
 */
import { spawnSync } from 'node:child_process'

type Action = 'status' | 'start' | 'claim'

function usage(): never {
  console.error('Usage: npm run refund-channel -- <status|start|claim> --channel <C...> [--source <stellar-cli-identity>] [--network mainnet|testnet] [--dry-run]')
  process.exit(2)
}

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function main(): void {
  const args = process.argv.slice(2)
  const action = args[0] as Action | undefined
  const channel = value(args, '--channel')
  const source = value(args, '--source')
  const network = value(args, '--network') ?? 'mainnet'
  const dryRun = args.includes('--dry-run')

  if (!action || !['status', 'start', 'claim'].includes(action)) usage()
  if (!channel || !/^C[A-Z2-7]{55}$/.test(channel)) usage()
  if (!['mainnet', 'testnet'].includes(network)) usage()
  if (action !== 'status' && !source) usage()

  const method = action === 'start' ? 'close_start' : action === 'claim' ? 'refund' : 'balance'
  const command = [
    'contract', 'invoke', '--id', channel,
    ...(source ? ['--source-account', source] : []),
    '--network', network,
    ...(action === 'status' ? [] : ['--send=yes']),
    '--', method,
  ]

  if (dryRun) {
    console.log(`stellar ${command.join(' ')}`)
    return
  }

  const result = spawnSync('stellar', command, { encoding: 'utf8', stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)

  if (action === 'start') {
    console.log('Close started. Wait for the channel refund period, then run the claim command.')
  } else if (action === 'claim') {
    console.log('Refund submitted. The contract returned the entire remaining channel balance to the funder.')
  }
}

main()
