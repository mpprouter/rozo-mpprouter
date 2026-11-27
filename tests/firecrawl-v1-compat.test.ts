import { describe, it, expect } from 'vitest'
import {
  isFirecrawlCompatRoute,
  translateFirecrawlRequest,
  translateFirecrawlResponse,
} from '../src/routes/firecrawl-v1-compat'
import { getRouteByPublicPath } from '../src/services/merchants'

const req = (id: string, body: unknown) =>
  JSON.parse(translateFirecrawlRequest(id, JSON.stringify(body))!)
const res = (id: string, body: unknown) =>
  JSON.parse(translateFirecrawlResponse(id, JSON.stringify(body)))

describe('route ids', () => {
  it('matches the catalog route ids for every firecrawl public path', () => {
    for (const p of ['scrape', 'crawl', 'map', 'search', 'extract']) {
      const route = getRouteByPublicPath(`/v1/services/firecrawl/${p}`, 'POST')
      expect(route?.id).toBe(`firecrawl_${p}`)
      expect(route?.upstreamPath).toBe(`/v2/${p}`)
      expect(isFirecrawlCompatRoute(route!.id)).toBe(true)
    }
    expect(isFirecrawlCompatRoute('exa_search')).toBe(false)
  })
})

describe('scrape request', () => {
  it('maps jsonOptions + json format to a v2 json format object, merging systemPrompt', () => {
    const out = req('firecrawl_scrape', {
      url: 'https://example.com',
      formats: ['markdown', 'json'],
      jsonOptions: { systemPrompt: 'Be terse.', prompt: 'Get title', schema: { type: 'object' } },
    })
    expect(out).toEqual({
      url: 'https://example.com',
      formats: ['markdown', { type: 'json', prompt: 'Be terse.\n\nGet title', schema: { type: 'object' } }],
    })
  })

  it('maps extract format, screenshot@fullPage, changeTracking, parsePDF, geolocation', () => {
    const out = req('firecrawl_scrape', {
      url: 'https://example.com',
      formats: ['extract', 'screenshot@fullPage', 'markdown', 'changeTracking'],
      extract: { prompt: 'p' },
      changeTrackingOptions: { modes: ['git-diff'], tag: 't' },
      parsePDF: false,
      geolocation: { country: 'US' },
      __experimental_cache: true,
    })
    expect(out).toEqual({
      url: 'https://example.com',
      formats: [
        { type: 'json', prompt: 'p' },
        { type: 'screenshot', fullPage: true },
        'markdown',
        { type: 'changeTracking', modes: ['git-diff'], tag: 't' },
      ],
      parsers: [],
      location: { country: 'US' },
      proxy: 'basic',
    })
  })

  it('drops parsePDF:true (v2 default) and passes v2 bodies unchanged', () => {
    expect(req('firecrawl_scrape', { url: 'u', parsePDF: true })).toEqual({ url: 'u' })
    const v2 = { url: 'u', formats: [{ type: 'json', prompt: 'x' }], location: { country: 'DE' } }
    expect(req('firecrawl_scrape', v2)).toEqual(v2)
  })

  it('leaves non-JSON and undefined bodies untouched', () => {
    expect(translateFirecrawlRequest('firecrawl_scrape', 'not json')).toBe('not json')
    expect(translateFirecrawlRequest('firecrawl_scrape', undefined)).toBeUndefined()
    expect(translateFirecrawlRequest('exa_search', '{"parsePDF":false}')).toBe('{"parsePDF":false}')
  })
})

