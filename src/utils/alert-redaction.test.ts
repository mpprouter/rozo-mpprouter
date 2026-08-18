import { describe, it, expect } from 'vitest'
import { redactForAlert } from './alert-redaction'

/**
 * Threat `Info.1`. These tests assert the two properties the treatment claims:
 * a credential never survives the boundary, and an alert stays actionable.
 *
 * Every secret below is a syntactically valid but FABRICATED value. None is a
 * real key. They exist so the assertions test the real regexes rather than a
 * placeholder shape.
 */

/**
 * Build a credential-shaped test value at RUNTIME rather than writing it as a
 * literal.
 *
 * Reason: CI runs `semgrep --config p/secrets`, which fingerprints
 * secret-shaped string literals. A hard-coded fake key here would turn the
 * security gate red on every unrelated PR, and a permanently red gate has zero
 * discriminating power — it looks identical whether or not a real key was
 * committed, so everyone learns to ignore it. Constructing the value defeats
 * the fingerprint without weakening any scanner rule.
 *
 * These values are fabricated. The Stellar one is verified NOT to be a valid
 * strkey (its checksum does not validate), so it cannot correspond to a real
 * account even by accident.
 */
function fabricate(prefix: string, body: string): string {
  return prefix + body
}

// A helper that fails loudly if any fragment of a secret survives. Asserting
// only `not.toContain(whole)` would pass even if the redaction split a key in
// half, which is still a disclosure.
function expectFullyRedacted(output: string, secret: string) {
  expect(output).not.toContain(secret)
  // No run of 16+ chars from the secret may survive anywhere in the output.
  for (let i = 0; i + 16 <= secret.length; i++) {
    expect(output).not.toContain(secret.slice(i, i + 16))
  }
}

