/**
 * Mandatory redaction boundary for every outbound alert.
 *
 * Threat model: `Info.1` (information disclosure via alerting). The previous
 * treatment claimed "a redaction module exists and several call sites mask
 * their own content". That was overclaimed in two ways:
 *
 *   1. `utils/redact.ts` is NOT a general redaction layer. It computes keyed
 *      HMAC digests for the coupon audit trail in D1. It was never on the
 *      alerting path.
 *   2. Masking at the call site is unenforceable. A new alert added tomorrow
 *      by someone who has not read the threat model bypasses it silently, and
 *      nothing fails.
 *
 * The fix is to make the bypass a COMPILE ERROR rather than a review finding.
 * `RedactedAlert` is a branded string that only `redactForAlert` can produce,
 * and the alert transports accept nothing else. Passing a raw `string` — the
 * exact mistake that caused this finding — no longer type-checks.
 *
 * Design rules:
 *   - FAIL CLOSED. When a pattern is ambiguous we over-redact. A garbled alert
 *     is recoverable; a leaked signing key is not.
 *   - Redaction is IRREVERSIBLE. Placeholders carry a category, never a hint
 *     (no prefixes, no lengths, no digests) — a digest of a low-entropy secret
 *     is still an oracle.
 *   - Order matters. Whole-credential patterns run before address masking so a
 *     secret is never partially revealed by a narrower rule matching first.
 */

declare const redactedAlertBrand: unique symbol

/**
 * A string that has passed through `redactForAlert`. The brand exists only in
 * the type system (zero runtime cost); its purpose is that no other value is
 * assignable to it, so the alert transports cannot be handed raw text.
 */
export type RedactedAlert = string & { readonly [redactedAlertBrand]: true }

/**
 * Hard ceiling on alert length. Truncation is a containment control, not
 * cosmetics: a stack trace or a dumped request body is the most common way a
 * secret reaches an alert, and the tail is where dumps put their payload.
 */
const MAX_ALERT_LENGTH = 2000

interface Rule {
  readonly name: string
  readonly pattern: RegExp
  readonly replacement: string
}

/**
 * Whole-credential rules. These run first and consume the entire secret, so a
 * later narrower rule can never expose a fragment of one.
 */
const CREDENTIAL_RULES: readonly Rule[] = [
  // Stellar secret seed: strkey 'S' + 55 base32 chars. Highest severity in
  // this codebase — the refund signer and gas sponsor keys have this shape.
  { name: 'stellar-secret', pattern: /\bS[A-Z2-7]{55}\b/g, replacement: '[REDACTED:stellar-secret]' },

  // EVM / generic 32-byte private key, with or without 0x.
  { name: 'hex-private-key', pattern: /\b(?:0x)?[0-9a-fA-F]{64}\b/g, replacement: '[REDACTED:hex-key]' },

  // JWT (three base64url segments). Session and service tokens.
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: '[REDACTED:jwt]',
  },

  // Authorization headers, however cased. Consumes to end of line, NOT `\S+`:
  // an auth header value is `<scheme> <token>` — two whitespace-separated
  // fields — so `\S+` eats only the scheme and leaves the credential in
  // plaintext. Caught by the `Bearer` test.
  {
    name: 'auth-header',
    pattern: /\b(authorization|proxy-authorization)\s*[:=].*/gi,
    replacement: '$1: [REDACTED:auth-header]',
  },

  // `Bearer <token>` appearing outside a header line.
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: 'Bearer [REDACTED:token]' },

  // Secret-bearing query parameters — the DingTalk webhook itself is
  // `?access_token=...`, so any alert that echoes a URL can leak the alert
  // channel's own credential.
  {
    name: 'secret-query-param',
    pattern:
      /([?&](?:access_token|token|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|auth|signature|sig)=)[^&\s"']+/gi,
    replacement: '$1[REDACTED]',
  },

  // Assignments in dumped config / env / JSON.
  {
    name: 'secret-assignment',
    pattern:
      /\b([A-Za-z0-9_.-]*(?:secret|password|passwd|pwd|private[_-]?key|seed|mnemonic|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token)[A-Za-z0-9_.-]*)\s*(["']?\s*[:=]\s*["']?)([^\s,;}"']+)/gi,
    replacement: '$1$2[REDACTED]',
  },

  // Anything the author explicitly labelled as a seed phrase / mnemonic:
  // redact to end of line rather than attempting BIP-39 word detection, which
  // both misses non-English wordlists and misfires on ordinary prose.
  {
    name: 'labelled-mnemonic',
    pattern: /\b(seed\s*phrase|mnemonic|recovery\s*phrase)\b\s*[:=]?.*/gi,
    replacement: '$1: [REDACTED:mnemonic]',
  },

  // Signed Stellar transaction envelopes (base64 XDR). An envelope carries the
  // signature and can be replayed as-is if it has not yet been submitted.
  { name: 'xdr-envelope', pattern: /\bAAAA[A-Za-z0-9+/]{60,}={0,2}/g, replacement: '[REDACTED:xdr]' },

  // Long high-entropy blobs that matched none of the above. Deliberately last
  // and deliberately broad: unknown credential formats are the ones we have no
  // rule for yet.
  { name: 'long-opaque-blob', pattern: /\b[A-Za-z0-9+/_-]{80,}={0,2}\b/g, replacement: '[REDACTED:blob]' },
]

