import type { Env } from '../index'
import type { GateResult } from './provider-verification'

type ClaimState = {
  status: 'in_progress' | 'completed' | 'uncertain'
  startedAt: string
  updatedAt: string
  result?: GateResult
}

export type ClaimedGateResult =
  | { status: 'ran'; result: GateResult }
  | { status: 'in_progress'; retryAfterSeconds: number }
  | { status: 'uncertain'; detail: string }
  | { status: 'completed'; result: GateResult }

const ORIGIN = 'https://provider-verify-claim.internal'

function stub(env: Env) {
  return env.ATOMIC_STORE.get(env.ATOMIC_STORE.idFromName('provider-verify-claim'))
}

async function read(env: Env, key: string): Promise<{ value: string | null; version: number }> {
  const response = await stub(env).fetch(new Request(`${ORIGIN}/read`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
  }))
  if (!response.ok) throw new Error('verification claim store unavailable')
  return response.json() as Promise<{ value: string | null; version: number }>
}

async function commit(env: Env, key: string, version: number, op: 'set' | 'delete', value?: string): Promise<boolean> {
  const response = await stub(env).fetch(new Request(`${ORIGIN}/commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, expectedVersion: version, op, ...(value === undefined ? {} : { value }) }),
  }))
  if (!response.ok) throw new Error('verification claim store unavailable')
  return ((await response.json()) as { ok: boolean }).ok
}

function canSafelyRetry(result: GateResult): boolean {
  return !result.ok && ['gate_unavailable', 'too_expensive_to_verify', 'no_stellar_payout', 'budget_exhausted', 'bad_price'].includes(result.code)
}

export async function runClaimedPaidGate(
  env: Env,
  providerId: string,
  registrationVersion: string,
  run: () => Promise<GateResult>,
): Promise<ClaimedGateResult> {
  const key = `providerVerifyClaim:${providerId}:${registrationVersion}`
  const current = await read(env, key)
  if (current.value) {
    const state = JSON.parse(current.value) as ClaimState
    if (state.status === 'completed' && state.result) return { status: 'completed', result: state.result }
    if (state.status === 'uncertain') return { status: 'uncertain', detail: state.result && !state.result.ok ? state.result.detail : 'Payment outcome is uncertain.' }
    if (Date.now() - Date.parse(state.startedAt) > 5 * 60_000) {
      return { status: 'uncertain', detail: 'Verification stopped while a payment may have been in flight. Manual status checking is required; it will not be retried automatically.' }
    }
    return { status: 'in_progress', retryAfterSeconds: 10 }
  }
  const now = new Date().toISOString()
  const acquired = await commit(env, key, current.version, 'set', JSON.stringify({ status: 'in_progress', startedAt: now, updatedAt: now } satisfies ClaimState))
  if (!acquired) return { status: 'in_progress', retryAfterSeconds: 10 }

  let result: GateResult
  try {
    result = await run()
  } catch {
    result = { ok: false, code: 'paid_call_uncertain', detail: 'The paid call ended without a definite settlement result. It will not be retried automatically.' }
  }
  const claimed = await read(env, key)
  if (canSafelyRetry(result)) {
    await commit(env, key, claimed.version, 'delete')
    return { status: 'ran', result }
  }
  const state: ClaimState = {
    status: result.ok ? 'completed' : 'uncertain', startedAt: now,
    updatedAt: new Date().toISOString(), result,
  }
  await commit(env, key, claimed.version, 'set', JSON.stringify(state))
  return { status: 'ran', result }
}
