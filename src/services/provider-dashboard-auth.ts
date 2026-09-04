export async function hashDashboardToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function issueDashboardToken(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return { token, hash: await hashDashboardToken(token) }
}

export async function verifyDashboardToken(header: string | null, expectedHash: string | undefined): Promise<boolean> {
  const match = header?.match(/^Bearer ([A-Fa-f0-9]{64})$/)
  // Hash a fixed dummy value too, so missing/malformed credentials follow the
  // same cryptographic path as a well-formed but incorrect token.
  const suppliedHash = await hashDashboardToken(match?.[1] ?? '0'.repeat(64))
  const supplied = Uint8Array.from(suppliedHash.match(/../g) ?? [], value => Number.parseInt(value, 16))
  const expected = Uint8Array.from((expectedHash ?? '0'.repeat(64)).match(/../g) ?? [], value => Number.parseInt(value, 16))
  let difference = supplied.byteLength ^ expected.byteLength
  for (let index = 0; index < 32; index++) {
    difference |= (supplied[index] ?? 0) ^ (expected[index] ?? 0)
  }
  return Boolean(match && expectedHash && difference === 0)
}
