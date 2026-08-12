/**
 * Typed caller for the `PlaygroundLedger` Durable Object.
 *
 * Same shape as `src/mpp/rate-limit-do.ts`: a fake `https://*.internal`
 * origin, a `doPost<T>` helper, and one exported function per DO operation, so
 * route code never hand-builds a DO `Request`.
 *
 * Unlike the rate-limit caller there is no CAS retry loop here — every
 * operation is a single DO round-trip whose atomicity comes from the DO's own
 * request serialisation plus `storage.transaction()`.
 */

import type { Env } from '../index'
import type { ReserveOutcome, StoredCall, StoredIntent } from './ledger-do'
import {
  CALL_HISTORY_LIMIT,
  DEFAULT_GLOBAL_CAP_USD,
  DEPOSIT_CAP_PER_ACCOUNT_PER_DAY_USD,
  INTENT_RATE_PER_HOUR,
} from './models'
import { parseUsd } from './amount'

const DO_ORIGIN = 'https://playground-ledger.internal'

/**
 * All playground state lives in one instance — see the header of
 * `ledger-do.ts` for why the global cap and deposit-replay guard cannot be
 * sharded per account.
 */
function ledgerStub(env: Env): DurableObjectStub {
  return env.PLAYGROUND_LEDGER.get(env.PLAYGROUND_LEDGER.idFromName('playground'))
}

interface Ok<T> {
  ok: true
  value: T
}
export interface LedgerError {
  ok: false
  code: string
  message: string
  detail?: Record<string, string | number>
}
export type LedgerResult<T> = Ok<T> | LedgerError

async function doPost<T>(env: Env, path: string, payload: unknown): Promise<T> {
  const resp = await ledgerStub(env).fetch(
    new Request(`${DO_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`playground ledger DO ${path} failed (${resp.status}): ${text}`)
  }
  return resp.json() as Promise<T>
}

/**
 * Resolve the global outstanding-credit ceiling.
 *
 * Fails closed on a malformed env value: a typo in `PLAYGROUND_GLOBAL_CAP_USD`
 * must not silently become an unlimited cap, so an unparseable value falls
 * back to the compiled-in default rather than to "no limit".
 */
export function globalCapAtomic(env: Env): bigint {
  const raw = env.PLAYGROUND_GLOBAL_CAP_USD?.trim()
  if (!raw) return parseUsd(DEFAULT_GLOBAL_CAP_USD)
  try {
    const parsed = parseUsd(raw)
    if (parsed <= 0n) return parseUsd(DEFAULT_GLOBAL_CAP_USD)
    return parsed
  } catch {
    return parseUsd(DEFAULT_GLOBAL_CAP_USD)
  }
}

export function createIntent(
  env: Env,
  args: {
    intentId: string
    account: string
    amountAtomic: bigint
    memo: string
    now: number
    expiresAt: number
  },
): Promise<LedgerResult<StoredIntent>> {
  return doPost(env, '/intent/create', {
    intent_id: args.intentId,
    account: args.account,
    amount: args.amountAtomic.toString(),
    memo: args.memo,
    now: args.now,
    expires_at: args.expiresAt,
    per_account_day_cap: parseUsd(DEPOSIT_CAP_PER_ACCOUNT_PER_DAY_USD).toString(),
    global_cap: globalCapAtomic(env).toString(),
    intents_per_hour: INTENT_RATE_PER_HOUR,
  })
}

export function getIntent(env: Env, intentId: string): Promise<LedgerResult<StoredIntent>> {
  return doPost(env, '/intent/get', { intent_id: intentId })
}

export function openIntent(
  env: Env,
  args: {
    intentId: string
    txHash: string
    opIndex: number
    now: number
    sessionJti: string
    sessionExp: number
  },
): Promise<LedgerResult<{ intent: StoredIntent; balance: string; replayed: boolean }>> {
  return doPost(env, '/open', {
    intent_id: args.intentId,
    tx_hash: args.txHash,
    op_index: args.opIndex,
    now: args.now,
    session_jti: args.sessionJti,
    session_exp: args.sessionExp,
  })
}

export function readAccount(
  env: Env,
  account: string,
): Promise<LedgerResult<{ balance: string; calls: StoredCall[] }>> {
  return doPost(env, '/account', { account, limit: CALL_HISTORY_LIMIT })
}

export function reserve(
  env: Env,
  args: {
    callId: string
    account: string
    chip: string
    model?: string
    maxPriceAtomic: bigint
    now: number
  },
): Promise<LedgerResult<ReserveOutcome>> {
  return doPost(env, '/reserve', {
    call_id: args.callId,
    account: args.account,
    chip: args.chip,
    model: args.model,
    max_price: args.maxPriceAtomic.toString(),
    now: args.now,
    history_limit: CALL_HISTORY_LIMIT,
  })
}

export function commit(
  env: Env,
  callId: string,
  chargedAtomic: bigint,
): Promise<LedgerResult<{ call: StoredCall; balance: string; already_settled: boolean }>> {
  return doPost(env, '/settle', {
    call_id: callId,
    action: 'commit',
    charged: chargedAtomic.toString(),
  })
}

export function release(
  env: Env,
  callId: string,
  reason: string,
): Promise<LedgerResult<{ call: StoredCall; balance: string; already_settled: boolean }>> {
  return doPost(env, '/settle', { call_id: callId, action: 'release', reason })
}

export interface LedgerTotals {
  credited: string
  committed: string
  outstanding: string
  balances_sum: string
  holds_sum: string
  consumed_deposits: { tx_hash: string; op_index: number; intent_id: string }[]
}

export function readTotals(env: Env): Promise<LedgerResult<LedgerTotals>> {
  return doPost(env, '/totals', {})
}
