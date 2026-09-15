/**
 * Locus-style merchant envelope: make both shapes work.
 *
 * The paywithlocus merchants (groq, deepseek) wrap the provider body in
 * `{ "success": true, "data": { ...provider body... } }`, while every other
 * listed LLM merchant returns the provider body bare. OpenAI-compatible
 * clients read `choices[0].message.content` and found nothing on those two
 * routes even though the call was paid and delivered (Scopuly pilot,
 * 2026-09-15, request 9752e88d…; same class as playground bug 12 on
 * 2026-08-13, which the playground fixed for itself only).
 *
 * The fix here deliberately keeps BOTH shapes (founder decision 2026-09-15):
 * the provider fields are lifted to the top level so standard clients work,
 * and `success` + `data` are kept so a client already written against the
 * envelope keeps working. The result is `{ ...data, success: true, data }`.
 *
 * Only this exact envelope is touched. Anything else (bare bodies, error
 * envelopes, non-JSON, arrays, a `data` that is not an object) is returned
 * byte-for-byte, so no other merchant's response can change. A provider
 * field named `success` or `data` cannot be clobbered either: the spread
 * runs first and the envelope keys win, which is the shape callers of the
 * envelope already rely on.
 */
export function presentMerchantEnvelope(body: string, contentType: string): string {
  if (!/^\s*application\/json\b/i.test(contentType)) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return body
  const env = parsed as Record<string, unknown>
  if (env.success !== true) return body
  const data = env.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return body
  const keys = Object.keys(env)
  // Exactly the envelope, nothing else riding alongside it.
  if (keys.length !== 2 || !keys.includes('success') || !keys.includes('data')) return body
  return JSON.stringify({ ...(data as Record<string, unknown>), success: true, data })
}
