/**
 * The one place that decides which Stellar RPC this Worker talks to, and the
 * containment for the API key that a keyed RPC URL carries in its path.
 *
 * `STELLAR_RPC_URL_PRIMARY` is a secret holding a keyed URL. It replaces the
 * public `STELLAR_RPC_URL` when set. There is no fallback at request time: a
 * third-party public node could report a false SUCCESS, which would be recorded
 * as settled, so a request only ever trusts the single chosen provider.
 *
 * With no secret set, nothing here changes behaviour: the public URL is returned
 * and the console and response guards pass everything through untouched.
 */

const REDACTED = '[REDACTED:rpc-url]'
const REDACTED_KEY = '[REDACTED:rpc-key]'
/** Shorter path and query parts are ordinary words such as `v2`. */
const MIN_KEY_CHARS = 16
/** Caught even before the secret is registered in this isolate. */
const ALCHEMY_URL = /\bhttps?:\/\/[^\s"'<>\\]*\.alchemy\.com\/[^\s"'<>\\]*/gi

let secretUrl: string | undefined
let secretParts: string[] = []

function remember(url: string): void {
  if (url === secretUrl) return
  secretUrl = url
  secretParts = []
  try {
    const parsed = new URL(url)
    const parts = [...parsed.pathname.split('/'), ...parsed.searchParams.values()]
    secretParts = parts.filter((part) => part.length >= MIN_KEY_CHARS)
  } catch {
    // Not a URL: the whole value is still scrubbed below.
  }
}

/** Test seam: isolates are long-lived, so module state must be clearable. */
export function forgetStellarRpcSecret(): void {
  secretUrl = undefined
  secretParts = []
}

export function stellarRpcUrl<T extends { STELLAR_RPC_URL: string; STELLAR_RPC_URL_PRIMARY?: string }>(env: T): string {
  const primary = env.STELLAR_RPC_URL_PRIMARY?.trim()
  if (!primary) return env.STELLAR_RPC_URL
  remember(primary)
  return primary
}

export function scrubRpcSecret(text: string): string {
  let out = text.replace(ALCHEMY_URL, REDACTED)
  if (secretUrl) out = out.split(secretUrl).join(REDACTED)
  for (const part of secretParts) out = out.split(part).join(REDACTED_KEY)
  return out
}

function stringifyForScan(value: object): string | undefined {
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[circular]'
        seen.add(v)
      }
      return v
    })
  } catch {
    return undefined
  }
}

/**
 * SDK errors carry the request config, URL included, in enumerable properties.
 * Anything holding the secret is logged as scrubbed text, losing only structure.
 */
export function safeLogArg(arg: unknown): unknown {
  if (typeof arg === 'string') return scrubRpcSecret(arg)
  if (typeof arg !== 'object' || arg === null) return arg
  const scanned = stringifyForScan(arg)
  if (scanned === undefined) return '[unserializable log value]'
  const isError = arg instanceof Error
  const text = isError ? `${arg.name}: ${arg.message}\n${arg.stack ?? ''}\n${scanned}` : scanned
  const clean = scrubRpcSecret(text)
  return clean === text ? arg : clean
}

const CONSOLE_METHODS = ['debug', 'error', 'info', 'log', 'warn'] as const
for (const method of CONSOLE_METHODS) {
  const original = console[method].bind(console)
  console[method] = (...args: unknown[]) => {
    original(...(secretUrl ? args.map(safeLogArg) : args))
  }
}

const TEXTUAL_BODY = /^\s*(application\/([\w.+-]*json|xml)|application\/problem|text\/(?!event-stream))/i

/** The errors this guards are generated here and short; a passthrough may not be. */
const MAX_SCAN_BYTES = 256 * 1024
const MAX_SCAN_MS = 2_000

/** Undefined when the body cannot be read quickly and safely: send it unscanned. */
async function readBounded(response: Response): Promise<string | undefined> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    reader = response.clone().body?.getReader()
    if (!reader) return undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), MAX_SCAN_MS)
    })
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    for (;;) {
      const next = await Promise.race([reader.read(), deadline])
      if (next === 'timeout') {
        void reader.cancel().catch(() => undefined)
        return undefined
      }
      if (next.done) return text + decoder.decode()
      bytes += next.value.byteLength
      if (bytes > MAX_SCAN_BYTES) {
        void reader.cancel().catch(() => undefined)
        return undefined
      }
      text += decoder.decode(next.value, { stream: true })
    }
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Last line of defence for error responses: libraries put RPC error text in the
 * 4xx/5xx bodies they generate. Successful responses are not read, because they
 * can be large or streamed; RPC errors reach them only through the settlement
 * fields, which are scrubbed where the settlement result is built.
 */
export async function scrubErrorResponse(response: Response): Promise<Response> {
  if (!secretUrl || response.status < 400) return response

  const headers = new Headers(response.headers)
  let changed = false
  for (const [name, value] of response.headers) {
    const clean = scrubRpcSecret(value)
    if (clean !== value) {
      headers.set(name, clean)
      changed = true
    }
  }

  let body: string | undefined
  if (response.body && TEXTUAL_BODY.test(response.headers.get('content-type') ?? '')) {
    const text = await readBounded(response)
    const clean = text === undefined ? undefined : scrubRpcSecret(text)
    if (clean !== undefined && clean !== text) {
      body = clean
      headers.delete('content-length')
      changed = true
    }
  }
  if (!changed) return response
  return new Response(body ?? response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
