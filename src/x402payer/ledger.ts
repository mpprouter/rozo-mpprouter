/**
 * x402 payer ledger client. The ledger (balances, idempotency rows, nonce
 * uniqueness, the X402_PAYER switch) lives in the Rozo Intents Supabase
 * project, migration 20261010180000_x402_payer_ledger.sql. This Worker holds
 * only that project's anon key plus the shared secret X402_LEDGER_RPC_SECRET;
 * every call is a secret-gated RPC, the same pattern as utils/alert.ts.
 */

export type PayerMode = 'off' | 'shadow' | 'on'

export interface LedgerAccount {
  id: string
  status: 'active' | 'suspended' | 'closed'
  balance_usd: string
  per_tx_limit_usd: string
  daily_limit_usd: string
  spent_today_usd: string
  pay_to_allowlist: string[] | null
  /** e.g. ["reversal_pending"] while a reversed top-up awaits a human. */
  flags?: string[]
  created_at: string
}

export interface LedgerPayment {
  id: string
  idempotency_key: string
  accepts_hash: string
  network: string
  asset: string
  amount_atomic: string
  amount_usd: string
  pay_to: string
  funder: string
  nonce: string
  credential: Record<string, unknown> | null
  valid_before: string | null
  mode: 'shadow' | 'on'
  status: string
  /** Set once the expired, unused credential was refunded to the balance. */
  refunded_at?: string | null
  refund_reason?: string | null
  created_at: string
}

export interface OpsPending {
  authorization_checks: Array<{ payment_id: string; funder: string; nonce: string; valid_before: string }>
  reversals: Array<{ payment_id: string; account_id: string; credited_usd: string | null; review_reason: string | null; updated_at: string }>
}

export interface OpsReport {
  authorizations?: Array<{ payment_id: string; used: boolean }>
  reversals_alerted?: string[]
}

export interface LedgerResult {
  mode: PayerMode
  outcome: string
  reason?: string
  account?: LedgerAccount
  /** From account_get: the row an idempotency key maps to, or {foreign:true}. */
  payment?: LedgerPayment | { foreign: true }
  balance_usd?: string
  limit_usd?: string
  spent_today_usd?: string
  status?: string
  credit?: { outcome: string; credited_usd?: string }
  [k: string]: unknown
}

export interface CommitArgs {
  key_digest: string
  idempotency_key: string
  accepts_hash: string
  accepts: Record<string, unknown>
  scheme: 'exact'
  network: string
  asset: string
  amount_atomic: string
  pay_to: string
  funder: string
  nonce: string
  credential: Record<string, unknown> | null
  valid_before_unix: number | null
  /** The mode this request acted on; the RPC refuses if the switch moved. */
  mode: 'shadow' | 'on'
}

export interface X402Ledger {
  createAccount(keyDigest: string, label: string | null): Promise<LedgerResult>
  getAccount(keyDigest: string, idempotencyKey?: string): Promise<LedgerResult>
  commitPayment(args: CommitArgs): Promise<LedgerResult>
  registerTopup(args: {
    key_digest: string
    payment_id: string
    requested_usd: string
    expected_receiver: string
  }): Promise<LedgerResult>
  liabilitySnapshot(): Promise<Record<string, unknown>>
  opsPending(limit?: number): Promise<OpsPending>
  opsReport(report: OpsReport): Promise<Record<string, unknown>>
}

export class LedgerUnavailableError extends Error {}

export interface LedgerEnv {
  X402_LEDGER_SUPABASE_URL?: string
  X402_LEDGER_SUPABASE_ANON_KEY?: string
  X402_LEDGER_RPC_SECRET?: string
  // Same Intents project the alert archive writes to; used when the
  // dedicated names are unset so no extra config is needed.
  ALERT_LOG_SUPABASE_URL?: string
  ALERT_LOG_SUPABASE_ANON_KEY?: string
}

/** Supabase RPC-backed ledger, or null when not configured (routes answer 503). */
export function supabaseLedger(env: LedgerEnv, fetchImpl: typeof fetch = fetch): X402Ledger | null {
  const url = (env.X402_LEDGER_SUPABASE_URL || env.ALERT_LOG_SUPABASE_URL || '').replace(/\/+$/, '')
  const anon = env.X402_LEDGER_SUPABASE_ANON_KEY || env.ALERT_LOG_SUPABASE_ANON_KEY
  const secret = env.X402_LEDGER_RPC_SECRET
  if (!url || !anon || !secret) return null

  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    let res: Response
    try {
      res = await fetchImpl(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: anon!,
          authorization: `Bearer ${anon}`,
        },
        body: JSON.stringify({ p_secret: secret, p_args: args }),
      })
    } catch (err) {
      throw new LedgerUnavailableError(`ledger ${fn} unreachable: ${(err as Error).message}`)
    }
    if (!res.ok) {
      // Never echo the body: PostgREST errors can quote parameters.
      throw new LedgerUnavailableError(`ledger ${fn} failed: HTTP ${res.status}`)
    }
    return (await res.json()) as T
  }

  return {
    createAccount: (keyDigest, label) => rpc('x402_account_create', { key_digest: keyDigest, label }),
    getAccount: (keyDigest, idempotencyKey) =>
      rpc('x402_account_get', idempotencyKey ? { key_digest: keyDigest, idempotency_key: idempotencyKey } : { key_digest: keyDigest }),
    commitPayment: (args) => rpc('x402_payment_commit', args as unknown as Record<string, unknown>),
    registerTopup: (args) => rpc('x402_topup_register', args),
    liabilitySnapshot: () => rpc('x402_liability_snapshot', {}),
    opsPending: (limit = 50) => rpc('x402_ops_pending', { limit }),
    opsReport: (report) => rpc('x402_ops_report', report as unknown as Record<string, unknown>),
  }
}
