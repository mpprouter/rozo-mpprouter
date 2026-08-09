/**
 * In-process mock for `AtomicStoreDO` + `DurableObjectNamespace`.
 *
 * Used in Vitest tests to provide a real, working implementation of
 * `ATOMIC_STORE` without needing the Cloudflare runtime. The mock
 * implements the same /read + /commit HTTP API as the real DO but
 * runs it directly in memory via `AtomicStoreDO` (the actual class).
 *
 * Why instantiate the real class rather than a stub?
 * This ensures tests exercise the exact same version-CAS logic that
 * runs in production. A stub that just returns ok=true would not catch
 * type errors or behavioral bugs in the commit handler.
 *
 * The only thing we mock is the `DurableObjectState` constructor
 * argument — we provide an in-memory `DurableObjectStorage` whose
 * get/put/delete/transaction behave the same as the real CF storage
 * (modulo actual durability, which is irrelevant for unit tests).
 */

import { AtomicStoreDO } from '../../src/mpp/atomic-store-do'

// ---------------------------------------------------------------------------
// In-memory DurableObjectStorage implementation for tests
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory `DurableObjectStorage` that supports the operations
 * used by `AtomicStoreDO`: get, put, delete, and transaction.
 *
 * `transaction()` is synchronous-over-async via a promise chain — adequate
 * for tests where we control concurrency. The real CF runtime serialises
 * requests at the DO boundary; in tests we're single-threaded anyway.
 */
class InMemoryStorage {
  private readonly store = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined>
  async get<T>(keys: string[]): Promise<Map<string, T>>
  async get<T>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      const result = new Map<string, T>()
      for (const k of keyOrKeys) {
        const v = this.store.get(k)
        if (v !== undefined) result.set(k, v as T)
      }
      return result
    }
    return this.store.get(keyOrKeys) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void>
  async put<T>(entries: Record<string, T>): Promise<void>
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.store.set(keyOrEntries, value)
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) {
        this.store.set(k, v)
      }
    }
  }

  async delete(key: string): Promise<boolean>
  async delete(keys: string[]): Promise<number>
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let count = 0
      for (const k of keyOrKeys) if (this.store.delete(k)) count++
      return count
    }
    return this.store.delete(keyOrKeys)
  }

  /**
   * In tests, `transaction()` runs the closure directly on the backing store
   * with a `rollback()` that clears a dirty set. Full serialisation is
   * guaranteed by the JS event loop in tests (no true concurrent requests).
   */
  async transaction<T>(
    closure: (txn: DurableObjectTransaction) => Promise<T>,
  ): Promise<T> {
    // Track writes made during the transaction so rollback() can undo them.
    const written = new Map<string, { prev: unknown; existed: boolean }>()
    let rolledBack = false

    const txn: DurableObjectTransaction = {
      get: this.get.bind(this) as DurableObjectTransaction['get'],
      put: async <V>(keyOrEntries: string | Record<string, V>, value?: V): Promise<void> => {
        if (typeof keyOrEntries === 'string') {
          if (!written.has(keyOrEntries)) {
            written.set(keyOrEntries, {
              prev: this.store.get(keyOrEntries),
              existed: this.store.has(keyOrEntries),
            })
          }
          this.store.set(keyOrEntries, value)
        } else {
          for (const [k, v] of Object.entries(keyOrEntries)) {
            if (!written.has(k)) {
              written.set(k, { prev: this.store.get(k), existed: this.store.has(k) })
            }
            this.store.set(k, v)
          }
        }
      },
      delete: async (keyOrKeys: string | string[]): Promise<boolean | number> => {
        if (Array.isArray(keyOrKeys)) {
          let count = 0
          for (const k of keyOrKeys) {
            if (!written.has(k)) {
              written.set(k, { prev: this.store.get(k), existed: this.store.has(k) })
            }
            if (this.store.delete(k)) count++
          }
          return count
        }
        if (!written.has(keyOrKeys)) {
          written.set(keyOrKeys, { prev: this.store.get(keyOrKeys), existed: this.store.has(keyOrKeys) })
        }
        return this.store.delete(keyOrKeys)
      },
      rollback: () => {
        rolledBack = true
        // Undo all writes made during this transaction.
        for (const [k, { prev, existed }] of written) {
          if (existed) {
            this.store.set(k, prev)
          } else {
            this.store.delete(k)
          }
        }
      },
      list: async () => new Map(),
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    } as unknown as DurableObjectTransaction

    const result = await closure(txn)
    if (rolledBack) {
      // Undo: already handled inside rollback()
    }
    return result
  }

  async deleteAll(): Promise<void> {
    this.store.clear()
  }

  // Unused stubs required by the type
  async list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>> {
    const out = new Map<string, T>()
    for (const [key, value] of this.store) {
      if (options?.prefix && !key.startsWith(options.prefix)) continue
      out.set(key, value as T)
      if (out.size >= (options?.limit ?? Number.POSITIVE_INFINITY)) break
    }
    return out
  }
  async getAlarm(): Promise<null> { return null }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
  async sync(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// In-memory DurableObjectNamespace mock
// ---------------------------------------------------------------------------

/**
 * Build a `DurableObjectNamespace` mock that routes `stub.fetch()` calls
 * to an in-process `AtomicStoreDO` instance backed by `InMemoryStorage`.
 *
 * One instance is shared across the lifetime of a test (same as one named
 * DO `"mppx"` shared across requests in production).
 *
 * Usage in a test's makeEnv():
 *
 *   import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
 *   ...
 *   ATOMIC_STORE: makeAtomicStoreMock(),
 */
export function makeAtomicStoreMock(): DurableObjectNamespace {
  const storage = new InMemoryStorage()
  const doState = {
    storage,
    id: { toString: () => 'mock-do-id', equals: () => true, name: 'mppx' },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    waitUntil: (_p: Promise<unknown>) => {},
  } as unknown as DurableObjectState

  // Instantiate the real DO class — this is what runs in production.
  const doInstance = new AtomicStoreDO(doState)

  // Stable mock ID.
  const mockId: DurableObjectId = {
    toString: () => 'mock-do-id',
    equals: (other) => other.toString() === 'mock-do-id',
    name: 'mppx',
  }

  // Stub that routes fetch() to the DO instance.
  const stub: DurableObjectStub = {
    id: mockId,
    fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input, init)
      return doInstance.fetch(req)
    },
  } as unknown as DurableObjectStub

  const ns: DurableObjectNamespace = {
    idFromName: (_name: string) => mockId,
    idFromString: (_id: string) => mockId,
    newUniqueId: () => mockId,
    get: (_id: DurableObjectId) => stub,
    jurisdiction: (_j: string) => ns,
  } as unknown as DurableObjectNamespace

  return ns
}
