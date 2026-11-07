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
import { Challenge } from 'mppx'

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

/**
 * Parse the header with mppx's own list parser, the one the payment retry
 * uses. It throws when any challenge is malformed; callers must then refuse
 * before charging, because the retry would fail the same way after payment.
 */
export function parseTempoChallengesStrict(wwwAuthenticate: string): ParsedTempoChallenge[] {
  return Challenge.deserializeList(wwwAuthenticate).map((c: any) => ({
    id: String(c.id),
    realm: String(c.realm ?? ''),
    intent: String(c.intent ?? 'charge'),
    request: c.request,
    expires: c.expires,
  }))
}

/**
 * Charge tokens the router will pay a merchant in when it offers a choice,
 * most preferred first. Both are 6-decimal USD stablecoins, the assumption the
 * Stellar quote conversion relies on. A token not listed here is never chosen
 * over the merchant's first offer.
 */
export const CHARGE_TOKEN_PREFERENCE: readonly string[] = [
  '0x20c000000000000000000000b9537d11c60e8b50', // USDC.e
  '0x20c0000000000000000000006a37da5c996874be', // OUSD
]

export interface ChargeChallengeSelection {
  challenge: ParsedTempoChallenge
  /** Currency the paid retry must answer in; set only when there was a choice. */
  lockCurrency: string
}

/**
 * Choose which charge challenge to pay when a merchant offers several, one per
 * accepted token (fal and Firecrawl, 2026-11-07: OUSD, USDC.e, pathUSD).
 *
 * Returns null when there is no choice to make (zero or one charge challenge,
 * or none in a preferred token): the caller keeps the merchant's first offer,
 * the pre-existing behaviour. Otherwise the first preferred token whose pool
 * balance covers that challenge's amount wins; when none does (or balances are
 * unreadable) the most preferred offer is returned so the pool pre-flight
 * refuses it, or proceeds exactly as it did before on an unreadable balance.
 */
export async function selectChargeChallenge(
  challenges: ParsedTempoChallenge[],
  balanceOf: (currency: string) => Promise<bigint | null>,
): Promise<ChargeChallengeSelection | null> {
  const charges = challenges.filter((c) => c.intent.toLowerCase() === 'charge')
  if (charges.length < 2) return null
  const preferred: ParsedTempoChallenge[] = []
  for (const token of CHARGE_TOKEN_PREFERENCE) {
    const match = charges.find((c) => same(c.request.currency, token))
    if (match) preferred.push(match)
  }
  if (preferred.length === 0) return null
  for (const c of preferred) {
    let amount: bigint
    try {
      amount = BigInt(c.request.amount)
    } catch {
      continue
    }
    const balance = await balanceOf(c.request.currency)
    if (balance !== null && balance >= amount) return { challenge: c, lockCurrency: c.request.currency }
  }
  return { challenge: preferred[0], lockCurrency: preferred[0].request.currency }
}

/**
 * mppx `orderChallenges` hook body for the charge leg: keep only charge
 * candidates in `currency`, the token the buyer was quoted and the pool was
 * checked for. An empty result makes mppx stop before signing anything.
 */
export function filterChargeCandidates<
  T extends { challenge?: { intent?: string; request?: { currency?: unknown } } },
>(candidates: T[], currency: string): T[] {
  return candidates.filter(
    (c) =>
      String(c?.challenge?.intent ?? '').toLowerCase() === 'charge' &&
      same(c?.challenge?.request?.currency, currency),
  )
}
