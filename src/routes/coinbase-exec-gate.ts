// Per-invoice execution gate for Coinbase pay-invoice calls.
//
// `claimInvoiceKey` (invoice-claim.ts) serializes channels against each other
// (UPI vs crypto), but it is deliberately re-entrant for the same channel/ref:
// the Coinbase webhook retries under the same plId. That re-entrancy means two
// deliveries of a payout event for the same link (an original plus a resend, or
// two events racing on the non-atomic KV record) can both reach pay-invoice.
//
// This gate is the NON-re-entrant "at most one pay-invoice request per link"
// lock. It is a versioned CAS insert on the linearizable AtomicStoreDO (same
// primitive as invoice-claim.ts), not a KV get/set.
//
// Semantics:
//   - absent  → holder written, ok
//   - present → refused, holder returned; the caller must NOT pay
//
// Acquire it as the last step before sending the pay-invoice request. Once the
// request has been sent the gate is NEVER released, whatever the outcome
// (success, failure, timeout, unknown). Release is only for a definite failure
// before the request was sent. A human who has confirmed on Coinbase that the
// link is NOT settled may delete the key to allow a manual re-pay (runbook:
// docs/invoice-fulfillment-techdoc-2026-07-03.md).

import type { Env } from '../index'
import { casUpdate, casRead } from './stripe-atomic'

export interface ExecGateHolder {
  // Webhook event id, or `coupon:<code>` for the coupon redemption path.
  holder: string
  at: string
}

export type ExecGateResult = { ok: true; gate: ExecGateHolder } | { ok: false; holder: ExecGateHolder }

export function coinbaseExecGateKey(plId: string): string {
  return `coinbase-pay-exec:v1:${plId}`
}

function parseGate(raw: string | null): ExecGateHolder | null {
  if (!raw) return null
  try {
    const g = JSON.parse(raw) as ExecGateHolder
    if (typeof g.holder === 'string' && typeof g.at === 'string') return g
    return null
  } catch {
    return null
  }
}

/** Atomically take the execution gate for `plId`. Linearizable (DO CAS). */
export async function acquireCoinbaseExecGate(
  env: Env,
  plId: string,
  holder: string,
  now: Date = new Date(),
): Promise<ExecGateResult> {
  return casUpdate<ExecGateResult>(env, coinbaseExecGateKey(plId), (raw) => {
    const existing = parseGate(raw)
    if (existing) return { op: 'noop', result: { ok: false, holder: existing } }
    const gate: ExecGateHolder = { holder, at: now.toISOString() }
    return { op: 'set', value: JSON.stringify(gate), result: { ok: true, gate } }
  })
}

/** Read the current holder (or null). */
export async function readCoinbaseExecGate(env: Env, plId: string): Promise<ExecGateHolder | null> {
  const { value } = await casRead(env, coinbaseExecGateKey(plId))
  return parseGate(value)
}

/**
 * Release a gate held by exactly `holder`. ONLY for a definite failure before
 * the pay-invoice request was sent. Never call after the request went out.
 */
export async function releaseCoinbaseExecGate(env: Env, plId: string, holder: string): Promise<boolean> {
  return casUpdate<boolean>(env, coinbaseExecGateKey(plId), (raw) => {
    const existing = parseGate(raw)
    if (!existing || existing.holder !== holder) return { op: 'noop', result: false }
    // An empty value parses as "no gate" (parseGate → null).
    return { op: 'set', value: '', result: true }
  })
}
