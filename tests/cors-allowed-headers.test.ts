import { describe, expect, it } from 'vitest'
import { handlePreflight } from '../src/utils/cors'
import { CHECKOUT_CHANNEL_PROOF_HEADER } from '../src/routes/checkout-web-pricing'

describe('CORS preflight', () => {
  it('allows the checkout channel proof header the agent checkout sends', () => {
    const res = handlePreflight(
      new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/invoice-details', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://agent-beta.rozo.ai',
          'access-control-request-method': 'POST',
          'access-control-request-headers': `content-type,${CHECKOUT_CHANNEL_PROOF_HEADER}`,
        },
      }),
    )
    expect(res.status).toBe(204)
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').split(',').map((h) => h.trim().toLowerCase())
    expect(allowed).toContain('content-type')
    expect(allowed).toContain(CHECKOUT_CHANNEL_PROOF_HEADER)
  })
})
