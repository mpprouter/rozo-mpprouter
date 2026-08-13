/**
 * Blend chip decoding against a REALISTIC Mercury event shape.
 *
 * Regression guard for the bug where every event fell through to `other`
 * because the classifier read `topics`/`topic` while Mercury's
 * `/rest/events/by-contract` delivers flat, base64-XDR `topic1`…`topicN`
 * fields. These fixtures are built with the same SDK that decodes them, so a
 * regression in the field wiring, the symbol scan, the amount decode, or the
 * empty-render guard fails the suite.
 */

import { describe, it, expect } from 'vitest'
import { xdr, nativeToScVal, Keypair, Address } from '@stellar/stellar-sdk'
import {
  eventName,
  classify,
  aggregateBlendEvents,
  describeAggregate,
  extractEvents,
} from '../src/playground/blend'

const sym = (name: string) => xdr.ScVal.scvSymbol(name).toXDR('base64')
const addr = (strkey: string) => new Address(strkey).toScVal().toXDR('base64')
const tuple = (...amounts: bigint[]) =>
  xdr.ScVal
    .scvVec(amounts.map(a => nativeToScVal(a, { type: 'i128' })))
    .toXDR('base64')

const CONTRACT = 'CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP'

// A Mercury supply event: topic1 = "supply" symbol, topic2 = reserve asset,
// topic3 = the depositing account, data = (amount, b_tokens_minted).
function supplyEvent(user: string, amount: bigint) {
  return {
    contract_id: CONTRACT,
    topic1: sym('supply'),
    topic2: addr(new Address(Keypair.random().publicKey()).toString()),
    topic3: addr(user),
    data: tuple(amount, 999n),
    tx: 'deadbeef',
    event_index: 0,
  }
}

describe('Blend chip reads Mercury topic1..N', () => {
  it('classifies a Mercury supply event as a deposit', () => {
    const user = Keypair.random().publicKey()
    const ev = supplyEvent(user, 1_000_000n)
    expect(eventName(ev)).toBe('supply')
    expect(classify(eventName(ev))).toBe('deposit')
  })

  it('aggregates counts, amounts, and participants from topic1..N', () => {
    const u1 = Keypair.random().publicKey()
    const u2 = Keypair.random().publicKey()
    const agg = aggregateBlendEvents(
      [supplyEvent(u1, 1_000_000n), supplyEvent(u2, 500_000n)],
      CONTRACT,
    )
    const deposit = agg.rows.find(r => r.action === 'deposit')!
    expect(deposit.count).toBe(2)
    // amount decoded from the base64-XDR i128 tuple, not left at 0
    expect(deposit.total_amount).toBe('1500000')
    expect(deposit.amount_samples).toBe(2)
    expect(deposit.unique_participants).toBe(2)

    const desc = describeAggregate(agg)
    expect(desc).toContain('2 deposits')
  })

  it('never renders an all-other batch as empty — shows the event types seen', () => {
    const auctions = Array.from({ length: 200 }, () => ({
      contract_id: CONTRACT,
      topic1: sym('fill_auction'),
      data: tuple(1n),
    }))
    const agg = aggregateBlendEvents(auctions, CONTRACT)
    // all classify to `other`
    expect(agg.rows.filter(r => r.action !== 'other' && r.count > 0)).toHaveLength(0)
    expect(agg.other_event_names).toContain('fill_auction')

    const desc = describeAggregate(agg)
    expect(desc).toContain('200')
    expect(desc).toContain('fill_auction')
    expect(desc).not.toMatch(/^Examined 200 recent Blend pool events; none matched a known/)
  })

  it('still handles a pre-decoded topics array (envelope resilience)', () => {
    const ev = { topics: ['borrow'], data: '4200' }
    expect(classify(eventName(ev))).toBe('borrow')
    const agg = aggregateBlendEvents([ev], CONTRACT)
    expect(agg.rows.find(r => r.action === 'borrow')!.total_amount).toBe('4200')
  })

  it('does not crash on a malformed/null event — skips it as unparseable', () => {
    const good = supplyEvent(Keypair.random().publicKey(), 1_000_000n)
    // extractEvents drops null/primitive elements; a decode-hostile OBJECT that
    // slips through must be contained by the per-event guard.
    const raw = [null, 42, 'nope', { topic1: 12345 /* not a string */ }, good]
    const events = aggregateBlendEvents(extractEvents(raw), CONTRACT)
    // null/primitives filtered out; only the two objects remain examined
    expect(events.events_examined).toBe(2)
    // the good one still classifies; nothing threw
    expect(events.rows.find(r => r.action === 'deposit')!.count).toBe(1)
    // counts reconcile to events_examined
    const total = events.rows.reduce((n, r) => n + r.count, 0)
    expect(total).toBe(events.events_examined)
  })

  it('counts each event exactly once even when parsing throws mid-event', () => {
    const good = supplyEvent(Keypair.random().publicKey(), 1_000_000n)
    // A valid symbol (so it classifies as deposit), but `data` throws when read
    // during extractAmount — AFTER classification. The old code counted it in
    // `deposit` before the throw, then the catch counted it again in `other`.
    const throwsMidParse: Record<string, unknown> = { topic1: sym('supply') }
    Object.defineProperty(throwsMidParse, 'data', {
      enumerable: true,
      get() {
        throw new Error('hostile field access')
      },
    })
    const agg = aggregateBlendEvents([good, throwsMidParse], CONTRACT)
    expect(agg.events_examined).toBe(2)
    const total = agg.rows.reduce((n, r) => n + r.count, 0)
    expect(total).toBe(2) // exactly one bucket per event, no double-count
    expect(agg.rows.find(r => r.action === 'deposit')!.count).toBe(1)
    expect(agg.rows.find(r => r.action === 'other')!.count).toBe(1)
  })

  it('does not let a non-symbol payload containing "supply" spoof a deposit', () => {
    // ScString whose bytes literally contain "supply" — a byte-substring match
    // would misclassify this as a supply/deposit. Exact symbol match must not.
    const spoof = {
      contract_id: CONTRACT,
      topic1: xdr.ScVal.scvString('please_count_this_as_supply').toXDR('base64'),
      data: tuple(9_999_999n),
    }
    expect(eventName(spoof)).toBe('unknown')
    expect(classify(eventName(spoof))).toBe('other')
    const agg = aggregateBlendEvents([spoof], CONTRACT)
    expect(agg.rows.find(r => r.action === 'deposit')!.count).toBe(0)
    expect(agg.rows.find(r => r.action === 'other')!.count).toBe(1)
  })

  it('takes the amount from tuple position 0, not the first non-negative', () => {
    // data = (-1, 999): a first-non-negative scan would wrongly pick 999.
    const ev = { contract_id: CONTRACT, topic1: sym('borrow'), data: tuple(-1n, 999n) }
    const agg = aggregateBlendEvents([ev], CONTRACT)
    const borrow = agg.rows.find(r => r.action === 'borrow')!
    expect(borrow.count).toBe(1)
    // position 0 is negative → amount rejected, not silently replaced by 999
    expect(borrow.total_amount).toBe('0')
    expect(borrow.amount_samples).toBe(0)
  })
})
