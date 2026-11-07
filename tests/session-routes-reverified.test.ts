import { describe, expect, it } from 'vitest'
import { getRouteByPublicPath, listPublicCatalog } from '../src/services/merchants'

// 2026-11-07: delisted for the token migration, then re-verified the same day
// with real paid calls through the router on new USDC.e session channels.
const ROUTES = [
  ['openai_chat', '/v1/services/openai/chat'],
  ['anthropic_messages', '/v1/services/anthropic/messages'],
  ['anthropic_chat_completions', '/v1/services/anthropic/chat_completions'],
] as const

describe('re-verified session routes', () => {
  it.each(ROUTES)('%s is no longer refused by the proxy gate', (_id, path) => {
    const route = getRouteByPublicPath(path, 'POST')!
    expect(route.verifiedMode).not.toBe(false)
  })

  it.each(ROUTES)('%s is advertised as payable and verified', (id) => {
    const entry = listPublicCatalog({} as never).find((e) => e.id === id)!
    expect(entry.payment_enabled).toBe(true)
    expect(entry.payment_status).toBe('verified')
    expect(entry.session_rozo_verified).toBe(true)
  })
})
