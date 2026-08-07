/**
 * Partner-facing UI, served as plain HTML strings by this Worker.
 *
 * Route registration lives in `src/index.ts` and is owned by T4 — nothing in
 * this directory touches it. T4 should wire:
 *
 *   GET /partner      -> renderPartnerExplainerPage(opts)   // logged out
 *   GET /partner/app  -> renderPartnerAppPage(opts)         // session required
 *
 * Both take the same options object; pass the real contact handle and (if
 * wanted) a PostHog key from env there, so this directory stays free of
 * configuration.
 */
export { renderPartnerExplainerPage } from './explainer'
export { renderPartnerAppPage } from './app'
export { DEFAULT_CONTACT, htmlResponse, escapeHtml } from './layout'
export type { PartnerUiOptions } from './layout'
export { MONEY_JS } from './money-js'