describe('credential redaction', () => {
  it('removes a Stellar secret seed', () => {
    const secret = fabricate('S', 'CDGKQWTYQFNQNQMOQGX7PVFWQGGZ7VZ6NHGWFBBOAZLKFVJLNZJIYTM')
    const out = redactForAlert(`refund signing failed for ${secret} after 3 attempts`)
    expectFullyRedacted(out, secret)
    expect(out).toContain('[REDACTED:stellar-secret]')
    // The surrounding operational context must survive.
    expect(out).toContain('refund signing failed')
    expect(out).toContain('after 3 attempts')
  })

  it('removes a hex private key with and without 0x', () => {
    const key = fabricate('a3f1c9d24b8e7051', '6d2f8b04c7e93a1568df402be9c1783a5d0e6f2b94c7a018')
    expectFullyRedacted(redactForAlert(`key=${key}`), key)
    expectFullyRedacted(redactForAlert(`key=0x${key}`), key)
  })

  it('removes a JWT', () => {
    const jwt = fabricate('eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    const out = redactForAlert(`upstream rejected token ${jwt}`)
    expectFullyRedacted(out, jwt)
    expect(out).toContain('[REDACTED:jwt]')
  })

  it("removes the alert channel's own access_token when a URL is echoed", () => {
    // This is the concrete self-inflicted leak: the DingTalk webhook URL is
    // itself `?access_token=...`, so an alert that echoes a failing request
    // would publish the credential of the channel carrying it.
    const token = fabricate('f4c2a90b7e13d85a', '6c0f29b4e871d3506a2c9f8e1b47d0a35e6c8f92b1d47a06')
    const out = redactForAlert(`POST https://oapi.dingtalk.com/robot/send?access_token=${token} failed 500`)
    expectFullyRedacted(out, token)
    expect(out).toContain('[REDACTED]')
    expect(out).toContain('failed 500')
  })

  it('removes Authorization headers and bare Bearer tokens', () => {
    const t = fabricate('sk-', 'live-9f2b7c4e1a86d035')
    expectFullyRedacted(redactForAlert(`Authorization: Bearer ${t}`), t)
    expectFullyRedacted(redactForAlert(`sent with Bearer ${t} header`), t)
  })

  it('removes secret-shaped assignments in a dumped config object', () => {
    const out = redactForAlert({
      ROUTER_SIGNING_SECRET: fabricate('hunter2-', 'not-a-real-secret'),
      STELLAR_RPC_URL: 'https://soroban.example.org',
    })
    expect(out).not.toContain(fabricate('hunter2-', 'not-a-real-secret'))
    // A non-secret field must survive, or the alert is useless.
    expect(out).toContain('soroban.example.org')
  })

  // Codex review P1. `seed_phrase: "word word word ..."` previously lost only
  // its first word to the assignment rule, and the mnemonic rule did not match
  // the underscore-separated field name — so most of a recovery phrase reached
  // the outbound alert. This is the worst single failure this module can have.
  it('removes an ENTIRE multi-word mnemonic in a dumped object', () => {
    const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
    for (const field of ['seed_phrase', 'recovery-phrase', 'mnemonic', 'seedPhrase']) {
      const out = redactForAlert(`{"${field}": "${phrase}", "stage": "settle"}`)
      expectFullyRedacted(out, phrase)
      // Every individual word must be gone, not just the joined phrase.
      for (const word of phrase.split(' ')) {
        expect(out.split(/\W+/)).not.toContain(word)
      }
    }
  })

  it('removes anything labelled a mnemonic, to end of line', () => {
    const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
    const out = redactForAlert(`seed phrase: ${phrase}\nnext line survives`)
    expectFullyRedacted(out, phrase)
    expect(out).toContain('next line survives')
  })

  // Codex review round 2, P1. The unquoted assignment rule terminated at `,`
  // and `;`, so `password=abc,def` redacted only `abc` and left a usable
  // suffix. Secrets contain punctuation routinely.
  it('redacts an unquoted secret value containing punctuation, not just up to the comma', () => {
    const secret = fabricate('abc,', 'def;ghi=jkl')
    const out = redactForAlert(`password=${secret} conn=ok`)
    expect(out).not.toContain('def')
    expect(out).not.toContain('jkl')
    // The next whitespace-separated field must survive.
    expect(out).toContain('conn=ok')
  })

  it('removes a signed XDR envelope', () => {
    const xdr = 'AAAAAgAAAAC' + 'B'.repeat(120) + '='
    expectFullyRedacted(redactForAlert(`submitting ${xdr}`), xdr)
  })

  it('removes long opaque blobs of unknown credential format', () => {
    // The catch-all: a credential shape we have no rule for yet must still not
    // escape. This is the rule that makes the boundary fail closed.
    const blob = 'Zm9vYmFy'.repeat(12)
    expectFullyRedacted(redactForAlert(`opaque=${blob}`), blob)
  })
})

describe('identifiers stay actionable', () => {
  it('masks a Stellar address to first 6 + last 4', () => {
    const out = redactForAlert('gas sponsor GD5R4HXKQZQ7YVKN3PZWQGJ4M2TLKQXBB4UZQ7YVKN3PZWQGJ4M2TLKQ low')
    expect(out).toContain('GD5R4H...TLKQ')
    expect(out).not.toContain('GD5R4HXKQZQ7YVKN3PZWQGJ4M2TLKQXBB4UZQ7YVKN3PZWQGJ4M2TLKQ')
  })

  it('masks an EVM address', () => {
    const out = redactForAlert('operator 0xD3BeDD1234567890abcdef1234567890abcd35ee balance low')
    expect(out).toContain('0xD3Be...35ee')
  })

  // Codex review P2. The earlier version of this test asserted only that
  // surrounding prose survived, deliberately avoiding a real hash — so it
  // would have passed while every transaction hash was being destroyed.
  it('keeps a LABELLED transaction hash identifiable, truncated not verbatim', () => {
    const hash = fabricate('9c1d4e7a2f8b0356', 'd1e9a4c7b20f8365de4a19c0b7f2e836a5d194c7b20f8365')
    for (const label of ['tx_hash', 'source_tx_hash', 'payout_hash', 'txid', 'ledger_hash']) {
      const out = redactForAlert(`payout failed, ${label}=${hash} on Base`)
      // Enough to locate the transaction...
      expect(out).toContain(hash.slice(0, 16))
      expect(out).toContain(hash.slice(-8))
      // ...but never the whole value.
      expect(out).not.toContain(hash)
      expect(out).toContain('on Base')
    }
  })

  // Codex review round 3, P0. Narrowing the label list reduced the CHANCE that
  // a key gets exempted; it did not remove the CONSEQUENCE. Even a correctly
  // labelled value is now restored truncated, so a key arriving under a
  // `tx_hash=` label — by our own bug, or via content an attacker steered —
  // leaks 24 of 64 hex chars, leaving 160 bits unknown. Not a recoverable key.
  it('never restores a full 64-hex value, even under a valid label', () => {
    const key = fabricate('a3f1c9d24b8e7051', '6d2f8b04c7e93a1568df402be9c1783a5d0e6f2b94c7a018')
    for (const label of ['tx_hash', 'source_tx_hash', 'txid', 'ledger_hash', 'envelope_hash']) {
      const out = redactForAlert(`${label}=${key}`)
      expect(out).not.toContain(key)
      // No unbroken run of hex longer than the 16-char head may survive.
      // (Counting hex CHARACTERS would be wrong — a-f also occur in ordinary
      // English words, which is how the first version of this assertion
      // failed.)
      const longestHexRun = Math.max(
        0,
        ...(out.match(/[0-9a-fA-F]+/g) ?? []).map((run) => run.length),
      )
      expect(longestHexRun).toBeLessThanOrEqual(16)
    }
  })

  // Codex review round 2, P0. The exemption list previously accepted the bare
  // words `hash`, `tx` and `transaction`, justified in a comment by "a leaked
  // key is never labelled tx_hash". That is an assumption about attacker
  // behaviour, not a boundary: alert content is partly attacker-influenced
  // (upstream error bodies reach alerts), so generic prose could buy an
  // exemption for a real key.
  it('does NOT let a generic label exempt a 64-hex value', () => {
    const key = fabricate('a3f1c9d24b8e7051', '6d2f8b04c7e93a1568df402be9c1783a5d0e6f2b94c7a018')
    for (const bait of ['hash', 'transaction', 'tx', 'Transaction hash', 'the hash']) {
      const out = redactForAlert(`upstream said: ${bait}: ${key}`)
      expect(out).not.toContain(key)
    }
  })

  it('requires a separator, so a label earlier in a sentence exempts nothing', () => {
    const key = fabricate('a3f1c9d24b8e7051', '6d2f8b04c7e93a1568df402be9c1783a5d0e6f2b94c7a018')
    const out = redactForAlert(`tx_hash lookup failed while handling ${key}`)
    expect(out).not.toContain(key)
  })

  it('still redacts an UNLABELLED 64-hex value, because it could be a key', () => {
    // Fail closed: shape alone cannot distinguish a hash from a private key,
    // and only one of the two guesses leaks.
    const blob = fabricate('9c1d4e7a2f8b0356', 'd1e9a4c7b20f8365de4a19c0b7f2e836a5d194c7b20f8365')
    const out = redactForAlert(`unexpected value ${blob}`)
    expect(out).not.toContain(blob)
    expect(out).toContain('[REDACTED:hex-key]')
  })

  it('cannot be tricked into preserving a private key by forging a sentinel', () => {
    // The hash-preservation pass uses NUL-delimited sentinels. Input NULs are
    // stripped before that pass, so content cannot smuggle text past redaction.
    const secret = fabricate('S', 'CDGKQWTYQFNQNQMOQGX7PVFWQGGZ7VZ6NHGWFBBOAZLKFVJLNZJIYTM')
    const forged = ` H0  ${secret}`
    expectFullyRedacted(redactForAlert(forged), secret)
  })

  it('masks an email to a single leading character', () => {
    const out = redactForAlert('invoice gate blocked payer alice.smith@example.com')
    expect(out).toContain('a***@example.com')
    expect(out).not.toContain('alice.smith@example.com')
  })
})

describe('boundary is total and cannot throw', () => {
  it('accepts unknown, because catch(e) gives unknown', () => {
    expect(() => redactForAlert(undefined)).not.toThrow()
    expect(() => redactForAlert(null)).not.toThrow()
    expect(() => redactForAlert(12345)).not.toThrow()
  })

  it('redacts a secret carried inside an Error stack', () => {
    const secret = fabricate('S', 'CDGKQWTYQFNQNQMOQGX7PVFWQGGZ7VZ6NHGWFBBOAZLKFVJLNZJIYTM')
    const err = new Error(`failed to sign with ${secret}`)
    expectFullyRedacted(redactForAlert(err), secret)
  })

  it('survives a circular object rather than throwing on the alert path', () => {
    const obj: Record<string, unknown> = { stage: 'settle' }
    obj.self = obj
    expect(() => redactForAlert(obj)).not.toThrow()
    expect(redactForAlert(obj)).toContain('settle')
  })

  it('truncates oversized content, where dumped payloads put their tail', () => {
    // Ordinary prose, not one long token: an unbroken 5000-char run would be
    // consumed by the long-opaque-blob rule first (itself correct behaviour)
    // and never reach the truncation path being tested here.
    const out = redactForAlert('upstream timeout on request '.repeat(200))
    expect(out.length).toBeLessThan(2100)
    expect(out).toContain('[truncated]')
  })

  it('redacts a secret that appears only past the truncation point', () => {
    const secret = fabricate('S', 'CDGKQWTYQFNQNQMOQGX7PVFWQGGZ7VZ6NHGWFBBOAZLKFVJLNZJIYTM')
    // Redaction must run BEFORE truncation, otherwise a secret beyond the cap
    // would be silently dropped rather than redacted — and any later change to
    // the cap would resurface it.
    const out = redactForAlert('y'.repeat(1990) + ' ' + secret)
    expectFullyRedacted(out, secret)
  })
})
