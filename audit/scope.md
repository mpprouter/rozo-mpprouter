# Audit scope

This document defines what an external auditor is asked to review, what is
deliberately excluded, and why. It is vendor-neutral: it describes the
engagement, not any particular audit firm.

## Engagement 1 (current): smart contracts

### Baseline

| Item | Value |
| --- | --- |
| Repository | `mpprouter/one-way-channel` (fork of `stellar-experimental/one-way-channel`) |
| Branch | `v1` |
| Commit | `0cd229f95ccde9f178b17b6f5fc0b150b6000898` — **to be re-pinned at code freeze before the audit starts** |
| Upstream base | `25dea1b303495a7a4184af7605bbb7671ff08da6` (byte-identical up to that commit) |
| Chain | Stellar pubnet (Soroban) |
| Language | Rust |

### What the contracts do

A one-way payment channel: a funder deposits tokens once, then authorizes
many off-chain payments to a recipient by signing commitments for increasing
cumulative totals. Only open, settle, and close touch the chain. The funder
can always exit unilaterally (`close_start`, wait `refund_waiting_period`,
`refund`) without the recipient's cooperation.

On top of the upstream base we add:

1. **Channel modifications (~90 changed lines)** — storage TTL extension,
   partial settlement (`settle` without close), and a `Deposit` event.
2. **`account` crate (new, ours)** — a Soroban custom account
   (`CustomAccountInterface`) whose signer is a 20-byte EVM address.
   `__check_auth` reconstructs an EIP-191 `personal_sign` message from the
   Soroban authorization payload, runs `secp256k1_recover`, and compares the
   recovered address. This lets a user whose only key is an EVM browser
   wallet act as a channel's funder with full non-custodial exit rights.
3. **`account-factory` crate (new, ours)** — deterministic deployment where
   the salt is derived from the signer itself (no caller-supplied salt), so
   an address can never be front-run into existence with a different signer.

### In scope

| File | Raw lines | Origin |
| --- | --- | --- |
| `contracts/channel/src/lib.rs` | 652 | Upstream + our ~90-line delta |
| `contracts/channel/src/event.rs` | 68 | Upstream + our Deposit event |
| `contracts/channel-factory/src/lib.rs` | 104 | Upstream, unmodified |
| `contracts/account/src/lib.rs` | 187 | **Ours, new** |
| `contracts/account-factory/src/lib.rs` | 107 | **Ours, new** |

Tests (`contracts/*/src/test.rs`, ~1,240 lines total) are context, not audit
targets, but reviewers should note which negative cases exist: wrong signer,
tampered payload/signature, high-`s`, invalid recovery id, legacy `v`.

### Focus areas, ranked

1. **`account` signature verification.** EIP-191 message reconstruction,
   hex-encoding canonicality, `secp256k1_recover` usage, malleability
   (accepted `v` values, high-`s` rejection), and whether any payload two
   distinct wallets would sign differently can verify against the same
   stored signer. This is new cryptographic code and the reason this
   engagement exists.
2. **Our channel delta.** Partial settlement interacting with `close_start`
   / `close` / `refund` state transitions; TTL extension not resurrecting or
   extending a closed channel; Deposit event fidelity.
3. **`account-factory` deployment integrity.** Salt derivation binding
   address ⇔ signer; the pinned account WASM hash not being silently
   re-pointable.
4. **Upstream base.** Reviewed as-is; it has never been independently
   audited (the upstream README says so), and user deposits sit in it.

### Out of scope

| Area | Reason |
| --- | --- |
| The off-chain router (`mpprouter/rozo-mpprouter`) | Deferred to Engagement 2. ~26k lines of TypeScript iterating weekly; continuously covered by automated tooling in the meantime (see `README.md`). |
| TypeScript SDK / deposit watcher / settle bot | Not yet written; will accompany Engagement 2. |
| Soroban SDK, host functions, `mppx` client library | Third-party dependencies. |

### Build and test

```bash
make build   # or: stellar contract build
make test    # or: cargo test --workspace
cargo audit  # dependency advisories — run at the frozen commit
```

### Deliverable

An independent written report against the frozen commit on branch `v1`,
suitable for publication, findings severity-ranked with file/line references.

## Engagement 2 (deferred): off-chain router

A follow-up engagement covering the off-chain router
(`mpprouter/rozo-mpprouter`) is planned separately.

Do not commit service tokens, wallet keys, signed transaction envelopes, or
unpublished vendor reports to this directory.
