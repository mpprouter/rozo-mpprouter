import { afterEach, describe, expect, it, vi } from 'vitest'
import { StageTimer } from '../src/utils/stage-timer'

afterEach(() => vi.restoreAllMocks())

describe('StageTimer', () => {
  it('records ms since the previous mark and renders a Server-Timing header with total', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000)
    const t = new StageTimer()
    now.mockReturnValue(1_120)
    t.mark('gate')
    now.mockReturnValue(1_120)
    t.mark('quote')
    now.mockReturnValue(1_500)
    t.mark('upstream')
    now.mockReturnValue(1_600)
    expect(t.stages()).toEqual({ gate: 120, quote: 0, upstream: 380 })
    expect(t.header()).toBe('gate;dur=120, quote;dur=0, upstream;dur=380, total;dur=600')
  })

  it('renders only total when nothing was marked, and sums a repeated stage', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(0)
    const t = new StageTimer()
    now.mockReturnValue(5)
    expect(t.header()).toBe('total;dur=5')
    t.mark('upstream')
    now.mockReturnValue(12)
    t.mark('upstream')
    expect(t.stages()).toEqual({ upstream: 12 })
    expect(t.upstreamServerTiming).toBeNull()
  })
})
