// Intents payment-api warm-up (latency trial "D", 2026-10-31 to 2026-11-07).
//
// Real checkout creates POST to the intents `payment-api` edge function about
// once every 9 minutes, so most of them land on a cold isolate and pay ~1.1 s
// of boot before the handler starts. This sends one OPTIONS a minute to the
// same function. payment-api answers OPTIONS after ensureRuntimeConfig() with
// its CORS response: no auth, no DB writes. No X-API-Key is sent.
//
// Why the supabase.co host and not ROZO_INTENTS_URL (intentapiv4.rozo.ai):
// that host is the intentapi-proxy Worker (rozo-intents-api
// cloudflare/intentapi-proxy/worker.js), which answers every OPTIONS itself
// with a 204 and never forwards it, so an OPTIONS there warms nothing
// (verified 2026-10-31: no sb-* headers on the reply). For every other method
// the proxy only swaps the hostname to this one and forwards from Cloudflare,
// so this request takes the last hop of the real create path.
//
// Trial only. Measure ct_upstream_ms - ctu_total_ms (PostHog) before/after;
// if the median does not drop, delete this file, its call in src/index.ts, the
// "* * * * *" cron in wrangler.toml and INTENTS_WARMUP.
//
// Kill switch: INTENTS_WARMUP = "off" (wrangler.toml [vars] or the dashboard).
// Anything else, including unset, keeps it on for the trial.

/** The cron expression that runs only the warm-up (see wrangler.toml). */
export const INTENTS_WARMUP_CRON = '* * * * *'
export const INTENTS_WARMUP_TIMEOUT_MS = 5_000
/** payment-api on the Supabase host the intentapiv4 proxy forwards to. */
export const INTENTS_WARMUP_URL = 'https://aozudqtlykbhzbuzalzz.supabase.co/functions/v1/payment-api/'

export function intentsWarmupEnabled(env: { INTENTS_WARMUP?: string }): boolean {
  return env.INTENTS_WARMUP?.trim().toLowerCase() !== 'off'
}

/**
 * One OPTIONS to payment-api. Never throws; logs one compact line. Returns the
 * outcome for tests.
 */
export async function warmIntentsPaymentApi(
  env: { INTENTS_WARMUP?: string },
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<{ status: number | 'off' | 'error'; ms: number }> {
  if (!intentsWarmupEnabled(env)) return { status: 'off', ms: 0 }
  const started = now()
  try {
    const resp = await fetchImpl(INTENTS_WARMUP_URL, {
      method: 'OPTIONS',
      signal: AbortSignal.timeout(INTENTS_WARMUP_TIMEOUT_MS),
    })
    // Drain so the connection is released; the body is a short CORS reply.
    await resp.body?.cancel().catch(() => undefined)
    const ms = now() - started
    // Supabase's own timing for the function (large = cold boot) and region:
    // the numbers the trial is judged on. Neither is sensitive.
    const upstream = numericHeader(resp.headers.get('x-envoy-upstream-service-time'))
    const region = resp.headers.get('x-sb-edge-region')?.replace(/[^a-z0-9-]/gi, '').slice(0, 32) || '-'
    console.log(`[intents-warmup] status=${resp.status} ms=${ms} upstream_ms=${upstream} region=${region}`)
    return { status: resp.status, ms }
  } catch (err) {
    const ms = now() - started
    const name = (err as Error)?.name ?? 'Error'
    console.warn(`[intents-warmup] status=error err=${name} ms=${ms}`)
    return { status: 'error', ms }
  }
}

function numericHeader(v: string | null): string {
  return v && /^\d{1,7}$/.test(v.trim()) ? v.trim() : '-'
}
