/**
 * P0-3 (undercharge): the quoted price a user signs must ALWAYS be >= the
 * maximum the router could pay upstream for that call, including the Blend
 * chip's extra narration call. The quote is built from the enforced budget
 * ceilings, so actual spend (which is capped at those ceilings) can never
 * exceed the quote.
 */
import { describe, expect, it } from 'vitest'
import { parseUsd } from '../src/playground/amount'
import {
  CHANNEL_FLAT_MODEL_PRICE_USD,
  channelPriceForChip,
  channelPriceForModel,
} from '../src/playground/channel-config'
import {
  PLAYGROUND_CHIPS,
  PLAYGROUND_MODELS,
  TIER_UPSTREAM_BUDGET_USD,
  findChip,
} from '../src/playground/models'

describe('channel quote always covers the max upstream cost (P0-3)', () => {
  it('every model quote >= its tier upstream budget ceiling + a positive markup', () => {
    for (const m of PLAYGROUND_MODELS) {
      const { maxUpstreamRaw, priceRaw } = channelPriceForModel(m)
      const budget = parseUsd(TIER_UPSTREAM_BUDGET_USD[m.tier])
      expect(maxUpstreamRaw).toBe(budget)
      expect(priceRaw).toBeGreaterThan(budget)
    }
  })

  it('every model is charged EXACTLY the flat uniform price (founder 2026-08-13)', () => {
    const flat = parseUsd(CHANNEL_FLAT_MODEL_PRICE_USD)
    for (const m of PLAYGROUND_MODELS) {
      const { priceRaw } = channelPriceForModel(m)
      expect(priceRaw).toBe(flat) // no per-model / per-tier price spread
    }
  })

  it('every chip quote >= its upstream budget ceiling + markup', () => {
    for (const c of PLAYGROUND_CHIPS) {
      const { maxUpstreamRaw, priceRaw } = channelPriceForChip(c)
      expect(maxUpstreamRaw).toBeGreaterThanOrEqual(parseUsd(c.budgetUsd))
      expect(priceRaw).toBeGreaterThan(maxUpstreamRaw)
    }
  })

  it('the Blend quote also covers the extra narration call', () => {
    const blend = findChip('blend-activity')!
    const { maxUpstreamRaw, priceRaw } = channelPriceForChip(blend)
    // Blend makes TWO paid calls: the indexer query (chip budget) AND a cheap
    // narration completion. The quote must cover BOTH.
    const narrationBudget = parseUsd(TIER_UPSTREAM_BUDGET_USD.cheap)
    const combined = parseUsd(blend.budgetUsd) + narrationBudget
    expect(maxUpstreamRaw).toBe(combined)
    expect(priceRaw).toBeGreaterThan(combined)
  })
})
