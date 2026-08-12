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

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value)
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
   * `transaction()` runs the closure against the live store and undoes its
   * writes on `rollback()`. The real runtime serialises requests at the DO
   * boundary; tests are single-threaded, so ordering is equivalent.
   */
  async transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    const written = new Map<string, { prev: unknown; existed: boolean }>()
    const remember = (k: string) => {
      if (!written.has(k)) {
        written.set(k, { prev: this.store.get(k), existed: this.store.has(k) })
      }
    }
    const txn = {
      get: <V>(key: string) => Promise.resolve(this.store.get(key) as V | undefined),
      put: async <V>(key: string, value: V) => {
        remember(key)
        this.store.set(key, value)
      },
      delete: async (key: string) => {
        remember(key)
        return this.store.delete(key)
      },
      list: async () => new Map(),
      rollback: () => {
        for (const [k, { prev, existed }] of written) {
          if (existed) this.store.set(k, prev)
          else this.store.delete(k)
        }
      },
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    } as unknown as DurableObjectTransaction

    return closure(txn)
  }

  async deleteAll(): Promise<void> {
    this.store.clear()
  }
  async getAlarm(): Promise<null> {
    return null
  }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
  async sync(): Promise<void> {}
}

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

  return ns
}
