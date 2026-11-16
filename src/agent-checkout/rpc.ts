/**
 * Agent Checkout spend-request RPC client (PR-5).
 *
 * The spend requests, executions and agent bindings live in the Rozo Intents
 * Supabase project (migration 20261111200000_agent_checkout_spend_requests.sql,
 * PR-4). Every call is a Vault-secret-gated RPC `(p_secret, p_args) -> jsonb`,
 * the same shape as the x402 ledger (src/x402payer/ledger.ts). This Worker
 * holds only the project's anon key plus AC_RPC_SECRET; the tables themselves
 * are closed to every API role.
 *
 * The database switch AC_REQUESTS_MODE (off | shadow | on, default off) is read
 * by every RPC; this Worker additionally refuses every route unless
 * AC_REQUESTS_ENABLED is exactly 'true' (routes.ts), so nothing reaches the
 * database while either side is off.
 */

export interface AcResult {
  outcome: string
  reason?: string
  request?: AcSpendRow
  requests?: AcSpendRow[]
  [k: string]: unknown
}

/** ac__spend_json output (snake_case, nulls stripped). */
export interface AcSpendRow {
  spend_request_id: string
  display_ref: string
  environment: 'prod' | 'test'
  status: string
  status_version: number
  status_reason?: string
  provider: string
  invoice_id: string
  entry: string
  requested_by_type: 'owner' | 'agent'
  merchant_display?: string
  merchant_verified?: boolean
  beneficiary_verified?: boolean
  invoice_amount?: string
  invoice_currency?: string
  fee_atomic?: string
  total_debit_atomic?: string
  quote_version?: number
  quote_expires_at?: string
  approval_expires_at?: string
  funding_mode?: 'balance' | 'per_payment'
  context?: string
  line_items?: unknown
  exception_flag?: string
  merchant_delivery_status?: string
  merchant_payment_status?: string
  created_at?: string
  updated_at?: string
  owner_account_id?: string
  [k: string]: unknown
}

export class AcUnavailableError extends Error {}

export interface AcRpcEnv {
  AC_RPC_SECRET?: string
  AC_SUPABASE_URL?: string
  AC_SUPABASE_ANON_KEY?: string
  // Same Intents project the x402 ledger and the alert archive use; used when
  // the dedicated names are unset.
  X402_LEDGER_SUPABASE_URL?: string
  X402_LEDGER_SUPABASE_ANON_KEY?: string
  ALERT_LOG_SUPABASE_URL?: string
  ALERT_LOG_SUPABASE_ANON_KEY?: string
}

export type AcRpcName =
  | 'ac_owner_ensure'
  | 'ac_principal_resolve'
  | 'ac_bind_request_create'
  | 'ac_bind_request_claim'
  | 'ac_bind_request_decide'
  | 'ac_binding_revoke'
  | 'ac_spend_create'
  | 'ac_spend_present'
  | 'ac_spend_issue_card'
  | 'ac_spend_refresh'
  | 'ac_spend_link_order'
  | 'ac_spend_deny'
  | 'ac_spend_cancel'
  | 'ac_spend_get'
  | 'ac_spend_list'

export type AcRpc = (fn: AcRpcName, args: Record<string, unknown>) => Promise<AcResult>

const RPC_TIMEOUT_MS = 8_000

/** Secret-gated RPC caller, or null when not configured (routes answer 503). */
export function acRpcClient(env: AcRpcEnv, fetchImpl: typeof fetch = fetch): AcRpc | null {
  const url = (env.AC_SUPABASE_URL || env.X402_LEDGER_SUPABASE_URL || env.ALERT_LOG_SUPABASE_URL || '').replace(/\/+$/, '')
  const anon = env.AC_SUPABASE_ANON_KEY || env.X402_LEDGER_SUPABASE_ANON_KEY || env.ALERT_LOG_SUPABASE_ANON_KEY
  const secret = env.AC_RPC_SECRET
  if (!url || !anon || !secret) return null

  return async (fn, args) => {
    let res: Response
    try {
      res = await fetchImpl(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: anon,
          authorization: `Bearer ${anon}`,
        },
        body: JSON.stringify({ p_secret: secret, p_args: args }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
    } catch (err) {
      throw new AcUnavailableError(`${fn} unreachable: ${(err as Error).name}`)
    }
    if (!res.ok) {
      // Never echo the body: PostgREST errors can quote parameters.
      throw new AcUnavailableError(`${fn} failed: HTTP ${res.status}`)
    }
    const out = (await res.json().catch(() => null)) as AcResult | null
    if (!out || typeof out.outcome !== 'string') throw new AcUnavailableError(`${fn} returned no outcome`)
    return out
  }
}
