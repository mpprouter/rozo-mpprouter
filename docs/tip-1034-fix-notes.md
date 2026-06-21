# TIP-1034 Descriptor Fix — Investigation Notes

**Date:** 2026-06-21  
**Branch:** `fix/tip-1034-session-descriptor`  
**Symptom:** Session-mode providers (anthropic, openai, gemini, openrouter) fail downstream
Tempo payment with:
> `verification-failed: "descriptor required for TIP-1034 session action"`

---

## Root cause analysis

### mppx 0.4.12 → 0.7.0 breaking changes

**0.4.12** had a single `session()` method (from `tempo/client/Session.js`) that handled
both v1 (legacy contract-backed) and v2 (TIP-1034 precompile-backed) challenges in a
unified code path. Manual-mode vouchers only needed `{action, channelId, cumulativeAmountRaw}`.

**0.7.0** splits sessions into two separate methods:

| Export | Source | Handles | Descriptor required? |
|--------|--------|---------|----------------------|
| `sessionLegacy` | `tempo/legacy/client/Session.js` | `sessionProtocol === undefined \|\| 'v1'` | No |
| `session` (aka `sessionMethod`) | `tempo/session/client/Session.js` | `sessionProtocol === 'v2'` (TIP-1034) | **Yes** |

Merchants (anthropic, openai, gemini, openrouter) now advertise
`request.methodDetails.sessionProtocol: 'v2'` in their 402 challenge.

The old `session as tempoSession` we imported from `mppx/client` in 0.4.12 is now
`sessionLegacy` in 0.7.0. But since merchants now send v2 challenges, `sessionLegacy`'s
`canHandleChallenge` returns `false` (it only accepts v1). So we must use the new
TIP-1034 `session` (= `sessionMethod`) instead — but it requires a `descriptor` field
in the `onChallenge` context.

### What is `descriptor`?

The TIP-1034 `descriptor` is a struct computed at **channel open time** by
`createOpenPayload()` in `ChannelOps.js`. It contains:

```ts
{
  authorizedSigner: `0x${string}`  // signer address (usually == payer)
  expiringNonceHash: `0x${string}` // derived from the open transaction nonce
  operator: `0x${string}`          // 0x00...00 unless custom operator
  payee: `0x${string}`             // merchant address
  payer: `0x${string}`             // router wallet address
  salt: `0x${string}`              // random 32-byte salt from open
  token: `0x${string}`             // USDC token contract address
}
```

Together with `chainId` and `escrow`, the `descriptor` is what uniquely identifies a
TIP-1034 channel on-chain. Without it, the mppx client cannot produce a valid voucher
signature.

**The descriptor is NOT auto-derived from the challenge.** The merchant's 402 challenge
may include a `sessionSnapshot` hint (which carries a compressed descriptor), but the
hot-path manual mode requires us to supply it directly from the stored state. Auto-mode
via `sessionManager` can derive it from snapshots when present, but manual mode cannot.

### Why `descriptor` was missing from our KV state

The `TempoChannelState` type in `src/mpp/channel-store.ts` and the
`PersistedChannelState` type in `scripts/admin/open-tempo-channel.ts` did not include a
`descriptor` field. The `open-tempo-channel.ts` script used `sm.channelId`,
`sm.cumulative`, `sm.opened` — state properties of `sessionManager`, NOT `sessionClient`.
In 0.7.0, `tempo.session` is `sessionClient` (a Method, not a Manager), so those
properties do not exist on `tempo.session(...)`. The script needed to use
`tempo.session.manager(...)` to get a `sessionManager` instance.

Additionally, the `onChannelUpdate` entry in 0.7.0 includes `entry.descriptor` — we were
not persisting it.

---

## Fix summary

### Files changed

**`package.json`** — pins `mppx` to exact `"0.7.0"` (was `"latest"` = drifted to 0.4.12).

**`src/mpp/channel-store.ts`** — Added `descriptor` field to `TempoChannelState`.
This is the TIP-1034 channel descriptor object; stores the struct needed to sign vouchers.

**`src/mpp/tempo-client.ts`** — Multiple changes:
1. Import `sessionLegacy as legacySession` instead of `session as tempoSession`. The
   legacy session handles v1 challenges (backward compat) and is registered alongside the
   new TIP-1034 session.
