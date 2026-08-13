/**
 * PLAYGROUND_CHAT_MODELS_DISABLED emergency stop: chat rejects BEFORE any
 * payment work, and /config marks every model unavailable — so no user can be
 * charged while an upstream merchant is failing paid calls (403-after-pay).
 */
import { describe, expect, it } from 'vitest'
import { channelPricingConfig } from '../src/playground/channel-config'
import { CHAT_OUTAGE_REASON, chatModelsDisabled } from '../src/playground/models'

describe('chat outage emergency stop', () => {
  it('off by default', () => {
    expect(chatModelsDisabled({})).toBe(false)
    const cfg = channelPricingConfig({})
    expect(cfg.models.some(m => m.available)).toBe(true)
  })

  it('marks every model unavailable with the outage reason when on', () => {
    const cfg = channelPricingConfig({ PLAYGROUND_CHAT_MODELS_DISABLED: 'true' })
    for (const m of cfg.models) {
      expect(m.available).toBe(false)
      expect(m.unavailable_reason).toBeTruthy()
    }
    expect(cfg.models.some(m => m.unavailable_reason === CHAT_OUTAGE_REASON)).toBe(true)
  })
})

describe('provider-scoped outage stop (CSV value)', () => {
  it('disables only the listed providers; others stay callable', () => {
    const env = { PLAYGROUND_CHAT_MODELS_DISABLED: 'anthropic,openai,gemini' }
    expect(chatModelsDisabled(env, 'anthropic')).toBe(true)
    expect(chatModelsDisabled(env, 'openai')).toBe(true)
    expect(chatModelsDisabled(env, 'groq')).toBe(false)
    expect(chatModelsDisabled(env, 'deepseek')).toBe(false)
    const cfg = channelPricingConfig(env)
    const byProvider = Object.fromEntries(cfg.models.map(m => [m.id, m.available]))
    expect(byProvider['llama-3.1-8b-instant']).toBe(true)
    expect(byProvider['deepseek-v4-flash']).toBe(true)
    expect(byProvider['claude-haiku-4-5']).toBe(false)
    expect(byProvider['claude-opus-5']).toBe(false)
  })

  it("'false' and empty disable nothing; 'true' disables everything", () => {
    expect(chatModelsDisabled({ PLAYGROUND_CHAT_MODELS_DISABLED: 'false' }, 'anthropic')).toBe(false)
    expect(chatModelsDisabled({}, 'anthropic')).toBe(false)
    expect(chatModelsDisabled({ PLAYGROUND_CHAT_MODELS_DISABLED: 'true' }, 'groq')).toBe(true)
  })
})
