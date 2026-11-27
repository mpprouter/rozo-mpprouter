/**
 * Regression: Stellar mainnet upgraded to protocol 30 at ledger 65633432
 * (2026-11-23 17:00:06 UTC). Protocol 30 ledger headers carry
 * StellarValueType = 3 (stellarValueSignedMs). @stellar/stellar-sdk <= 16.3.1
 * cannot decode it, so every `rpcServer.getLatestLedger()` inside
 * @stellar/mpp's charge verifier threw
 *   "XDR Read Error: unknown StellarValueType member for value 3"
 * and every Stellar-paid call looped on 402. This pins the SDK to a version
 * that decodes the new header shape.
 */
import { describe, expect, it } from 'vitest'
import { xdr } from '@stellar/stellar-sdk'

// Mainnet ledger 65698071 header_xdr from Horizon (2026-11-27), protocol 30.
const PROTOCOL_30_HEADER =
  'AAAAHvhCnkY3GoWnIFAIHyabDlSPx89i8ct+PVCc6kGm5tAjgix6+0HfJFbfz6iL3vTAUBnD3/s6ilKDiJP2D5LPN2QAAAAAawlfrAAAAAAAAAADAAABohyduLYAAAAAdhZAx0jTs+jpBMsrsOzNb3TPsBOgMztpOfxESXjaecEAAABAMhi+m0NOxx/voLSZeKJsFgRfda6C0wRsKPudA/6kz/9jsk0qaCFPuUmJozFSsFbKbjUidYBDlqdyXV4Hli3rCE4DORfJZdZaEyyDZVxGgmhuj4rJucEwSGh62hPyIHEd5BSEO3+zpSWUmBRPdx8kAKxUnnHgqG2pgsLu4gWjpOcD6nkXDqIes+x5W2EAAGUUVrgDMAAAARYAAAAAb1SwQQAAAGQATEtAAAAD6CpymcJSewbCZSzC/F8/ckyj9cL5Cl7SaROBtRLA6li2CcQPs4zkndg34IGxpI+qXFzmKPLPz5hPWfwAikG1hsEeAnklTYNSozmqiPokfpFZDlpRxy+ES269nJKCzGU8t34Tx2EmkiOkdQW3vG3aDWviGzPDZNvk37cyFbMqTL+xAAAAAA=='

describe('Stellar protocol 30 XDR', () => {
  it('decodes a protocol 30 ledger header with stellarValueSignedMs', () => {
    const header = xdr.LedgerHeader.fromXDR(PROTOCOL_30_HEADER, 'base64')
    expect(header.ledgerVersion()).toBe(30)
    expect(header.ledgerSeq()).toBe(65698071)
    expect(header.scpValue().ext().switch().name).toBe('stellarValueSignedMs')
  })
})
