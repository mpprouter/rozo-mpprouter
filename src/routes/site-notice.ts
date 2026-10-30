// Site notices: a dismissible banner on checkout.rozo.ai / upi.rozo.ai whose
// text lives here, not in the site bundle, so an operator can post or remove
// one without a frontend deploy (founder 2026-10-31, first use: OpenRouter's
// scheduled maintenance window).
//
//   GET  /v1/site-notice?site=checkout|upi
//        Public. Only notices whose window contains "now" and that list the
//        site. Cached 60 s at the edge; the page also hides a notice once its
//        ends_at passes, so a notice disappears on time without a write.
//   GET  /admin/site-notice            → the stored value, all notices
//   POST /admin/site-notice { action: "set", notices, actor, reason }
//   POST /admin/site-notice { action: "clear", actor, reason }
//        Auth: x-admin-secret = CHECKOUT_CONTROL_SECRET (the operator secret
//        that can stop/resume checkout; it still cannot pay anything).
//        Driven by ainative scripts/site_notice.py.
//
// Storage: one KV key. Eventual consistency (up to ~60 s) is fine for a banner.

import type { Env } from '../index'

export const SITE_NOTICE_PATH = '/v1/site-notice'
export const SITE_NOTICE_ADMIN_PATH = '/admin/site-notice'
export const SITE_NOTICE_KEY = 'site-notice:v1'

export const SITE_NOTICE_SITES = ['checkout', 'upi'] as const
type Site = (typeof SITE_NOTICE_SITES)[number]

const MAX_NOTICES = 5
const MAX_TEXT = 500
const MAX_LABEL = 60
const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/

export interface SiteNotice {
  id: string
  sites: Site[]
  level: 'info' | 'warning'
  starts_at: string
  ends_at: string
  /** Text per language; `en` is required and is the fallback. */
  message: Record<string, string>
  link_url: string | null
  link_label: Record<string, string> | null
}

interface StoredNotices {
  notices: SiteNotice[]
  updated_at: string
  actor: string
  reason: string
}

function json(status: number, payload: unknown, cache = 'no-store'): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  })
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function textMap(v: unknown, max: number): Record<string, string> | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'must be an object of language -> text'
  const out: Record<string, string> = {}
  for (const [lang, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!LANG_RE.test(lang)) return `bad language code ${JSON.stringify(lang)}`
    if (typeof raw !== 'string' || !raw.trim()) return `empty text for ${lang}`
    if (raw.trim().length > max) return `text for ${lang} is longer than ${max}`
    out[lang] = raw.trim()
  }
  if (!out.en) return 'en is required'
  return out
}

/** Validate one notice from the operator. Returns the clean notice or an error. */
export function validateNotice(raw: unknown): SiteNotice | string {
  if (!raw || typeof raw !== 'object') return 'notice must be an object'
  const n = raw as Record<string, unknown>
  const id = text(n.id, 64)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return 'id must be lowercase letters, digits and dashes'
  if (!Array.isArray(n.sites) || n.sites.length === 0) return `${id}: sites must be a non-empty list`
  const sites: Site[] = []
  for (const s of n.sites) {
    if (!SITE_NOTICE_SITES.includes(s as Site)) return `${id}: unknown site ${JSON.stringify(s)}`
    if (!sites.includes(s as Site)) sites.push(s as Site)
  }
  const level = n.level === undefined ? 'info' : n.level
  if (level !== 'info' && level !== 'warning') return `${id}: level must be info or warning`
  const starts = Date.parse(text(n.starts_at, 40))
  const ends = Date.parse(text(n.ends_at, 40))
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) return `${id}: starts_at and ends_at must be ISO timestamps`
  if (ends <= starts) return `${id}: ends_at must be after starts_at`
  const message = textMap(n.message, MAX_TEXT)
  if (typeof message === 'string') return `${id}: message ${message}`
  let linkUrl: string | null = null
  let linkLabel: Record<string, string> | null = null
  if (n.link_url !== undefined && n.link_url !== null) {
    const u = text(n.link_url, 300)
    let parsed: URL
    try {
      parsed = new URL(u)
    } catch {
      return `${id}: link_url is not a URL`
    }
    if (parsed.protocol !== 'https:') return `${id}: link_url must be https`
    linkUrl = parsed.toString()
    if (n.link_label !== undefined && n.link_label !== null) {
      const l = textMap(n.link_label, MAX_LABEL)
      if (typeof l === 'string') return `${id}: link_label ${l}`
      linkLabel = l
    }
  }
  return {
    id,
    sites,
    level,
    starts_at: new Date(starts).toISOString(),
    ends_at: new Date(ends).toISOString(),
    message,
    link_url: linkUrl,
    link_label: linkLabel,
  }
}

