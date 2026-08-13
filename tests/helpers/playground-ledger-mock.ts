/**
 * In-process mock for `PlaygroundLedger` + its `DurableObjectNamespace`.
 *
 * Same approach and rationale as `./atomic-store-mock.ts`: instantiate the
 * REAL Durable Object class over an in-memory `DurableObjectStorage`, rather
 * than stubbing its HTTP responses. A stub that returned `{ok:true}` would
 * pass every test in `playground-ledger.test.ts` while proving nothing about
 * the reserve/commit arithmetic those tests exist to lock in.
 *
 * The in-memory storage is a local copy rather than an import because
 * `atomic-store-mock.ts` does not export its `InMemoryStorage`, and widening
 * that file's public surface for a test helper in a different subsystem is a
 * worse trade than ~60 duplicated lines of test scaffolding.
 */

import { PlaygroundLedger } from '../../src/playground/ledger-do'

class InMemoryStorage {
  readonly store = new Map<string, unknown>()
  /**
   * Fault-injection hook for torn-write tests. When set, it is called before
   * each `put` with the keys about to be written; throwing simulates a storage
   * write failure at that point.
   */
  failPut: ((keys: string[]) => void) | null = null

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    // Faithful to the DO API: a multi-key object put is atomic (all-or-nothing).
    // We apply into a staging copy first so a mid-apply throw (the torn-write
    // simulation) leaves the store fully pre-transition, never half.
    if (typeof keyOrEntries === 'string') {
      this.failPut?.([keyOrEntries])
      this.store.set(keyOrEntries, value)
      return
    }
    this.failPut?.(Object.keys(keyOrEntries))
    const staged = new Map(this.store)
    for (const [k, v] of Object.entries(keyOrEntries)) staged.set(k, v)
    this.store.clear()
    for (const [k, v] of staged) this.store.set(k, v)
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key)
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>()
    for (const [key, value] of this.store) {
      if (options?.prefix && !key.startsWith(options.prefix)) continue
      out.set(key, value as T)
    }
    return out
  }

  /**
   * Faithful to the DO `transaction()` contract: all writes commit atomically
   * when the closure returns, and a THROW rolls back every write made inside
   * the transaction (serializable, all-or-nothing). The real runtime also
   * serialises requests at the DO boundary; tests are single-threaded, so
   * ordering is equivalent.
   *
   * The auto-rollback-on-throw is what makes the torn-write test meaningful: a
   * transition whose second write fails must leave the store fully
   * pre-transition, never half-applied.
   */
  async transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    const written = new Map<string, { prev: unknown; existed: boolean }>()
    const remember = (k: string) => {
      if (!written.has(k)) {
        written.set(k, { prev: this.store.get(k), existed: this.store.has(k) })
      }
    }
    const rollback = () => {
      for (const [k, { prev, existed }] of written) {
        if (existed) this.store.set(k, prev)
        else this.store.delete(k)
      }
    }
    const txn = {
      get: <V>(key: string) => Promise.resolve(this.store.get(key) as V | undefined),
      put: async <V>(keyOrEntries: string | Record<string, V>, value?: V) => {
        const keys = typeof keyOrEntries === 'string' ? [keyOrEntries] : Object.keys(keyOrEntries)
        // Record undo state BEFORE the fault hook so an in-transaction throw
        // still rolls back cleanly (matching CF auto-rollback).
        for (const k of keys) remember(k)
        this.failPut?.(keys)
        if (typeof keyOrEntries === 'string') {
          this.store.set(keyOrEntries, value)
        } else {
          for (const [k, v] of Object.entries(keyOrEntries)) this.store.set(k, v)
        }
      },
      delete: async (key: string) => {
        remember(key)
        return this.store.delete(key)
      },
      list: async () => new Map(),
      rollback,
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    } as unknown as DurableObjectTransaction

    try {
      return await closure(txn)
    } catch (e) {
      // CF DO transactions auto-roll-back on an uncaught throw.
      rollback()
      throw e
    }
  }

  async deleteAll(): Promise<void> {
    this.store.clear()
  }
  alarmAt: number | null = null
  async getAlarm(): Promise<number | null> {
    return this.alarmAt
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null
  }
  async sync(): Promise<void> {}
}

/**
 * Namespace mock that also exposes the live DO instance and its alarm clock,
 * so tests can drive the stale-call reaper deterministically instead of
 * waiting on wall time.
 */
export interface PlaygroundLedgerMock {
  namespace: DurableObjectNamespace
  /** Invoke the DO's alarm handler directly, as the runtime would. */
  runAlarm(): Promise<void>
  /** Currently scheduled alarm time, or null. */
  getAlarm(): number | null
  /**
   * Install a fault that throws on the next `put` touching any of `keys`
   * (single-shot). Used by torn-write tests to prove a transition either
   * fully applies or fully rolls back.
   */
  failNextPutTouching(keys: string[]): void
  /** Raw store snapshot, for asserting no half-applied state. */
  snapshot(): Map<string, unknown>
}

export function makePlaygroundLedgerMockWithControls(): PlaygroundLedgerMock {
  const ns = makePlaygroundLedgerMock()
  const control = CONTROLS.get(ns)!
  return {
    namespace: ns,
    runAlarm: () => control.instance.alarm(),
    getAlarm: () => control.alarm,
    failNextPutTouching: (keys: string[]) => {
      control.storage.failPut = (written: string[]) => {
        if (written.some(k => keys.includes(k))) {
          control.storage.failPut = null
          throw new Error(`simulated storage write failure on ${written.join(',')}`)
        }
      }
    },
    snapshot: () => new Map(control.storage.store),
  }
}

const CONTROLS = new WeakMap<
  DurableObjectNamespace,
  { instance: PlaygroundLedger; alarm: number | null; storage: InMemoryStorage }
>()

export function makePlaygroundLedgerMock(): DurableObjectNamespace {
  const storage = new InMemoryStorage()
  const state = {
    storage,
    id: { toString: () => 'playground', equals: () => true, name: 'playground' },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    waitUntil: () => {},
  } as unknown as DurableObjectState

  const instance = new PlaygroundLedger(state)

  const id: DurableObjectId = {
    toString: () => 'playground',
    equals: other => other.toString() === 'playground',
    name: 'playground',
  }

  const stub = {
    id,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init)
      return instance.fetch(req)
    },
  } as unknown as DurableObjectStub

  const ns = {
    idFromName: () => id,
    idFromString: () => id,
    newUniqueId: () => id,
    get: () => stub,
    jurisdiction: () => ns,
  } as unknown as DurableObjectNamespace

  CONTROLS.set(ns, {
    instance,
    storage,
    get alarm() {
      return storage.alarmAt
    },
  } as any)

  return ns
}
