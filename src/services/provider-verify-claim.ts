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

/** Public, secret-free view of the claim behind a provider's paid gate. */
export type ClaimView =
  | { state: 'none' }
  | { state: 'in_progress'; startedAt: string }
  | { state: 'completed'; result: GateResult; updatedAt: string }
  | { state: 'uncertain'; result?: GateResult; startedAt: string; updatedAt: string }

export async function readClaimState(env: Env, providerId: string, registrationVersion: string): Promise<ClaimView> {
  if (!env.ATOMIC_STORE) return { state: 'none' }
  const current = await read(env, `providerVerifyClaim:${providerId}:${registrationVersion}`)
  if (!current.value) return { state: 'none' }
  const state = JSON.parse(current.value) as ClaimState
  if (state.status === 'completed' && state.result) return { state: 'completed', result: state.result, updatedAt: state.updatedAt }
  if (state.status === 'uncertain') return { state: 'uncertain', result: state.result, startedAt: state.startedAt, updatedAt: state.updatedAt }
  return { state: 'in_progress', startedAt: state.startedAt }
}

export type ReconcileOutcome =
  | { status: 'not_uncertain' }
  /** The hash settled to the provider and the provider had served 200: publishable. */
  | { status: 'settled_and_served'; result: GateResult }
  /** Money reached the provider but the call was not served. Frozen; needs a new registration version. */
  | { status: 'paid_not_served'; txHash: string; detail: string }
  /** The hash never landed on the ledger long after the attempt: nothing was paid, retry is safe. */
  | { status: 'released'; detail: string }
  /** No hash to look up, or Horizon still cannot answer. Stays frozen. */
  | { status: 'unresolved'; detail: string; txHash?: string }

/**
 * Settle an uncertain paid-gate outcome from the chain, never by paying again.
 *
 * The claim store freezes any attempt whose payment may have moved. This
 * is the only way out of that state without a new registration version:
 * read the transaction the receipt named and let the ledger say what
 * happened. A hash that shows the provider was paid and the provider
 * served 200 completes the gate; a hash that is absent from the ledger a
 * long time after the attempt means nothing was paid and the claim is
 * released; anything else stays frozen with the evidence attached.
 */
export async function reconcileUncertainClaim(
  env: Env,
  args: {
    providerId: string
    registrationVersion: string
    settled: (txHash: string) => Promise<GateResult>
    /** Minutes a missing hash must be missing before it is called unpaid. */
    releaseAfterMinutes?: number
  },
): Promise<ReconcileOutcome> {
  const key = `providerVerifyClaim:${args.providerId}:${args.registrationVersion}`
  const current = await read(env, key)
  if (!current.value) return { status: 'not_uncertain' }
  const state = JSON.parse(current.value) as ClaimState
  if (state.status !== 'uncertain') return { status: 'not_uncertain' }
  const failed = state.result && !state.result.ok ? state.result : undefined
  const txHash = failed?.txHash
  if (!txHash) {
    return {
      status: 'unresolved',
      detail: 'No settlement hash was recorded for this attempt, so the ledger cannot be consulted. ' +
        'Fix the endpoint if it was at fault, then re-register with a changed registration to start a fresh verification.',
    }
  }
  const settled = await args.settled(txHash)
  if (settled.ok) {
    // Served 200 with a receipt but Horizon was unreadable at the time.
    if (failed?.code === 'settlement_unverified') {
      const completed: ClaimState = {
        status: 'completed', startedAt: state.startedAt, updatedAt: new Date().toISOString(),
        result: { ...settled, detail: `Reconciled from the ledger: ${settled.detail}` },
      }
      await commit(env, key, current.version, 'set', JSON.stringify(completed))
      return { status: 'settled_and_served', result: completed.result! }
    }
    return {
      status: 'paid_not_served',
      txHash,
      detail: `Transaction ${txHash} paid the provider, but the call was not served successfully ` +
        `(${failed?.code}). This attempt stays frozen; fix the endpoint and re-register with a changed registration.`,
    }
  }
  if (settled.code === 'tx_not_on_ledger') {
    const ageMinutes = (Date.now() - Date.parse(state.startedAt)) / 60_000
    if (ageMinutes >= (args.releaseAfterMinutes ?? 30)) {
      await commit(env, key, current.version, 'delete')
      return {
        status: 'released',
        detail: `Transaction ${txHash} is not on the ledger ${Math.floor(ageMinutes)} minutes after the attempt; nothing was paid. Verification may be retried.`,
      }
    }
    return { status: 'unresolved', txHash, detail: `Transaction ${txHash} is not on the ledger yet. Check again later.` }
  }
  return { status: 'unresolved', txHash, detail: settled.detail }
}
