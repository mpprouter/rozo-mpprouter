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
})