async function readStored(env: Env): Promise<StoredNotices | null> {
  const raw = await env.MPP_STORE.get(SITE_NOTICE_KEY)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as StoredNotices
    return Array.isArray(v?.notices) ? v : null
  } catch {
    return null
  }
}

/** Notices live at `now` for `site`. */
export function activeNotices(stored: StoredNotices | null, site: Site, now: number): SiteNotice[] {
  if (!stored) return []
  return stored.notices.filter(
    (n) => n.sites.includes(site) && Date.parse(n.starts_at) <= now && now < Date.parse(n.ends_at),
  )
}

export async function handleSiteNotice(request: Request, env: Env, now: () => number = Date.now): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' })
  const site = new URL(request.url).searchParams.get('site') ?? ''
  if (!SITE_NOTICE_SITES.includes(site as Site)) {
    return json(400, { error: `site must be one of ${SITE_NOTICE_SITES.join(', ')}` })
  }
  const t = now()
  let stored: StoredNotices | null = null
  try {
    stored = await readStored(env)
  } catch {
    // A banner is never worth an error page: answer "no notices", uncached.
    return json(200, { generated_at: new Date(t).toISOString(), notices: [] })
  }
  const notices = activeNotices(stored, site as Site, t).map((n) => ({
    id: n.id,
    level: n.level,
    starts_at: n.starts_at,
    ends_at: n.ends_at,
    message: n.message,
    link_url: n.link_url,
    link_label: n.link_label,
  }))
  return json(200, { generated_at: new Date(t).toISOString(), notices }, 'public, max-age=60')
}

export async function handleSiteNoticeAdmin(request: Request, env: Env, now: () => number = Date.now): Promise<Response> {
  if (!env.CHECKOUT_CONTROL_SECRET) return json(500, { error: 'CHECKOUT_CONTROL_SECRET is not configured' })
  const provided = request.headers.get('x-admin-secret')?.trim() ?? ''
  if (!provided || !safeEqual(provided, env.CHECKOUT_CONTROL_SECRET)) return json(401, { error: 'Unauthorized' })

  if (request.method === 'GET') return json(200, { stored: await readStored(env) })
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'invalid JSON body' })
  }
  const action = text(body?.action, 20)
  const actor = text(body?.actor, 100)
  const reason = text(body?.reason, 500)
  if (!actor || !reason) return json(400, { error: 'actor and reason are required' })

  let notices: SiteNotice[]
  if (action === 'clear') {
    notices = []
  } else if (action === 'set') {
    if (!Array.isArray(body?.notices)) return json(400, { error: 'notices must be a list' })
    if (body.notices.length > MAX_NOTICES) return json(400, { error: `at most ${MAX_NOTICES} notices` })
    notices = []
    for (const raw of body.notices) {
      const n = validateNotice(raw)
      if (typeof n === 'string') return json(400, { error: n })
      if (notices.some((x) => x.id === n.id)) return json(400, { error: `duplicate id ${n.id}` })
      notices.push(n)
    }
  } else {
    return json(400, { error: 'action must be set or clear' })
  }

  const before = await readStored(env)
  const stored: StoredNotices = { notices, updated_at: new Date(now()).toISOString(), actor, reason }
  await env.MPP_STORE.put(SITE_NOTICE_KEY, JSON.stringify(stored))
  return json(200, { action, before, after: stored })
}
