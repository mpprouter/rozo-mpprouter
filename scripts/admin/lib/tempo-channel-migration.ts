/**
 * Checks for opening a Tempo session channel and installing it in KV.
 *
 * Kept free of network and wrangler calls so each stop condition is testable.
 * A failure here must leave KV untouched: a wrong channel in a slot is worse
 * than no channel, because the proxy would sign vouchers the merchant rejects.
 */

export interface SessionChallenge {
  intent: string
  amount: string
  currency: string
  recipient: string
  decimals: number
  escrowContract: string
  chainId: number
}

/**
 * Split a `WWW-Authenticate` value into its challenges. Merchants offer one
 * session challenge per accepted token in a single header.
 */
export function splitChallenges(wwwAuthenticate: string): string[] {
  return wwwAuthenticate.split(/,\s*(?=Payment\s)/)
}

function parseOneChallenge(text: string): SessionChallenge {
  const intent = text.match(/intent="([^"]+)"/)?.[1]
  const encoded = text.match(/request="([^"]+)"/)?.[1]
  if (!intent || !encoded) throw new Error('challenge has no intent or request')
  const request = JSON.parse(
    Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
  )
  const details = request.methodDetails ?? {}
  return {
    intent,
    amount: String(request.amount ?? ''),
    currency: String(request.currency ?? ''),
    recipient: String(request.recipient ?? ''),
    decimals: request.decimals === undefined ? 6 : Number(request.decimals),
    escrowContract: String(details.escrowContract ?? ''),
    chainId: Number(details.chainId ?? 0),
  }
}

/**
 * Pick the session challenge in `currency` from an unpaid 402. Throws on anything
 * unusable, and when the token is not offered exactly once.
 */
export function selectSessionChallenge(wwwAuthenticate: string | null, currency: string): SessionChallenge {
  if (!wwwAuthenticate) throw new Error('merchant returned no WWW-Authenticate challenge')
  const matches = splitChallenges(wwwAuthenticate)
    .map(parseOneChallenge)
    .filter((c) => c.intent === 'session' && sameAddress(c.currency, currency))
  if (matches.length !== 1) {
    throw new Error(`expected one session challenge in ${currency}, found ${matches.length}`)
  }
  const challenge = matches[0]
  if (!/^\d+$/.test(challenge.amount)) throw new Error('challenge amount is not a base-unit integer')
  for (const [name, value] of [
    ['recipient', challenge.recipient],
    ['escrowContract', challenge.escrowContract],
  ] as const) {
    if (!isAddress(value)) throw new Error(`challenge ${name} is missing or malformed`)
  }
  if (!challenge.chainId) throw new Error('challenge chainId is missing')
  if (challenge.decimals !== 6) throw new Error(`challenge decimals ${challenge.decimals} is not 6`)
  return challenge
}

export interface OpenExpectations {
  currency: string
  depositRaw: bigint
  maxDepositRaw: bigint
}

/** Stop before spending when the live challenge is not what was approved. */
export function assertChallengeMatchesApproval(challenge: SessionChallenge, expected: OpenExpectations): void {
  if (!sameAddress(challenge.currency, expected.currency)) {
    throw new Error(`challenge currency ${challenge.currency} is not the approved ${expected.currency}`)
  }
  if (expected.depositRaw <= 0n || expected.depositRaw > expected.maxDepositRaw) {
    throw new Error(`deposit ${expected.depositRaw} is outside the approved ceiling ${expected.maxDepositRaw}`)
  }
}

/**
 * A fetch for the session manager that shows it only the approved challenge.
 *
 * mppx signs the first challenge it can use, and merchants list several tokens,
 * so filtering the header decides what gets signed. The approved challenge was
 * read in a separate request, so the fields are compared again here.
 */
export function guardedChallengeFetch(
  approved: SessionChallenge,
  underlying: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await underlying(input, init)
    if (response.status !== 402) return response
    const header = response.headers.get('www-authenticate')
    const live = selectSessionChallenge(header, approved.currency)
    if (
      !sameAddress(live.recipient, approved.recipient) ||
      !sameAddress(live.escrowContract, approved.escrowContract) ||
      live.chainId !== approved.chainId
    ) {
      throw new Error('merchant changed the challenge after approval; refusing to sign')
    }
    const only = splitChallenges(header as string).filter((text) => {
      const c = parseOneChallenge(text)
      return c.intent === 'session' && sameAddress(c.currency, approved.currency)
    })
    const headers = new Headers(response.headers)
    headers.set('www-authenticate', only[0])
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}

/** The script's own arithmetic, so the ceiling does not rest on the manager's. */
export function assertWithinDepositCeiling(requiredDepositRaw: bigint, ceilingRaw: bigint): void {
  if (requiredDepositRaw > ceilingRaw) {
    throw new Error(`required deposit ${requiredDepositRaw} exceeds the approved ceiling ${ceilingRaw}; not topping up`)
  }
}

export interface ChannelDescriptor {
  authorizedSigner: string
  expiringNonceHash: string
  operator: string
  payee: string
  payer: string
  salt: string
  token: string
}

export interface OpenedChannel {
  channelId: string
  escrow: string
  descriptor?: ChannelDescriptor
  /**
   * Channel id recomputed from the descriptor. The id commits to token, payer,
   * payee and signer, so a match proves the descriptor is the on-chain channel.
   */
  derivedChannelId: string
  onChain: { deposit: bigint; settled: bigint; closeRequestedAt: bigint }
}