describe('crawl request', () => {
  it('maps allowBackwardLinks, ignoreSitemap, maxDepth, scrapeOptions', () => {
    const out = req('firecrawl_crawl', {
      url: 'https://example.com',
      allowBackwardLinks: true,
      ignoreSitemap: true,
      maxDepth: 2,
      limit: 10,
      scrapeOptions: { formats: ['screenshot@fullPage'] },
    })
    expect(out).toEqual({
      url: 'https://example.com',
      crawlEntireDomain: true,
      sitemap: 'skip',
      limit: 10,
      includePaths: ['^(/+[^/]+){0,2}/*$', '^(/+[^/]+){0,2}/+index\\.(html|php)/*$'],
      regexOnFullURL: false,
      scrapeOptions: { formats: [{ type: 'screenshot', fullPage: true }] },
    })
  })

  it('uses excludePaths for maxDepth when includePaths exists', () => {
    const out = req('firecrawl_crawl', { url: 'u', maxDepth: 1, includePaths: ['^/blog'] })
    expect(out.includePaths).toEqual(['^/blog'])
    expect(out.excludePaths).toEqual(['^(/+[^/]+){2}'])
    expect(out.maxDepth).toBeUndefined()
  })
})

describe('map', () => {
  it('request: sitemapOnly -> sitemap only, drops maxDepth/allowBackwardLinks', () => {
    expect(
      req('firecrawl_map', { url: 'u', sitemapOnly: true, maxDepth: 3, allowBackwardLinks: true }),
    ).toEqual({ url: 'u', sitemap: 'only' })
    expect(req('firecrawl_map', { url: 'u', ignoreSitemap: true })).toEqual({ url: 'u', sitemap: 'skip' })
  })

  it('response: v2 link objects -> v1 string array', () => {
    const v2 = {
      success: true,
      links: [
        { url: 'https://firecrawl.dev', title: 'Firecrawl', description: 'x' },
        { url: 'https://firecrawl.dev/pricing' },
      ],
    }
    expect(res('firecrawl_map', v2)).toEqual({
      success: true,
      links: ['https://firecrawl.dev', 'https://firecrawl.dev/pricing'],
    })
  })
})

describe('search', () => {
  it('request: defaults limit to v1 default 5, keeps explicit limit', () => {
    expect(req('firecrawl_search', { query: 'q' })).toEqual({ query: 'q', limit: 5 })
    expect(req('firecrawl_search', { query: 'q', limit: 2 }).limit).toBe(2)
  })

  it('response: data.web -> data, other sources kept at top level', () => {
    const v2 = {
      success: true,
      data: {
        web: [{ url: 'https://a', title: 'A', description: 'd', position: 1 }],
        news: [{ title: 'N', url: 'https://n' }],
      },
      creditsUsed: 2,
    }
    expect(res('firecrawl_search', v2)).toEqual({
      success: true,
      data: [{ url: 'https://a', title: 'A', description: 'd', position: 1 }],
      news: [{ title: 'N', url: 'https://n' }],
      creditsUsed: 2,
    })
  })

  it('response: v1-shaped array data passes unchanged', () => {
    const body = JSON.stringify({ success: true, data: [{ url: 'x' }] })
    expect(translateFirecrawlResponse('firecrawl_search', body)).toBe(body)
  })
})

describe('scrape response', () => {
  it('mirrors data.json to data.extract for v1 extract readers', () => {
    const v2 = { success: true, data: { markdown: '# Hi', json: { title: 'Hi' }, metadata: { statusCode: 200 } } }
    expect(res('firecrawl_scrape', v2).data.extract).toEqual({ title: 'Hi' })
  })

  it('returns plain scrape bodies byte-for-byte', () => {
    const body = JSON.stringify({ success: true, data: { markdown: '# Hi' } })
    expect(translateFirecrawlResponse('firecrawl_scrape', body)).toBe(body)
  })
})

describe('extract', () => {
  it('is passed through both ways', () => {
    const body = JSON.stringify({ urls: ['u'], prompt: 'p' })
    expect(translateFirecrawlRequest('firecrawl_extract', body)).toBe(body)
    const r = JSON.stringify({ success: true, id: 'job' })
    expect(translateFirecrawlResponse('firecrawl_extract', r)).toBe(r)
  })
})
