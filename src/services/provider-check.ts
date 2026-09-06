import type { ProviderCheck } from './provider-registry'
import { parseProviderChallenge } from './provider-verification'
import { validateApiBaseUrl } from './provider-registry'

const LABELS: Record<ProviderCheck['key'], ProviderCheck['label']> = {
  website_reachable: 'Website reachable', service_discovered: 'Service discovered',
  payment_configured: 'Payment configured', ownership_confirmed: 'Ownership confirmed', paid_call_works: 'Paid call works',
}

function check(key: ProviderCheck['key'], status: ProviderCheck['status'], detail: string): ProviderCheck {
  return { key, label: LABELS[key], status, detail, checkedAt: new Date().toISOString() }
}


/**
 * Workers has no `redirect: 'error'`.
 *
 * The runtime accepts only 'follow' or 'manual', and rejects the whole fetch
 * otherwise — which is why every provider probe returned 422 in production
 * while passing in tests, where undici does implement it. 'manual' preserves
 * the intent (we must not follow a redirect off the origin we are vouching
 * for) but returns the 3xx instead of throwing, so callers have to reject it
 * explicitly. That is what this exists for.
 */
export function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400
}

export async function readBoundedText(response: Response, maxBytes = 65_536): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new Error('response is too large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error('response is too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

export async function inspectProviderUrl(rawUrl: string) {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('url must be a public HTTPS URL without credentials')
  validateApiBaseUrl(url.origin)
  const response = await fetch(url.toString(), {
    method: 'GET', redirect: 'manual', headers: { Accept: 'application/json', 'User-Agent': 'mpprouter-check/1' }, signal: AbortSignal.timeout(10_000),
  })
  // A redirect would take us off the origin whose ownership we are about to
  // vouch for, so it is a failure rather than a hop to follow.
  if (isRedirect(response)) {
    throw new Error(`submitted URL redirects (HTTP ${response.status}); submit the final HTTPS URL directly`)
  }
  const website = check('website_reachable', 'passed', `Host responded over HTTPS with HTTP ${response.status}.`)
  const text = await readBoundedText(response)
  const challenge = parseProviderChallenge(response.status, response.headers, text)
  let routeUrl = url.toString()
  let method: 'GET' | 'POST' = 'GET'
  let accepts = challenge?.accepts ?? []
  if (!challenge) {
    try {
      let manifest: { resources?: Array<Record<string, unknown>> }
      try {
        manifest = JSON.parse(text) as { resources?: Array<Record<string, unknown>> }
      } catch {
        const manifestResponse = await fetch(`${url.origin}/.well-known/x402`, {
          headers: { Accept: 'application/json', 'User-Agent': 'mpprouter-check/1' },
          redirect: 'manual', signal: AbortSignal.timeout(10_000),
        })
        if (isRedirect(manifestResponse)) throw new Error('well-known manifest redirects; serve it on the submitted origin')
        if (!manifestResponse.ok) throw new Error('well-known manifest unavailable')
        manifest = JSON.parse(await readBoundedText(manifestResponse)) as { resources?: Array<Record<string, unknown>> }
      }
      const resource = manifest.resources?.find(item => typeof (item.url ?? item.resource) === 'string')
      if (resource) {
        const candidate = new URL(String(resource.url ?? resource.resource), url.origin)
        validateApiBaseUrl(candidate.origin)
        if (candidate.origin !== url.origin) {
          throw new Error('manifest resources must use the submitted HTTPS origin')
        }
        routeUrl = candidate.toString()
        method = String(resource.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
        const probe = await fetch(routeUrl, { method, redirect: 'manual', ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(10_000) })
        if (isRedirect(probe)) throw new Error('route probe redirects; serve the route on the submitted origin')
        const probeText = await readBoundedText(probe)
        accepts = parseProviderChallenge(probe.status, probe.headers, probeText)?.accepts ?? []
      }
    } catch { /* A live 402 is the fallback discovery format. */ }
  }
  const discovered = accepts.length > 0
  const first = accepts[0]
  const route = new URL(routeUrl)
  const priceUsd = first ? (Number(first.amount) / 10 ** first.decimals).toFixed(first.decimals).replace(/0+$/, '').replace(/\.$/, '') : undefined
  return {
    checks: [
      website,
      check('service_discovered', discovered ? 'passed' : 'failed', discovered ? 'At least one live paid route was discovered.' : 'No usable route was found in a manifest or live 402.'),
      check('payment_configured', discovered ? 'passed' : 'failed', discovered ? 'The live challenge includes network, asset, price and payTo.' : 'A valid live payment challenge is required.'),
      check('ownership_confirmed', 'pending', 'Domain control and settlement-wallet control must both pass.'),
      check('paid_call_works', 'pending', 'A real minimal paid call has not run yet.'),
    ],
    draft: discovered ? {
      api_base_url: `${route.protocol}//${route.host}`,
      payouts: accepts.map(item => ({ network: item.network, asset: item.asset ?? 'USDC', pay_to: item.payTo })),
      routes: [{ operation: route.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'service', method, upstream_path: route.pathname, price_usd: priceUsd }],
    } : null,
  }
}
