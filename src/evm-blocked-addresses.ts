/**
 * Known compromised / attacker / lookalike EVM addresses (lowercase). Leaf
 * module (imports nothing) so both the Bitrefill receiver check and the funder
 * tier resolver can read it without an import cycle.
 *
 * The retired funder RETIRED_FUNDER_ADDRESS_20261124 is not listed here: it
 * lives in src/funder-address.ts and every consumer checks it explicitly.
 * Append when a new compromised EVM address is known.
 */
export const EVM_BLOCKED_ADDRESSES: readonly string[] = [
  '0x0000000000000000000000000000000000000000',
  '0x8fe7155119d2975780c9e19b07dd98393965bc2a',
  '0xa9e3da13ef5eadfc6ecb2bb6bddde95016b567db',
  '0x5772fbe7a7817ef7f586215ca8b23b8dd22c8897',
  '0x44d6b5a11ffc5ba1043734d88af5e5dea36a648a',
  '0x467aed16d024405116cf4ba12976bf63b404517b',
  '0xf621ee3bae3cbe924ec05f795d14e31384bd11b6',
  '0x49cd5655cc9bf7c7c93fbb2df36aa3020d11eee0',
  '0xa9bace1614d6cff8aa159a2a41ee8baa9a91cc7b',
  '0xfd0e6fa2aba8436e95f3fb3523ac14ba299c0e79',
  '0x6706815c2dcce21c6d32720363faa967d092526d',
  '0x3707c8e98728502a7928007598e2b335eb7dbd33',
  '0xd3bedd444407a83b6fcd58fa43b72d546ae135ee',
  '0x6e708a532d777454f0910b756aedcce7c069cb46',
  '0x235248a78985cb2166c2d5b43d527ea09fc31739', // lookalike of the funder 0x2352...1739
  '0xaa5fe55b5e1225e9ba4d594c8b57eef61fce3d36',
  '0x4374b2072ff9bc5c0e263cae7866a41a4c601d29',
]
