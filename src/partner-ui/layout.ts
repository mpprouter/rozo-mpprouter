/**
 * Shared chrome for the partner UI.
 *
 * Everything here is plain HTML/CSS strings served by the Worker itself. That
 * is the whole point of the design: the page and the API are same-origin, so
 * the session cookie is a boring first-party cookie and there is no build
 * step, no framework and no i18n pipeline to keep in sync. Chinese only.
 *
 * Visual language matches open.rozo.ai/claim: near-black surfaces, white
 * primary button, 12px radii, the same type scale.
 */

/** Options every partner page accepts. */
export interface PartnerUiOptions {
  /**
   * How the partner reaches us for top-ups and lost passwords. There is no
   * self-serve top-up and no password reset, so this string is the only exit
   * from both dead ends — T4 should pass the real handle at route
   * registration time.
   */
  contact?: string
  /** PostHog project key. Omitted => analytics is a no-op, page still works. */
  posthogKey?: string
  /** PostHog ingest host. */
  posthogHost?: string
}

export const DEFAULT_CONTACT = '联系方式待填写（请运营在部署时填入微信 / Telegram / 邮箱）'

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Escapes a string for embedding inside a <script> as a JS string literal. */
export function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003c')
}

export const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
/* The page must never scroll horizontally on a phone. */
html, body { max-width: 100%; overflow-x: hidden; }
body {
  background: #0A0A0A;
  color: #FFFFFF;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.6;
  -webkit-text-size-adjust: 100%;
}
a { color: #FFFFFF; }
.wrap { max-width: 720px; margin: 0 auto; padding: 0 20px; width: 100%; }
.wrap--wide { max-width: 1000px; }
header.topbar {
  border-bottom: 1px solid #1F1F23;
  position: sticky; top: 0; z-index: 40; background: #0A0A0A;
}
header.topbar .wrap {
  height: 56px; display: flex; align-items: center;
  justify-content: space-between; gap: 12px;
}
.brand { font-weight: 700; letter-spacing: -0.02em; font-size: 14.5px; text-decoration: none; }
.brand span.sub { color: #71717A; font-weight: 500; margin-left: 8px; }
h1 { font-size: clamp(24px, 3.2vw, 34px); line-height: 1.14; letter-spacing: -0.022em; font-weight: 650; margin: 0 0 10px; }
h2 { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 10px; }
p { margin: 0 0 12px; }
.muted { color: #A1A1AA; font-size: 13.5px; }
.dim { color: #71717A; font-size: 12.5px; }
.card {
  background: #141416; border: 1px solid #232327; border-radius: 16px;
  padding: 22px; margin: 0 0 16px;
}
.label { font-size: 12px; font-weight: 600; color: #A3A3A3; margin: 0 0 8px; display: block; }
.input {
  width: 100%; height: 52px; border: 1px solid #3A3A40; border-radius: 12px;
  background: #202225; padding: 0 14px; font-size: 16px; color: #fff;
  font-family: inherit;
}
.input::placeholder { color: #71717A; }
.input:focus { outline: 2px solid #fff; outline-offset: -1px; }
.btn {
  min-height: 48px; border: 0; border-radius: 12px; background: #fff; color: #0A0A0A;
  font-size: 15px; font-weight: 650; cursor: pointer; font-family: inherit;
  padding: 0 18px; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
}
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--block { width: 100%; }
.btn--ghost {
  background: transparent; color: #A3A3A3; border: 1px solid #3A3A40;
  min-height: 40px; font-weight: 600; font-size: 13.5px;
}
.btn--ghost:hover:not(:disabled) { color: #fff; border-color: #52525B; }

/* Copyable script block. Wraps on purpose: the claim URL is long, and a pre
   that does not wrap makes the whole page scroll sideways on a phone, which
   is the one thing this layout must never do.
   (No backticks in here -- the stylesheet lives in a template literal.) */
.copybox {
  white-space: pre-wrap; word-break: break-word;
  background: #0F0F11; border: 1px solid #27272A; border-radius: 8px;
  padding: 14px; margin: 0 0 12px; font-family: inherit;
  font-size: 13px; line-height: 1.75; color: #D4D4D8;
}

/* Chat launcher. Intercom swaps in its own launcher once booted, so this only
   has to look right until the first click. */
#help-fab {
  position: fixed; right: 20px; bottom: 20px;
  width: 52px; height: 52px; border-radius: 50%; border: none;
  background: #2F6FED; color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 6px 20px rgba(0,0,0,.42); z-index: 2147483000;
}
#help-fab:hover { background: #3B7BF5; }
@media (max-width: 520px) { #help-fab { right: 14px; bottom: 14px; width: 48px; height: 48px; } }
.btn--danger { background: #DC2626; color: #fff; }
.steps { display: grid; gap: 12px; margin: 0 0 4px; padding: 0; list-style: none; }
.step { display: flex; gap: 10px; align-items: flex-start; }
.step-n {
  width: 22px; height: 22px; border-radius: 7px; background: #fff; color: #0A0A0A;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 3px;
}
.note {
  border-radius: 12px; padding: 13px 15px; font-size: 13.5px; line-height: 1.55;
  margin: 0 0 12px;
}
.note--warn { background: #2A2312; border: 1px solid #4D3F14; color: #FDE68A; }
.note--err { background: #2A1414; border: 1px solid #4D1F1F; color: #FCA5A5; }
.note--ok { background: #10251A; border: 1px solid #1F5133; color: #86EFAC; }
.badge {
  display: inline-block; padding: 3px 9px; border-radius: 999px;
  font-size: 12px; font-weight: 600; white-space: nowrap;
}
.badge.ok { background: #10251A; color: #86EFAC; border: 1px solid #1F5133; }
.badge.busy { background: #2A2312; color: #FDE68A; border: 1px solid #4D3F14; }
.badge.done { background: #16213A; color: #93C5FD; border: 1px solid #234072; }
.badge.dead { background: #1C1C20; color: #A1A1AA; border: 1px solid #2E2E34; }
/* Wide content scrolls inside its own box; the body never does. */
.scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; min-width: 720px; font-size: 13.5px; }
th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid #1F1F23; vertical-align: middle; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #71717A; font-weight: 600; }
td.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.06em; }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
pre.confirm {
  background: #0A0A0A; border: 1px solid #2E2E34; border-radius: 12px;
  padding: 14px; margin: 0 0 14px; font-size: 12.5px; line-height: 1.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre; overflow-x: auto; color: #E4E4E7;
}
dialog {
  border: 1px solid #2E2E34; border-radius: 16px; background: #141416; color: #fff;
  padding: 22px; width: min(560px, calc(100vw - 32px)); max-height: 88vh; overflow-y: auto;
}
dialog::backdrop { background: rgba(0,0,0,0.66); }
.row { display: flex; gap: 10px; flex-wrap: wrap; }
.row--end { justify-content: flex-end; }
.chip {
  min-height: 44px; padding: 0 16px; border-radius: 12px; background: #202225;
  border: 1px solid #3A3A40; color: #fff; font-size: 15px; font-weight: 600;
  cursor: pointer; font-family: inherit;
}
.chip[aria-pressed="true"] { background: #fff; color: #0A0A0A; border-color: #fff; }
.chip:disabled { opacity: 0.35; cursor: not-allowed; }
details.adv summary {
  cursor: pointer; font-size: 13.5px; color: #A1A1AA; margin: 14px 0 0;
  list-style: none; user-select: none;
}
details.adv summary::-webkit-details-marker { display: none; }
details.adv summary::before { content: '▸ '; }
details.adv[open] summary::before { content: '▾ '; }
.balance { font-size: clamp(38px, 8vw, 54px); font-weight: 700; letter-spacing: -0.03em; line-height: 1.05; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
@media (max-width: 560px) {
  .card { padding: 18px; border-radius: 14px; }
}
`

/**
 * PostHog, loaded lazily and defensively.
 *
 * Two hard rules live in here:
 *  - never send a full coupon code. A code is a bearer token; a full code
 *    sitting in a third-party analytics system is a leak. Only the last 4
 *    digits and the partnerId ever leave the page.
 *  - the page must work perfectly when this script is blocked. `track()` is a
 *    try/catch no-op if PostHog never loads, and nothing awaits it.
 */
export function analyticsScript(opts: PartnerUiOptions): string {
  const key = opts.posthogKey ?? ''
  const host = opts.posthogHost ?? 'https://us.i.posthog.com'
  return `
var PH_KEY = ${jsString(key)};
var PH_HOST = ${jsString(host)};
var __phQueue = [];
var __partnerId = null;
function setPartnerId(id) { __partnerId = id || null; }
/** track(event, props). Props must never contain a full coupon code. */
function track(event, props) {
  try {
    var payload = Object.assign({ partnerId: __partnerId }, props || {});
    if (window.posthog && window.posthog.capture) window.posthog.capture(event, payload);
    else __phQueue.push([event, payload]);
  } catch (e) { /* analytics must never break the page */ }
}
(function loadPostHog() {
  if (!PH_KEY) return;
  try {
    var s = document.createElement('script');
    s.async = true;
    s.src = PH_HOST + '/static/array.js';
    s.onload = function () {
      try {
        window.posthog.init(PH_KEY, { api_host: PH_HOST, capture_pageview: false });
        var q = __phQueue; __phQueue = [];
        for (var i = 0; i < q.length; i++) window.posthog.capture(q[i][0], q[i][1]);
      } catch (e) {}
    };
    s.onerror = function () { __phQueue = []; };
    document.head.appendChild(s);
  } catch (e) {}
})();
`
}

export function htmlPage(opts: {
  title: string
  bodyHtml: string
  script: string
  robots?: string
}): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="${opts.robots ?? 'noindex,nofollow'}" />
<title>${escapeHtml(opts.title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
${opts.bodyHtml}
<script>${opts.script}</script>
</body>
</html>`
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Partner pages are per-session and must never be shared by a cache.
      'cache-control': 'no-store',
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  })
}