/** Every field the Worker signs with must agree before the channel enters KV. */
export function assertOpenedChannel(
  opened: OpenedChannel,
  challenge: SessionChallenge,
  walletAddress: string,
  requiredDepositRaw: bigint,
): void {
  const problems: string[] = []
  const d = opened.descriptor
  if (!d) problems.push('descriptor missing')
  if (!isAddress(opened.escrow) || !sameAddress(opened.escrow, challenge.escrowContract)) {
    problems.push('escrow differs from the challenge')
  }
  if (d) {
    if (!sameAddress(d.token, challenge.currency)) problems.push('descriptor token differs from the challenge')
    if (!sameAddress(d.payee, challenge.recipient)) problems.push('descriptor payee differs from the challenge')
    if (!sameAddress(d.payer, walletAddress)) problems.push('descriptor payer is not the wallet')
    if (!sameAddress(d.authorizedSigner, walletAddress)) problems.push('descriptor signer is not the wallet')
  }
  if (opened.derivedChannelId.toLowerCase() !== opened.channelId.toLowerCase()) {
    problems.push('descriptor does not derive the channel id')
  }
  const { deposit, closeRequestedAt } = opened.onChain
  if (deposit < requiredDepositRaw) problems.push(`on-chain deposit ${deposit} is below ${requiredDepositRaw}`)
  if (closeRequestedAt !== 0n) problems.push('channel has a pending close')
  if (problems.length) throw new Error(`refusing to install channel ${opened.channelId}: ${problems.join('; ')}`)
}

export interface SlotRecord {
  channelId: string
  authorizedSigner: string
  currency: string
  cumulativeRaw: string
  [key: string]: unknown
}

export interface SlotStore {
  get(key: string): string | null
  put(key: string, value: string): void
  /** Pause between read-back attempts. KV is eventually consistent; absent means one attempt. */
  wait?: () => void
}

const READ_BACK_ATTEMPTS = 12

function readsBack(store: SlotStore, key: string, value: string): boolean {
  const attempts = store.wait ? READ_BACK_ATTEMPTS : 1
  for (let i = 0; i < attempts; i++) {
    if (store.get(key) === value) return true
    if (i < attempts - 1) store.wait?.()
  }
  return false
}

export interface SlotExpectation {
  merchantId: string
  /** Channel expected in the primary slot now, or null when it must be empty. */
  oldChannelId: string | null
  walletAddress: string
  /** Called with the pre-write values before anything is written. */
  snapshot: (slots: { primary: string | null; alt: string | null }) => void
}

function parseSlot(raw: string | null, key: string): SlotRecord | null {
  if (raw === null) return null
  const parsed = JSON.parse(raw) as SlotRecord
  if (!parsed.channelId) throw new Error(`${key} has no channelId`)
  return parsed
}

/**
 * The old record must be a channel the new wallet cannot sign, and the alt slot
 * must be free. Run before spending, so a bad slot stops the open.
 */
export function assertSlotsReady(store: SlotStore, expected: SlotExpectation): void {
  const primaryKey = `tempoChannel:${expected.merchantId}`
  const altKey = `tempoChannelAlt:${expected.merchantId}`
  const primary = parseSlot(store.get(primaryKey), primaryKey)
  const alt = store.get(altKey)
  if (alt !== null) throw new Error(`${altKey} already holds a record; refusing to overwrite it`)
  if (expected.oldChannelId === null) {
    if (primary) throw new Error(`${primaryKey} holds ${primary.channelId} but an empty slot was expected`)
    return
  }
  if (!primary) throw new Error(`${primaryKey} is empty but ${expected.oldChannelId} was expected`)
  if (primary.channelId.toLowerCase() !== expected.oldChannelId.toLowerCase()) {
    throw new Error(`${primaryKey} holds ${primary.channelId}, not the expected ${expected.oldChannelId}`)
  }
  if (sameAddress(primary.authorizedSigner, expected.walletAddress)) {
    throw new Error(`${primaryKey} is already signed by this wallet; nothing to migrate`)
  }
}

/**
 * Move the old record to the alt slot, then install the new channel. Each write
 * is conditional on the value read at the start, and read back. Plain KV has no
 * compare-and-set, so this assumes the route is closed to traffic, which the
 * caller must establish first.
 */
export function installChannel(store: SlotStore, expected: SlotExpectation, next: SlotRecord): void {
  assertSlotsReady(store, expected)
  const primaryKey = `tempoChannel:${expected.merchantId}`
  const altKey = `tempoChannelAlt:${expected.merchantId}`
  const before = store.get(primaryKey)
  expected.snapshot({ primary: before, alt: store.get(altKey) })

  if (before !== null) {
    store.put(altKey, before)
    if (!readsBack(store, altKey, before)) throw new Error(`${altKey} did not read back the old record`)
    if (store.get(primaryKey) !== before) {
      throw new Error(`${primaryKey} changed during the move; stop, the route is not idle`)
    }
  }
  const value = JSON.stringify(next, null, 2)
  store.put(primaryKey, value)
  if (!readsBack(store, primaryKey, value)) throw new Error(`${primaryKey} did not read back the new channel`)
}

export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value)
}
