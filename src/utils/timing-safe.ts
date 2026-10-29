/**
 * Constant-time string comparison for secrets (admin tokens, shared secrets).
 *
 * `a !== b` returns at the first differing character, so response timing can
 * leak how much of a guessed secret is right. This compares every character
 * of equal-length inputs regardless of where they differ. A length mismatch
 * returns early; that reveals only the length, which is not secret material
 * for random tokens.
 *
 * Returns false when either side is missing, so callers can pass an
 * unconfigured env value straight in.
 */
export function timingSafeEqualStr(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length === 0 || b.length === 0) return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
