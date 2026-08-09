import { DurableObject } from 'cloudflare:workers'
import {
  runRefundSigner,
  sendAlert,
  assertRefundWithinPaid,
  type Env as CoreEnv,
  type RefundJob,
  type RefundLedger,
} from './refund-signer-core'

export interface Env extends CoreEnv {
  SIGNER_COORDINATOR: DurableObjectNamespace<RefundSignerCoordinator>
}

export class RefundSignerCoordinator extends DurableObject<Env> implements RefundLedger {
  private running = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS refund_reservations (
          refund_id TEXT PRIMARY KEY,
          payment_tx TEXT NOT NULL,
          amount_atomic TEXT NOT NULL,
          paid_atomic TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS refund_reservations_payment
          ON refund_reservations(payment_tx);
        CREATE TABLE IF NOT EXISTS alert_outbox (
          alert_key TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)
    })
  }

  async reserve(job: RefundJob, paidAtomic: bigint): Promise<void> {
    const existing = this.ctx.storage.sql.exec<{
      payment_tx: string; amount_atomic: string; paid_atomic: string
    }>('SELECT payment_tx, amount_atomic, paid_atomic FROM refund_reservations WHERE refund_id = ?', job.refundId).toArray()[0]
    if (existing) {
      if (existing.payment_tx !== job.payment.paymentTx || existing.amount_atomic !== job.refundAmountAtomic || existing.paid_atomic !== String(paidAtomic)) {
        throw new Error('refund reservation proof changed')
      }
      return
    }
    const rows = this.ctx.storage.sql.exec<{ amount_atomic: string }>(
      'SELECT amount_atomic FROM refund_reservations WHERE payment_tx = ?', job.payment.paymentTx,
    ).toArray()
    const reserved = rows.reduce((total, row) => total + BigInt(row.amount_atomic), 0n)
    const amount = BigInt(job.refundAmountAtomic)
    assertRefundWithinPaid(reserved, amount, paidAtomic)
    this.ctx.storage.sql.exec(
      'INSERT INTO refund_reservations (refund_id, payment_tx, amount_atomic, paid_atomic, state, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      job.refundId, job.payment.paymentTx, job.refundAmountAtomic, String(paidAtomic), 'reserved', Date.now(),
    )
  }

  async markConfirmed(refundId: string): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE refund_reservations SET state = ? WHERE refund_id = ?', 'confirmed', refundId)
  }

  async enqueueAlert(key: string, content: string): Promise<void> {
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO alert_outbox (alert_key, content, state, created_at) VALUES (?, ?, ?, ?)',
      key, content, 'pending', Date.now(),
    )
  }

  private async flushAlerts(): Promise<void> {
    const alerts = this.ctx.storage.sql.exec<{ alert_key: string; content: string }>(
      'SELECT alert_key, content FROM alert_outbox WHERE state = ? ORDER BY created_at LIMIT 20', 'pending',
    ).toArray()
    for (const alert of alerts) {
      try {
        await sendAlert(this.env, alert.content)
        this.ctx.storage.sql.exec('UPDATE alert_outbox SET state = ? WHERE alert_key = ?', 'sent', alert.alert_key)
      } catch (error: unknown) {
        console.error(JSON.stringify({
          event: 'refund_alert_failed',
          alertKey: alert.alert_key,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }
  }

  async run(): Promise<{ skipped: boolean }> {
    if (this.running) return { skipped: true }
    this.running = true
    try {
      // Retry durable notifications even when the Router API is temporarily
      // unavailable during this cron invocation.
      await this.flushAlerts()
      await runRefundSigner(this.env, this)
      await this.flushAlerts()
      return { skipped: false }
    } finally {
      this.running = false
    }
  }
}

export default {
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(env.SIGNER_COORDINATOR.getByName('router-account').run())
  },
} satisfies ExportedHandler<Env>
