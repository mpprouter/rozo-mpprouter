import { describe, it, expect } from 'vitest'
import { isEnvelopeLiftedRoute, presentMerchantEnvelope } from '../src/routes/merchant-envelope'

const groqBody = JSON.stringify({
  success: true,
  data: {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi there friend' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  },
})

describe('presentMerchantEnvelope', () => {
  it('lifts the provider body to the top level and keeps the envelope', () => {
    const out = JSON.parse(presentMerchantEnvelope(groqBody, 'application/json; charset=utf-8'))
    expect(out.choices[0].message.content).toBe('Hi there friend')
    expect(out.data.choices[0].message.content).toBe('Hi there friend')
    expect(out.success).toBe(true)
    expect(out.usage.total_tokens).toBe(16)
    expect(out.id).toBe('chatcmpl-1')
  })

  it('returns a bare provider body unchanged, byte for byte', () => {
    const bare = '{"id":"chatcmpl-2","choices":[{"message":{"content":"x"}}]}'
    expect(presentMerchantEnvelope(bare, 'application/json')).toBe(bare)
  })

  it('leaves non-JSON content types and invalid JSON alone', () => {
    expect(presentMerchantEnvelope(groqBody, 'text/plain')).toBe(groqBody)
    expect(presentMerchantEnvelope('{not json', 'application/json')).toBe('{not json')
    expect(presentMerchantEnvelope('[1,2]', 'application/json')).toBe('[1,2]')
  })

  it('does not touch error envelopes or envelopes with extra keys', () => {
    const err = '{"success":false,"error":"nope"}'
    expect(presentMerchantEnvelope(err, 'application/json')).toBe(err)
    const extra = '{"success":true,"data":{"a":1},"meta":{}}'
    expect(presentMerchantEnvelope(extra, 'application/json')).toBe(extra)
    const scalar = '{"success":true,"data":"ok"}'
    expect(presentMerchantEnvelope(scalar, 'application/json')).toBe(scalar)
  })

  it('envelope keys win over provider fields of the same name', () => {
    const clash = JSON.stringify({ success: true, data: { success: false, data: 'inner', x: 1 } })
    const out = JSON.parse(presentMerchantEnvelope(clash, 'application/json'))
    expect(out.success).toBe(true)
    expect(out.data).toEqual({ success: false, data: 'inner', x: 1 })
    expect(out.x).toBe(1)
  })
})

describe('isEnvelopeLiftedRoute', () => {
  it('covers only the two Locus chat routes', () => {
    expect(isEnvelopeLiftedRoute('groq_chat')).toBe(true)
    expect(isEnvelopeLiftedRoute('deepseek_chat')).toBe(true)
    expect(isEnvelopeLiftedRoute('openai_chat')).toBe(false)
    expect(isEnvelopeLiftedRoute('coingecko_simple_price')).toBe(false)
  })
})
