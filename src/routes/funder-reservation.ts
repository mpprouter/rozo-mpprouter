// Shared funder-balance reservation for every invoice fulfillment path.
//
// Coinbase webhooks, Stripe Crypto fulfillments, and coupon redemptions all
// spend from the same funder wallet. A KV read-check-write cannot protect that
// shared balance: two isolates can both observe the same available funds and
// both proceed. This module puts the availability check AND reservation insert
// in one versioned CAS backed by the existing AtomicStoreDO.

import type { Env } from '../index'
import { casRead, casUpdate } from './stripe-atomic'

const RESERVATION_KEY = 'funder-reservations:v1'

// Reservations intentionally have no time-based expiry. A worker can lose its
// response while the provider still moves funds, so reclaiming a slot merely
// because a clock elapsed could over-commit the wallet. A failed release may
// defer later fulfillments until manual reconciliation, which is the required
// fail-safe direction for company funds.

interface ReservationEntry {
  amountAtomic: string
  createdAtMs: number
}

interface ReservationState {
  entries: Record<string, ReservationEntry>
}

export type FunderReservationResult =
  | {
      kind: 'acquired'
      reservedAtomic: bigint
      availableAtomic: bigint
    }
  | {
      kind: 'already_reserved'
      reservedAtomic: bigint
      availableAtomic: bigint
    }
  | {
      kind: 'insufficient'
      reservedAtomic: bigint
      availableAtomic: bigint
    }

function parseState(raw: string | null): ReservationState {
  if (raw === null) return { entries: {} }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('funder reservation state is invalid JSON')
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('entries' in parsed) ||
    !(parsed as { entries?: unknown }).entries ||
    typeof (parsed as { entries: unknown }).entries !== 'object' ||
    Array.isArray((parsed as { entries: unknown }).entries)
  ) {
    throw new Error('funder reservation state has an invalid shape')
  }

  const entries: Record<string, ReservationEntry> = {}
  for (const [id, value] of Object.entries(
    (parsed as { entries: Record<string, unknown> }).entries,
  )) {
    if (
      !id ||
      !value ||
      typeof value !== 'object' ||
      !('amountAtomic' in value) ||
      !('createdAtMs' in value)
    ) {
      throw new Error('funder reservation state contains an invalid entry')
    }
    const amountAtomic = (value as { amountAtomic: unknown }).amountAtomic
    const createdAtMs = (value as { createdAtMs: unknown }).createdAtMs
    if (
      typeof amountAtomic !== 'string' ||
      !/^\d+$/.test(amountAtomic) ||
      BigInt(amountAtomic) <= 0n ||
      typeof createdAtMs !== 'number' ||
      !Number.isFinite(createdAtMs)
    ) {
      throw new Error('funder reservation state contains an invalid entry')
    }
    entries[id] = { amountAtomic, createdAtMs }
  }
  return { entries }
}

function totalReserved(state: ReservationState): bigint {
  return Object.values(state.entries).reduce(
    (sum, entry) => sum + BigInt(entry.amountAtomic),
    0n,
  )
}

/**
 * Atomically checks `balance - all active reservations >= amount` and, only
 * when true, inserts this reservation. `already_reserved` means another
 * invocation already owns this id; callers must not make a second pay call.
 */
export async function tryReserveFunder(
  env: Env,
  args: {
    reservationId: string
    amountAtomic: bigint
    balanceAtomic: bigint
    nowMs?: number
  },
): Promise<FunderReservationResult> {
  if (!args.reservationId) throw new Error('reservationId is required')
  if (args.amountAtomic <= 0n) throw new Error('reservation amount must be positive')
  if (args.balanceAtomic < 0n) throw new Error('funder balance cannot be negative')
  const nowMs = args.nowMs ?? Date.now()

  return casUpdate<FunderReservationResult>(env, RESERVATION_KEY, (raw) => {
    const state = parseState(raw)
    const reservedAtomic = totalReserved(state)
    const availableAtomic = args.balanceAtomic - reservedAtomic
    const existing = state.entries[args.reservationId]

    if (existing) {
      if (BigInt(existing.amountAtomic) !== args.amountAtomic) {
        throw new Error('reservation id already exists with a different amount')
      }
      const result: FunderReservationResult = {
        kind: 'already_reserved',
        reservedAtomic,
        availableAtomic,
      }
      return { op: 'noop', result }
    }

    if (availableAtomic < args.amountAtomic) {
      const result: FunderReservationResult = {
        kind: 'insufficient',
        reservedAtomic,
        availableAtomic,
      }
      return { op: 'noop', result }
    }

    state.entries[args.reservationId] = {
      amountAtomic: args.amountAtomic.toString(),
      createdAtMs: nowMs,
    }
    return {
      op: 'set',
      value: JSON.stringify(state),
      result: {
        kind: 'acquired',
        reservedAtomic: reservedAtomic + args.amountAtomic,
        availableAtomic: availableAtomic - args.amountAtomic,
      },
    }
  })
}

/** Release one reservation. Missing ids are an idempotent no-op. */
export async function releaseFunderReservation(
  env: Env,
  reservationId: string,
): Promise<void> {
  await casUpdate<null>(env, RESERVATION_KEY, (raw) => {
    const state = parseState(raw)
    if (!(reservationId in state.entries)) return { op: 'noop', result: null }
    delete state.entries[reservationId]
    return { op: 'set', value: JSON.stringify(state), result: null }
  })
}

/** Read-only total, primarily for diagnostics and regression tests. */
export async function readFunderReservedAtomic(env: Env): Promise<bigint> {
  const { value } = await casRead(env, RESERVATION_KEY)
  const state = parseState(value)
  return totalReserved(state)
}
