#!/usr/bin/env tsx
/**
 * Pull-only refund executor. The Router pool key stays in Stellar CLI's OS
 * keystore and never passes through the Worker or this process environment.
 *
 * Required env: REFUND_ADMIN_TOKEN. Example:
 *   npm exec tsx scripts/admin/refund-executor.ts -- \
 *     --router https://apiserver.mpprouter.dev --source router-mainnet --network mainnet
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
function arg(name: string, fallback?: string): string {
  const i = args.indexOf(name)
  const value = i >= 0 ? args[i + 1] : fallback
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

const router = arg('--router', 'https://apiserver.mpprouter.dev').replace(/\/$/, '')
const source = arg('--source')
const network = arg('--network', 'mainnet')
const token = process.env.REFUND_EXECUTOR_TOKEN ?? process.env.REFUND_ADMIN_TOKEN
if (!token) throw new Error('REFUND_EXECUTOR_TOKEN is required')
const watch = args.includes('--watch')
const maxAtomic = process.env.REFUND_MAX_ATOMIC ? BigInt(process.env.REFUND_MAX_ATOMIC) : null

function stellar(command: string[]): string {
  return execFileSync('stellar', command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).trim()
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${router}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init?.headers },
  })
  const value = await response.json()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`)
  return value
}

async function execute(job: any): Promise<void> {
  const amount = BigInt(job.refundAmountAtomic)
  if (amount <= 0n) throw new Error(`refund ${job.refundId}: amount must be positive`)
  if (maxAtomic !== null && amount > maxAtomic) {
    throw new Error(`refund ${job.refundId}: amount exceeds operator REFUND_MAX_ATOMIC policy`)
  }
  const operator = stellar(['keys', 'address', source])
  if (job.payment.recipient !== operator) throw new Error(`refund ${job.refundId}: source is not original recipient`)
  if (job.payment.asset !== 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75') {
    throw new Error(`refund ${job.refundId}: asset is not pubnet USDC SAC`)
  }

  if (job.state === 'submitted') {
    if (!job.signedXdr || !job.refundTx || !job.lease?.id) {
      throw new Error(`refund ${job.refundId}: submitted record is incomplete`)
    }
    try {
      // Safe after an ambiguous outcome: resubmitting the exact same signed
      // envelope has the same hash and cannot create a second refund.
      stellar(['tx', 'send', '--network', network, job.signedXdr])
    } catch {
      // It may already be accepted; the Worker RPC confirmation below is the
      // authority, not this command's exit code.
    }
    await api('/admin/refunds/confirm', {
      method: 'POST', body: JSON.stringify({ refundId: job.refundId, leaseId: job.lease.id }),
    })
    console.log(JSON.stringify({ refundId: job.refundId, refundTx: job.refundTx, reconciled: true }))
    return
  }

  const leaseId = randomUUID()
  const leased = (await api('/admin/refunds/lease', {
    method: 'POST', body: JSON.stringify({ refundId: job.refundId, leaseId }),
  })).job

  // Build, sign, and hash before broadcast. If send becomes ambiguous, the
  // same signed XDR/hash can be reconciled; never construct a second payment.
  const unsignedXdr = stellar([
    'contract', 'invoke', '--id', leased.payment.asset, '--source', source,
    '--network', network, '--build-only', '--', 'transfer',
    '--from', operator, '--to', leased.payment.payer, '--amount', leased.refundAmountAtomic,
  ])
  const signedXdr = stellar(['tx', 'sign', '--network', network, '--sign-with-key', source, unsignedXdr])
  const refundTx = stellar(['tx', 'hash', '--network', network, signedXdr])

  await api('/admin/refunds/complete', {
    method: 'POST', body: JSON.stringify({
      refundId: job.refundId, leaseId, state: 'submitted', refundTx, signedXdr,
    }),
  })
  try {
    stellar(['tx', 'send', '--network', network, signedXdr])
    // `stellar tx send` waits for the Soroban transaction result. Marking the
    // record confirmed is still an authenticated executor assertion; public
    // verifiers can independently resolve refund_tx on Stellar RPC/Horizon.
    await api('/admin/refunds/confirm', {
      method: 'POST', body: JSON.stringify({ refundId: job.refundId, leaseId }),
    })
    console.log(JSON.stringify({ refundId: job.refundId, refundTx, amountAtomic: String(amount) }))
  } catch (error) {
    console.error(`broadcast outcome unknown for ${refundTx}; reconcile this exact hash/XDR, do not rebuild`)
    throw error
  }
}

async function runOnce(): Promise<boolean> {
  const pending = await api('/admin/refunds/pending')
  let failed = false
  for (const job of pending.jobs) {
    try {
      await execute(job)
    } catch (error) {
      failed = true
      console.error(error)
    }
  }
  return failed
}

if (watch) {
  for (;;) {
    await runOnce()
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
} else if (await runOnce()) {
  process.exitCode = 1
}