2. Register `tempo.session({ account, onChannelUpdate })` (TIP-1034) in `Mppx.create`
   alongside the legacy session. This is what handles v2 challenges.
3. In `onChallenge` inside `payMerchantSession`: pass `descriptor` from the stored
   channel state in the `createCredential` context (v2 requires it). Also changed field
   name from `cumulativeAmountRaw` to `cumulativeAmount` (the TIP-1034 context accepts
   both, but the v2 path uses `cumulativeAmount` / `cumulativeAmountRaw`; we keep
   `cumulativeAmountRaw` since the schema still accepts it).
4. Updated `ChannelEntryLike` to include the `descriptor` field.

**`scripts/admin/open-tempo-channel.ts`** — Two changes:
1. Changed `tempo.session({...})` to `tempo.session.manager({...})` — in 0.7.0,
   `tempo.session` is a Method factory, not a SessionManager; the manager is accessed
   via `.manager`.
2. Added `descriptor` capture via an explicit `onChannelUpdate` callback passed to the
   manager, and persisted it to `PersistedChannelState`.

---

## Prod channels need re-opening

**YES — existing prod channels MUST be re-opened after deploying this fix.**

Reason: KV entries written by the pre-fix `open-tempo-channel.ts` do not contain a
`descriptor` field. The new `payMerchantSession` will see `channel.descriptor === undefined`
and the `createCredential` call will fail with the same "descriptor required" error.

Steps:
1. Deploy the new Worker code.
2. For each session merchant (anthropic_messages, openai_chat, gemini_generate,
   openrouter_chat), run:
   ```bash
   npx tsx scripts/admin/open-tempo-channel.ts <merchantId> --deposit <N>
   ```
   This overwrites the KV entry with a new channel that includes the `descriptor`.
3. Verify with `npx tsx scripts/admin/inspect-channels.ts` that the `descriptor` field
   is present in each entry.
4. Run the paid E2E retest (see `docs/SOP-provider-e2e-test.md`), specifically for
   anthropic and openai session merchants.

---

## Uncertainty / open questions

1. **`canHandleChallenge` with both methods registered**: When both `tempo.session`
   (TIP-1034, handles v2) and `sessionLegacy` (handles v1/undefined) are registered in
   `Mppx.create`, mppx will dispatch on `canHandleChallenge` correctly — v2 challenge
   goes to TIP-1034 session, v1/absent goes to legacy. This is the intended behavior per
   the 0.7.0 design. Confirmed by reading `client/Mppx.js`'s
   `AcceptPayment.selectChallengeCandidates` which calls `canHandleChallenge` on each
   registered method.

2. **`sessionProtocol` in current merchant challenges**: We confirmed the error message
   is `"descriptor required for TIP-1034 session action"` which is thrown by
   `planCredential()` in `CredentialState.js` only when `hasSessionAction(context)` is
   true but `hasManualSessionDescriptor(context)` is false. This means the TIP-1034
   method IS being reached (challenge has v2 protocol), and our context had `action` but
   no `descriptor`. After the fix, `descriptor` will be in context.

3. **`onChannelUpdate` callback with TIP-1034 `session()`**: In 0.7.0, the TIP-1034
   `session()` method calls `onChannelUpdate` via `createChannelCache(onChannelUpdate)`
   (in `CredentialState.js`), which fires after auto-mode opens/top-ups. Since we're in
   manual mode (we pass `action: 'voucher'` explicitly), the auto-open path is not taken
   — `onChannelUpdate` would only fire if the cache is updated. In manual mode the cache
   is updated via `updateCachedCumulative`, not `storeChannelEntry`, so `onChannelUpdate`
   may not fire on every manual voucher. Our hot-path `bumpCumulative` in
   `src/routes/proxy.ts` (called post-2xx) remains the authoritative KV updater — this
   is unchanged and still correct.

4. **`legacySession` backward compat for existing v1 channels**: If any channel was
   opened against a merchant that still advertises v1 (no `sessionProtocol` field), the
   legacy session method handles it. No change needed for those merchants.
