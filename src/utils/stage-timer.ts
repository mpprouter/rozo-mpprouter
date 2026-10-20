/**
 * StageTimer — coarse per-request stage timings rendered as a `Server-Timing`
 * header, so a slow create-invoice can be attributed to a stage (gate, quote,
 * slot scan, relink guard, upstream intents call, post-create re-reads)
 * straight from the browser devtools or a curl, without logs.
 *
 * `mark(name)` records the milliseconds since the previous mark (or since
 * construction for the first mark). Uses Date.now(): in Workers the clock only
 * advances across I/O, which is exactly what these stages measure.
 */
export class StageTimer {
  private readonly start: number
  private last: number
  private readonly entries: Array<[string, number]> = []
  /** `Server-Timing` of the upstream intents response, if it sent one. */
  upstreamServerTiming: string | null = null

  constructor(now: number = Date.now()) {
    this.start = now
    this.last = now
  }

  mark(name: string): void {
    const now = Date.now()
    this.entries.push([name, now - this.last])
    this.last = now
  }

  /** Stage durations in ms; a stage marked more than once is summed. */
  stages(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [name, dur] of this.entries) out[name] = (out[name] ?? 0) + dur
    return out
  }

  /** `name;dur=123, ..., total;dur=4567` (total = construction until now). */
  header(): string {
    const parts = this.entries.map(([name, dur]) => `${name};dur=${dur}`)
    parts.push(`total;dur=${Date.now() - this.start}`)
    return parts.join(', ')
  }
}
