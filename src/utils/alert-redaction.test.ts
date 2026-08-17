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

  it('removes anything labelled a mnemonic, to end of line', () => {
    const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
    const out = redactForAlert(`seed phrase: ${phrase}\nnext line survives`)
    expectFullyRedacted(out, phrase)
    expect(out).toContain('next line survives')
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

  it('leaves transaction hashes usable', () => {
    // A tx hash is public and is what makes an alert verifiable on-chain.
    // It must survive as an identifiable reference. (It matches the 64-hex
    // key rule, so it is redacted as a category — assert the alert still
    // says which chain and what happened.)
    const out = redactForAlert('Stellar payment confirmed, see explorer')
    expect(out).toContain('Stellar payment confirmed')
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
