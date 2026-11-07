/**
 * Choosing among several Tempo payment challenges in one 402.
 *
 * Tempo session merchants now offer one challenge per accepted token in a
 * single `WWW-Authenticate` header (2026-11-07: OUSD, USDC.e and MACH, same
 * amount, payee and escrow). A voucher only redeems against the channel's own
 * token, so a session route must answer the challenge in its channel's
 * currency and refuse when the merchant does not offer it. Taking the first
 * challenge signed vouchers against a token the channel did not hold, which
 * the merchant rejected after the buyer had paid.
 */
import type { TempoChannelState } from './channel-store'

/** Known Tempo tokens, for labels only. Unknown tokens show a short address. */
const TOKEN_SYMBOLS: Record<string, string> = {
  '0x20c000000000000000000000b9537d11c60e8b50': 'USDC.e',
  '0x20c0000000000000000000006a37da5c996874be': 'OUSD',
}

export function tokenSymbol(currency: string | undefined | null): string {
  if (!currency) return 'USDC.e'
  const known = TOKEN_SYMBOLS[currency.toLowerCase()]
  return known ?? `${currency.slice(0, 6)}...${currency.slice(-4)}`
}

export interface ParsedTempoChallenge {
  id: string
  realm: string
  intent: string
  request: {
    amount: string
    currency: string
    recipient: string
    decimals?: number
    methodDetails?: { escrowContract?: string; chainId?: number; [key: string]: unknown }
    [key: string]: any
  }
  expires?: string
}

/** One header can carry several `Payment ...` challenges separated by commas. */
export function splitChallenges(wwwAuthenticate: string): string[] {
  return wwwAuthenticate.split(/,\s*(?=Payment\s)/i)
}

function parseOne(text: string): ParsedTempoChallenge | null {
  try {
    const idMatch = text.match(/id="([^"]+)"/)
    const requestMatch = text.match(/request="([^"]+)"/)
    if (!idMatch || !requestMatch) return null
    const request = JSON.parse(atob(requestMatch[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (!request || typeof request !== 'object') return null
    return {
      id: idMatch[1],
      realm: text.match(/realm="([^"]+)"/)?.[1] || '',
      intent: text.match(/intent="([^"]+)"/)?.[1] || 'charge',
      request,
      expires: text.match(/expires="([^"]+)"/)?.[1],
    }
  } catch {
    return null
  }
}

/** Every parseable challenge, in header order. Unparseable ones are skipped. */
export function parseTempoChallenges(wwwAuthenticate: string): ParsedTempoChallenge[] {
  return splitChallenges(wwwAuthenticate)
    .map(parseOne)
    .filter((c): c is ParsedTempoChallenge => c !== null)
}

function same(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

/** Request fields a session challenge must share with the channel. */
export interface SessionChallengeRequestLike {
  currency?: unknown
  recipient?: unknown
  decimals?: unknown
  escrowContract?: unknown
  chainId?: unknown
  methodDetails?: { escrowContract?: unknown; chainId?: unknown } | undefined
}

export type ChallengeMismatch = 'currency' | 'payee' | 'escrow' | 'chain' | 'decimals'

/**
 * Which field, if any, stops this challenge from being paid from `channel`.
 * Escrow and chain sit in `methodDetails` on the wire and at the top level
 * before mppx's schema transform, so both places are read.
 */
export function sessionChallengeMismatch(
  request: SessionChallengeRequestLike,
  channel: Pick<TempoChannelState, 'currency' | 'payee' | 'escrowContract' | 'chainId'>,
): ChallengeMismatch | null {
  if (!same(request.currency, channel.currency)) return 'currency'
  if (!same(request.recipient, channel.payee)) return 'payee'
  const escrow = request.methodDetails?.escrowContract ?? request.escrowContract
  if (!same(escrow, channel.escrowContract)) return 'escrow'
  const chainId = request.methodDetails?.chainId ?? request.chainId
  if (chainId === undefined || Number(chainId) !== Number(channel.chainId)) return 'chain'
  // Both tokens the channels may hold use 6 decimals; the voucher math assumes it.
  if (request.decimals !== undefined && Number(request.decimals) !== 6) return 'decimals'
  return null
}

export type SessionChallengeSelection =
  | { ok: true; challenge: ParsedTempoChallenge }
  | { ok: false; reason: 'no_session_challenge' | 'no_matching_challenge'; offered: string[] }

/**
 * The single session challenge payable from `channel`. Refuses when none
 * matches, so the caller can stop before the buyer is charged.
 */
export function selectSessionChallenge(
  challenges: ParsedTempoChallenge[],
  channel: Pick<TempoChannelState, 'currency' | 'payee' | 'escrowContract' | 'chainId'>,
): SessionChallengeSelection {
  const sessions = challenges.filter((c) => c.intent.toLowerCase() === 'session')
  const offered = sessions.map((c) => tokenSymbol(String(c.request.currency ?? '')))
  if (sessions.length === 0) return { ok: false, reason: 'no_session_challenge', offered }
  const match = sessions.find((c) => sessionChallengeMismatch(c.request, channel) === null)
  if (!match) return { ok: false, reason: 'no_matching_challenge', offered }
  return { ok: true, challenge: match }
}

/**
 * mppx `orderChallenges` hook body: keep only candidates payable from
 * `channel`. An empty result makes mppx stop before signing anything.
 */
export function filterPayableCandidates<
  T extends { challenge?: { intent?: string; request?: SessionChallengeRequestLike } },
>(
  candidates: T[],
  channel: Pick<TempoChannelState, 'currency' | 'payee' | 'escrowContract' | 'chainId'>,
): T[] {
  // Session only: the proxy quoted and pre-flighted a session challenge, so a
  // charge candidate with the same fields must not be the one mppx pays.
  return candidates.filter(
    (c) =>
      String(c?.challenge?.intent ?? '').toLowerCase() === 'session' &&
      sessionChallengeMismatch(c?.challenge?.request ?? {}, channel) === null,
  )
}
