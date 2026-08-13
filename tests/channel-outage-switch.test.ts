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
