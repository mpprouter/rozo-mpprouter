/**
 * Rate limiting via Cloudflare KV with TTL-based expiry.
 * Per Stellar address, configurable max requests per minute.
 */

export async function checkRateLimit(
  kv: KVNamespace,
  stellarAddress: string,
  maxRequests: number,
): Promise<boolean> {
  const key = `ratelimit:${stellarAddress}`
  const current = await kv.get(key)
  const count = current ? parseInt(current, 10) : 0

  if (count >= maxRequests) {
    return false
  }

  await kv.put(key, String(count + 1), { expirationTtl: 60 })
  return true
}
