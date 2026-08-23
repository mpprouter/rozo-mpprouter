/**
 * Order ledger (src/services/order-ledger.ts) — the per-call metadata
 * record from design doc §2.9. v1 stores order metadata only, never
 * response bodies, in a keyspace separate from ops-event data.
 */

import { describe, it, expect } from 'vitest'
import { newOrderId, recordOrder } from '../src/services/order-ledger'
import type { Env } from '../src/index'

function freshKv(): { kv: Map<string, string>; ns: KVNamespace } {
  const kv = new Map<string, string>()
  const ns = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => { kv.set(key, value) },
    delete: async (key: string) => { kv.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace
  return { kv, ns }
}

describe('newOrderId', () => {
  it('generates unique-looking ids', () => {
    const a = newOrderId()
    const b = newOrderId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^ord_/)
  })
})

describe('recordOrder', () => {
  it('writes the full entry under a mercury_order: key, separate from other keyspaces', async () => {
    const { kv, ns } = freshKv()
    const env = { MPP_STORE: ns } as unknown as Env
    const entry = {
      order_id: 'ord_test123',
      ts: '2026-08-12T00:00:00.000Z',
      route_id: 'mercury_events_by_ledger',
      payer: 'GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB',
      amount_usd: '0.0005',
      settlement_ref: 'deadbeef',
      request_path: '/rest/events/by-ledger?from=100&to=200',
      upstream_status: 200,
      latency_ms: 123,
      refund_status: 'none' as const,
    }
    await recordOrder(env, entry)

    const stored = kv.get('mercury_order:ord_test123')
    expect(stored).toBeTruthy()
    expect(JSON.parse(stored!)).toEqual(entry)
    // Never a raw key that could collide with ops-event tables (rate
    // limit counters, uptime probes) or idempotency cache entries.
    expect([...kv.keys()]).not.toContain('idempotency:ord_test123')
  })

  it('does NOT store a response body — only the metadata fields on OrderLedgerEntry', async () => {
    const { kv, ns } = freshKv()
    const env = { MPP_STORE: ns } as unknown as Env
    await recordOrder(env, {
      order_id: 'ord_nobody',
      ts: '2026-08-12T00:00:00.000Z',
      route_id: 'mercury_events_by_ledger',
      payer: null,
      amount_usd: '0.0005',
      settlement_ref: null,
      request_path: '/rest/events/by-ledger',
      upstream_status: 200,
      latency_ms: 10,
      refund_status: 'none',
    })
    const stored = JSON.parse(kv.get('mercury_order:ord_nobody')!)
    expect(Object.keys(stored).sort()).toEqual(
      [
        'order_id', 'ts', 'route_id', 'payer', 'amount_usd', 'settlement_ref',
        'request_path', 'upstream_status', 'latency_ms', 'refund_status',
      ].sort(),
    )
  })

  it('swallows a KV write failure instead of throwing (must never turn into a 500 for an already-served call)', async () => {
    const env = {
      MPP_STORE: {
        put: async () => { throw new Error('KV unavailable') },
      },
    } as unknown as Env
    await expect(recordOrder(env, {
      order_id: 'ord_fail',
      ts: '2026-08-12T00:00:00.000Z',
      route_id: 'mercury_events_by_ledger',
      payer: null,
      amount_usd: '0.0005',
      settlement_ref: null,
      request_path: '/rest/events/by-ledger',
      upstream_status: 200,
      latency_ms: 5,
      refund_status: 'none',
    })).resolves.toBe(false)
  })
})
