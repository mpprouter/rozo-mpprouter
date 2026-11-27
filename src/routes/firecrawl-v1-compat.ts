/**
 * Firecrawl v1 compatibility layer.
 *
 * Tempo's Firecrawl merchant moved from /v1/* to /v2/* on 2026-11-27 (the
 * /v1 paths now return 404; see PR #363). Our public paths stay
 * `/v1/services/firecrawl/{scrape,crawl,map,search,extract}`, so the public
 * contract is the Firecrawl v1 request and response shape. This module keeps
 * v1 clients working:
 *
 *   - `translateFirecrawlRequest` rewrites a v1 request body into its v2
 *     equivalent before it is sent upstream.
 *   - `translateFirecrawlResponse` reshapes a delivered v2 body back into the
 *     v1 shape. The proxy calls it only for a successful (kind 'ok', HTTP
 *     200, non-async) delivery, after payment and charge logic have run.
 *
 * Source of truth: https://docs.firecrawl.dev/migrate-to-v2 (REST mapping).
 * Bodies already in v2 shape pass through the request translator unchanged
 * (except the v1 default search limit of 5, which the v1 contract implies).
 * Anything that is not a JSON object is returned byte-for-byte.
 *
 * /v1/extract is outside Firecrawl's v1 -> v2 migration; its request and
 * async job response are left untouched.
 */

type Json = Record<string, unknown>

const FIRECRAWL_ROUTES = new Set([
  'firecrawl_scrape',
  'firecrawl_crawl',
  'firecrawl_map',
  'firecrawl_search',
  'firecrawl_extract',
])