/**
 * Identifier-masking rules. These keep an alert actionable — an operator must
 * be able to tell which account an alert is about — while satisfying the
 * company-wide "first 6 + last 4" address display rule.
 *
 * Transaction hashes are intentionally NOT masked: they are public, and an
 * unmaskable hash is what makes an alert verifiable on-chain.
 */
interface MaskRule {
  readonly name: string
  readonly pattern: RegExp
  readonly mask: (match: string) => string
}

const IDENTIFIER_RULES: readonly MaskRule[] = [
  // Stellar public key (G...), contract (C...), muxed (M...).
  { name: 'stellar-address', pattern: /\b[GCM][A-Z2-7]{55}\b/g, mask: maskToken },
  // EVM address.
  { name: 'evm-address', pattern: /\b0x[0-9a-fA-F]{40}\b/g, mask: maskToken },
  // Email — a payer's email is PII and appears in invoice-gate alerts.
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    mask: maskEmail,
  },
]

function maskToken(match: string): string {
  return `${match.slice(0, 6)}...${match.slice(-4)}`
}

function maskEmail(match: string): string {
  const [local, domain] = match.split('@')
  const head = local.slice(0, 1)
  return `${head}***@${domain}`
}

/**
 * The ONLY way to obtain a `RedactedAlert`.
 *
 * Accepts `unknown` on purpose: alert content is routinely built from caught
 * errors, and `catch (e)` gives `unknown`. Forcing callers to stringify first
 * pushes the risky step outside the boundary, which is precisely the failure
 * this module exists to prevent.
 */
export function redactForAlert(content: unknown): RedactedAlert {
  let text = stringify(content)

  for (const rule of CREDENTIAL_RULES) {
    text = text.replace(rule.pattern, rule.replacement)
  }
  for (const rule of IDENTIFIER_RULES) {
    text = text.replace(rule.pattern, rule.mask)
  }

  if (text.length > MAX_ALERT_LENGTH) {
    text = `${text.slice(0, MAX_ALERT_LENGTH)}\n[truncated]`
  }

  return text as RedactedAlert
}

/**
 * Stringify without ever invoking attacker-influenced `toString`, and without
 * throwing on cycles — a redaction boundary that can throw becomes a denial of
 * service on the alert path.
 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object') {
    try {
      const seen = new WeakSet<object>()
      return JSON.stringify(value, (_k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]'
          seen.add(v)
        }
        return v
      }) ?? String(value)
    } catch {
      return '[unserializable]'
    }
  }
  return String(value)
}

/**
 * Escape hatch for content that is provably constant and secret-free — a fixed
 * banner, a hard-coded heading. It is deliberately verbose and greppable so
 * that `grep -rn "assertNoSecrets" src/` audits every bypass in one command.
 *
 * Still runs the full redaction pass; the name only documents author intent.
 * There is no way to reach a transport without redaction.
 */
export function assertNoSecrets(literal: string): RedactedAlert {
  return redactForAlert(literal)
}
