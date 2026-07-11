// Durable-Object-backed atomic store for Stripe fulfillment (design §9 Layer 2).
//
// Cloudflare KV has NO server-side conditional write: a Worker-side
// read→check→write on KV is non-atomic, so two concurrent isolates can both
// read the same pre-transition state and both proceed — a double-sign on the
// settlement path, or a lost-update on the daily-spend counter that lets real
// spend exceed the configured daily cap.
//
// This project already ships a linearizable CAS Durable Object for exactly this
// class of problem (`AtomicStoreDO`, src/mpp/atomic-store-do.ts). We reuse it
// here via its `/read` + `/commit` versioned-CAS API to serialize:
//
//   - the "enter provider_paying" transition (at most one settlement in flight
//     per Stripe session — the double-sign guard),
//   - the create-time record seed (must never roll a live record back),
//   - the daily-spend ledger reserve/release (atomic, no lost update).
//
// We use a DEDICATED DO singleton named `stripe-fulfillment`, separate from the
// mppx `mppx` singleton, so Stripe fulfillment contention never serializes
// against mppx charge/channel traffic and vice-versa.
//
// The DO is the single source of truth for these keys. We deliberately do NOT
// also write them to KV: a KV+DO split would reintroduce the eventual-
// consistency divergence this module exists to remove.

import type { Env } from '../index'
import type { ReadResponse, CommitResponse } from '../mpp/atomic-store-do'

// CF routes DO stub.fetch() internally; the origin is a stable fake so
// `new Request(url)` is valid. No outbound network request is made.
const DO_ORIGIN = 'https://stripe-fulfillment.internal'
const DO_SINGLETON = 'stripe-fulfillment'

// After this many consecutive CAS conflicts we give up rather than loop. Under
// real contention a handful of retries always resolves; the bound is a safety
// net. Failing an operation is safer than looping forever or racing.
const MAX_CAS_RETRIES = 6

function stub(env: Env) {
  const ns = env.ATOMIC_STORE
  return ns.get(ns.idFromName(DO_SINGLETON))
}

async function doPost<T>(env: Env, path: string, payload: unknown): Promise<T> {
  const resp = await stub(env).fetch(
    new Request(`${DO_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`stripe-atomic ${path} failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  return resp.json() as Promise<T>
}

/** Read the raw value + version for a key from the DO. Absent ≡ { value: null, version: 0 }. */
export async function casRead(env: Env, key: string): Promise<{ value: string | null; version: number }> {
  const r = await doPost<ReadResponse>(env, '/read', { key })
  return { value: r.value, version: r.version }
}

/** Outcome of a casUpdate transform. `noop` commits nothing and returns `result`. */
export type CasChange<R> =
  | { op: 'set'; value: string; result: R }
  | { op: 'noop'; result: R }

/**
 * Linearizable read-modify-write against the DO. Reads the current value at its
 * version, runs `fn(current)`, and commits the new value ONLY if the version is
 * still unchanged (versioned CAS). On a conflict it re-reads and re-runs `fn`
 * (which MUST be side-effect-free and re-runnable) up to MAX_CAS_RETRIES.
 *
 * A `noop` change commits nothing — use it to bail without a write while still
 * returning a value (e.g. "already in flight, do nothing").
 */
export async function casUpdate<R>(
  env: Env,
  key: string,
  fn: (current: string | null) => CasChange<R>,
): Promise<R> {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const { value, version } = await casRead(env, key)
    const change = fn(value)
    if (change.op === 'noop') return change.result
    const commit = await doPost<CommitResponse>(env, '/commit', {
      key,
      expectedVersion: version,
      op: 'set',
      value: change.value,
    })
    if (commit.ok) return change.result
    // Conflict — another isolate won the write between our read and commit.
    // Loop: re-read the fresh value and re-run fn.
  }
  throw new Error(`stripe-atomic casUpdate exhausted ${MAX_CAS_RETRIES} retries for key ${key}`)
}
