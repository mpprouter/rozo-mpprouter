/**
 * A merchant response is only an async job when the merchant says the work is
 * still pending. Misclassifying a delivered sync response as a job is a
 * money-losing bug: the answer is discarded, the payer gets a poll URL bound
 * to a path the merchant does not serve, and — because the call counts as
 * dispatched — no refund fires.
 */
import { describe, it, expect } from 'vitest'
import { isAsyncJobResponse } from '../src/routes/proxy'

describe('isAsyncJobResponse', () => {
  it('treats a 202 as async regardless of body', () => {
    expect(isAsyncJobResponse(202, '{"jobId":"j1"}').isAsync).toBe(true)
    expect(isAsyncJobResponse(202, 'not json').isAsync).toBe(true)
  })

  it('treats a 200 with a pending status as async', () => {
    // StableStudio Nano-Banana-Pro shape — the case the 200 path exists for.
    const r = isAsyncJobResponse(200, '{"jobId":"j2","status":"queued"}')
    expect(r.isAsync).toBe(true)
    expect(r.jobId).toBe('j2')
  })

  it('does NOT treat a delivered sync completion as async', () => {
    // Regression: anthropic_chat_completions, 2026-08-21. An id and no status.
    // Classifying this as async discarded the answer AND skipped the refund.
    const body = JSON.stringify({
      id: 'msg_011CeFY81u5yR3tKWXdQT6uk',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
    })
    expect(isAsyncJobResponse(200, body).isAsync).toBe(false)
  })

  it('does NOT treat a 200 with a terminal status as async', () => {
    expect(isAsyncJobResponse(200, '{"id":"j3","status":"completed"}').isAsync).toBe(false)
    expect(isAsyncJobResponse(200, '{"id":"j4","status":"failed"}').isAsync).toBe(false)
  })

  it('does not invent a job from a 200 with no id at all', () => {
    expect(isAsyncJobResponse(200, '{"status":"queued"}').isAsync).toBe(false)
  })

  it('still extracts the job id from every accepted spelling', () => {
    expect(isAsyncJobResponse(202, '{"job_id":"a"}').jobId).toBe('a')
    expect(isAsyncJobResponse(202, '{"jobId":"b"}').jobId).toBe('b')
    expect(isAsyncJobResponse(202, '{"id":"c"}').jobId).toBe('c')
  })
})
