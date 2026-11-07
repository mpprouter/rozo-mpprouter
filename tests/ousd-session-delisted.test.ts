import { describe, expect, it } from 'vitest'
import { getRouteByPublicPath, listPublicCatalog } from '../src/services/merchants'

const DELISTED = [
  ['openai_chat', '/v1/services/openai/chat'],
  ['anthropic_messages', '/v1/services/anthropic/messages'],
  ['anthropic_chat_completions', '/v1/services/anthropic/chat_completions'],
] as const

describe('OUSD session routes stay closed until re-verified', () => {
  it.each(DELISTED)('%s is refused by the proxy gate and gated for verification', (_id, path) => {
    const route = getRouteByPublicPath(path, 'POST')!
    expect(route.verifiedMode).toBe(false)
    expect(route.launchGate).toBe('OUSD_SESSION_LAUNCH_MODE')
  })

  it.each(DELISTED)('%s is not advertised as payable or verified', (id) => {
    const entry = listPublicCatalog({} as never).find((e) => e.id === id)!
    expect(entry.payment_enabled).toBe(false)
    expect(entry.payment_status).not.toBe('verified')
    expect(entry.charge_rozo_verified).not.toBe(true)
    expect(entry.session_rozo_verified).not.toBe(true)
  })
})