export function isFirecrawlCompatRoute(routeId: string): boolean {
  return FIRECRAWL_ROUTES.has(routeId)
}

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function parseObject(body: string): Json | null {
  try {
    const parsed = JSON.parse(body)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function mergeSystemPrompt(opts: Json): string | undefined {
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : undefined
  const system = typeof opts.systemPrompt === 'string' ? opts.systemPrompt : undefined
  if (system && prompt) return `${system}\n\n${prompt}`
  return system ?? prompt
}

function jsonFormat(opts: unknown): Json {
  const out: Json = { type: 'json' }
  if (isObject(opts)) {
    const prompt = mergeSystemPrompt(opts)
    if (prompt !== undefined) out.prompt = prompt
    if (opts.schema !== undefined) out.schema = opts.schema
  }
  return out
}

/**
 * Translate v1 scrape options (top-level scrape body, crawl/search
 * `scrapeOptions`). Mutates and returns `opts`.
 */
function translateScrapeOptions(opts: Json): Json {
  if (Array.isArray(opts.formats)) {
    const formats: unknown[] = []
    let hasJson = false
    for (const f of opts.formats) {
      if (f === 'extract' || f === 'json') {
        if (hasJson) continue
        hasJson = true
        formats.push(jsonFormat(f === 'extract' ? (opts.extract ?? opts.jsonOptions) : (opts.jsonOptions ?? opts.extract)))
      } else if (f === 'screenshot@fullPage') {
        formats.push({ type: 'screenshot', fullPage: true })
      } else if (f === 'changeTracking') {
        const ct: Json = { type: 'changeTracking' }
        if (isObject(opts.changeTrackingOptions)) {
          for (const k of ['modes', 'schema', 'prompt', 'tag']) {
            if (opts.changeTrackingOptions[k] !== undefined) ct[k] = opts.changeTrackingOptions[k]
          }
        }
        formats.push(ct)
      } else {
        formats.push(f)
      }
    }
    opts.formats = formats
  }
  delete opts.extract
  delete opts.jsonOptions
  delete opts.changeTrackingOptions

  if (opts.parsePDF === false) {
    if (opts.parsers === undefined) opts.parsers = []
  }
  delete opts.parsePDF

  if (opts.geolocation !== undefined) {
    if (opts.location === undefined) opts.location = opts.geolocation
    delete opts.geolocation
    // v2 changed the default proxy to "auto" when location.country is set.
    if (isObject(opts.location) && opts.location.country !== undefined && opts.proxy === undefined) {
      opts.proxy = 'basic'
    }
  }
  delete opts.__experimental_cache
  return opts
}

function translateCrawl(body: Json): Json {
  if (body.allowBackwardLinks !== undefined) {
    if (body.crawlEntireDomain === undefined) body.crawlEntireDomain = body.allowBackwardLinks
    delete body.allowBackwardLinks
  }
  if (body.ignoreSitemap !== undefined) {
    if (body.ignoreSitemap === true && body.sitemap === undefined) body.sitemap = 'skip'
    delete body.ignoreSitemap
  }
  if (typeof body.maxDepth === 'number' && Number.isInteger(body.maxDepth) && body.maxDepth >= 0) {
    const n = body.maxDepth
    if (Array.isArray(body.includePaths) && body.includePaths.length > 0) {
      const exclude = Array.isArray(body.excludePaths) ? [...body.excludePaths] : []
      exclude.push(`^(/+[^/]+){${n + 1}}`)
      body.excludePaths = exclude
    } else {
      body.includePaths = [`^(/+[^/]+){0,${n}}/*$`, `^(/+[^/]+){0,${n}}/+index\\.(html|php)/*$`]
    }
    body.regexOnFullURL = false
  }
  delete body.maxDepth
  if (isObject(body.scrapeOptions)) translateScrapeOptions(body.scrapeOptions)
  return body
}

function translateMap(body: Json): Json {
  if (body.sitemapOnly === true && body.sitemap === undefined) body.sitemap = 'only'
  if (body.ignoreSitemap === true && body.sitemap === undefined) body.sitemap = 'skip'
  delete body.sitemapOnly
  delete body.ignoreSitemap
  delete body.maxDepth
  delete body.allowBackwardLinks
  return body
}

function translateSearch(body: Json): Json {
  // v1 default limit was 5; v2 defaults to 10.
  if (body.limit === undefined) body.limit = 5
  if (isObject(body.scrapeOptions)) translateScrapeOptions(body.scrapeOptions)
  return body
}

/** Rewrite a v1 request body into v2. Non-JSON / non-object bodies pass through. */
export function translateFirecrawlRequest(routeId: string, body: string | undefined): string | undefined {
  if (body === undefined || !isFirecrawlCompatRoute(routeId)) return body
  const parsed = parseObject(body)
  if (!parsed) return body
  switch (routeId) {
    case 'firecrawl_scrape':
      return JSON.stringify(translateScrapeOptions(parsed))
    case 'firecrawl_crawl':
      return JSON.stringify(translateCrawl(parsed))
    case 'firecrawl_map':
      return JSON.stringify(translateMap(parsed))
    case 'firecrawl_search':
      return JSON.stringify(translateSearch(parsed))
    default:
      return body // extract: not part of the v1 -> v2 migration
  }
}

/** Reshape a delivered v2 body into the v1 response shape. */
export function translateFirecrawlResponse(routeId: string, body: string): string {
  if (!isFirecrawlCompatRoute(routeId)) return body
  const parsed = parseObject(body)
  if (!parsed) return body

  if (routeId === 'firecrawl_map') {
    if (!Array.isArray(parsed.links)) return body
    parsed.links = parsed.links
      .map((l) => (typeof l === 'string' ? l : isObject(l) && typeof l.url === 'string' ? l.url : null))
      .filter((l): l is string => l !== null)
    return JSON.stringify(parsed)
  }

  if (routeId === 'firecrawl_search') {
    const data = parsed.data
    if (!isObject(data)) return body // already v1 (array) or unexpected
    const { web, ...rest } = data
    parsed.data = Array.isArray(web) ? web : []
    // Keep other v2 sources (news, images) at the top level rather than drop them.
    for (const [k, v] of Object.entries(rest)) {
      if (parsed[k] === undefined) parsed[k] = v
    }
    return JSON.stringify(parsed)
  }

  if (routeId === 'firecrawl_scrape') {
    // v1 clients that asked for the "extract" format read data.extract.
    const data = parsed.data
    if (isObject(data) && data.json !== undefined && data.extract === undefined) {
      data.extract = data.json
      return JSON.stringify(parsed)
    }
    return body
  }

  return body
}
