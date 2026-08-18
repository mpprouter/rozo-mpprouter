# Public settlement ledger — `GET /v1/ledger`

The router's paid activity is a public record. This endpoint is that record:
one row per settled call, unauthenticated and read-only, so anyone — an SCF
reviewer, a provider, an agent developer — can count the traffic and follow
any row to the Stellar transaction that settled it.

It is deliberately raw. There is no `/v1/usage`, no `/v1/stats`, no
aggregation: a paginated list can be re-aggregated by anyone downstream and
cannot go stale against a moving definition of "a useful metric".

Base URL: `https://apiserver.mpprouter.dev`

## Request

```
GET /v1/ledger?limit=<1-100>&cursor=<opaque>
GET /v1/ledger?tx=<64-hex Stellar transaction hash>
```

| Parameter | Meaning |
| --- | --- |
| `limit` | Rows per page. Integer, 1–100. Default 25; values above 100 are clamped to 100. A non-integer or `< 1` value is a `400`. |
| `cursor` | Opaque cursor taken verbatim from the previous response's `next_cursor`. Omit for the first page. |
| `tx` | Return the single entry settled by this transaction hash instead of a page. Must be 64 hex characters, otherwise `400`. Unknown hash is `404`. |

**Ordering is oldest-first** (`"order": "ts_asc"`). Order ids embed a
millisecond timestamp, and the underlying key-value store pages in
lexicographic key order, so chronological paging comes for free and never
skips or repeats a row while new ones are being appended at the end.

**Rate limit: 1 request per second, per client IP.** Over that, the endpoint
returns `429` with `Retry-After: 1`, and no storage is read at all. The
endpoint is public and unauthenticated, so this is the only wall against a
scraper; it is generous for a human or a reviewer's script.

The limit is enforced through a Durable Object compare-and-swap, not a
read-then-write on the key-value store: the latter has no conditional write
and is eventually consistent, so a parallel burst would all read the same
value and all proceed — the limit would exist only against sequential callers.
If the limiter itself is unavailable the endpoint fails **closed** with a
`503`; failing open would hand back the same bypass to anyone who can induce
an error.

## Response

```json
{
  "ok": true,
  "count": 2,
  "order": "ts_asc",
  "entries": [
    {
      "order_id": "ord_mf3k29b_7x2q9a1c",
      "ts": "2026-08-14T13:09:41.220Z",
      "service": "firecrawl_scrape",
      "payer": "GD5R4H...BB4U",
      "amount_usd": "0.002",
      "settlement_tx": "9f2c…64 hex…a1",
      "status": "delivered",
      "upstream_status": 200,
      "internal": null
    }
  ],
  "next_cursor": "mercury_order:ord_mf3k5xz_0b11ee42"
}
```

With `?tx=`, the payload is `{ "ok": true, "entry": { … same row … } }`.

| Field | Meaning |
| --- | --- |
| `order_id` | Stable id of this settlement record. |
| `ts` | When the call settled (ISO 8601, UTC). |
| `service` | Service slug — the same `id` used in `GET /v1/services/catalog`. |
| `payer` | Stellar `G…` address that paid, or `null` when the payment dialect did not expose it (see limitations). |
| `amount_usd` | Amount quoted for and charged for this call, in USD, as a decimal string. Router quotes are fixed at 402 time, so quoted and charged are the same number; if that ever diverges this field splits rather than silently changing meaning. |
| `settlement_tx` | Stellar transaction hash of the settlement, or `null` when settlement produced no hash. |
| `status` | `delivered` (upstream returned 2xx), `failed` (it did not), `refund_pending`, or `refund_unknown`. |
| `upstream_status` | HTTP status the upstream service returned. |
| `internal` | Whether this row is our own probe/test traffic. See below. |

`next_cursor` is `null` on the last page.

## What is deliberately not exposed

- **The upstream request path and query string.** It carries caller-supplied
  content — search terms, prompts, addresses being looked up. That is user
  data, not settlement data, and it stays internal.
- **Response bodies.** They were never stored in the first place.
- **Anything about router-held upstream credentials, merchant payout
  addresses, or revenue split.**

`payer` *is* exposed on purpose: it is a public Stellar address that already
appears in a public Stellar transaction, and counting distinct payers is the
whole point of a transparency ledger.

**Known tradeoff, accepted deliberately.** The Stellar transaction proves that
an address paid the router; it does not say *which service* the address
called. Publishing `payer` next to `service` therefore creates a linkage that
the chain alone does not — a behavioural profile of one address across
services. It is published anyway because a ledger that cannot be tied back to
verifiable on-chain payers cannot be audited, which is the entire purpose of
the endpoint. Callers who need unlinkability should pay from a fresh address
per service; the router never requires a reused one.

## The `internal` field

`internal` distinguishes our own probe/test traffic from real external users —
the distinction a reviewer needs in order to discount it.

**Today it is `null` on every row, meaning UNKNOWN.** The stored records carry
no internal/test marker and none was invented for this endpoint: a fabricated
flag would be worse than an honest absence. An operator can start classifying
by setting `LEDGER_INTERNAL_PAYERS` to a comma-separated list of our own
Stellar addresses; rows with a known `payer` then report `true`/`false`. Rows
with `payer: null` stay `null` regardless — there is nothing to match on.

## Coverage and limitations

- Every settled call through the paid proxy is recorded, on both the MPP
  (`WWW-Authenticate: Payment`) and x402 (`Payment-Required`) legs.
- **`payer` is `null` on the x402 leg.** That dialect carries the payer inside
  a signed XDR envelope that the router does not decode at settlement time.
  Those rows still carry `settlement_tx`, so the payer is recoverable from the
  Stellar transaction itself.
- Records are written after the response is sent, and are best-effort: a
  dropped write loses a row without failing the paid call it describes. The
  Stellar transaction remains the source of truth.
- Records expire 400 days after they are written.
- Rows written before the transaction index existed are not reachable by
  `?tx=` and must be found by paging.
- Playground (prepaid demo credit) traffic has its own ledger and is not part
  of this endpoint.
