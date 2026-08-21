#!/usr/bin/env bash
#
# deploy-channel-factory-mainnet.sh
#
# One-command MAINNET deploy of the one-way payment-channel WASM + the
# channel-factory contract, for the mpprouter "channel playground".
#
#   Contract source repo : ~/workspace/mpprouter/one-way-channel
#   Factory constructor  : __constructor(admin: Address, wasm_hash: BytesN<32>)
#   Factory.open(...)     : deploys a channel per (from,salt) using the stored hash
#
# ─── COST / NETWORK ──────────────────────────────────────────────────────────
#   * This deploys to STELLAR MAINNET (real XLM). NOT testnet.
#   * Total Soroban resource fees spent from your STELLAR_SOURCE account:
#       - upload channel.wasm           ~1-2 XLM
#       - upload channel_factory.wasm   ~1-2 XLM
#       - deploy factory (constructor)  ~1-2 XLM
#     => budget ~5-10 XLM in the source account before running.
#   * SEPARATELY, before go-live, the collector account
#         GBD64XFGJHG42CEVQKH4TYCIAMEHVBMW7A24KS22TKOSSA73IVW3CYIK
#     must be XLM-funded (~2-5 XLM) so it can be the recipient / pay its own
#     tx fees. This script does NOT touch the collector — fund it by hand.
#
# ─── USAGE ───────────────────────────────────────────────────────────────────
#   STELLAR_SOURCE=<your-stellar-cli-identity-name> \
#     ./scripts/admin/deploy-channel-factory-mainnet.sh
#
#   STELLAR_SOURCE must be the NAME of a key/identity already in your stellar
#   CLI config (`stellar keys ls`). Never a raw secret. The identity's public
#   key (G...) is used as the factory `admin`.
#
# Verified against: stellar 27.0.0 (Homebrew). See report / inline notes for
# the exact upload/deploy flag syntax that was confirmed via `--help`.
#
set -euo pipefail

# ── 0. Preconditions ─────────────────────────────────────────────────────────
: "${STELLAR_SOURCE:?STELLAR_SOURCE is required — set it to your stellar CLI identity NAME (see: stellar keys ls). Never a raw secret key.}"

NETWORK="mainnet"
CONTRACTS_REPO="${CONTRACTS_REPO:-$HOME/workspace/mpprouter/one-way-channel}"
COLLECTOR="GBD64XFGJHG42CEVQKH4TYCIAMEHVBMW7A24KS22TKOSSA73IVW3CYIK"

# cdylib output names: package "channel" -> channel.wasm ;
# package "channel-factory" -> channel_factory.wasm (hyphen -> underscore).
WASM_DIR="$CONTRACTS_REPO/target/wasm32v1-none/release"
CHANNEL_WASM="$WASM_DIR/channel.wasm"
FACTORY_WASM="$WASM_DIR/channel_factory.wasm"

command -v stellar >/dev/null 2>&1 || { echo "ERROR: stellar CLI not found on PATH." >&2; exit 1; }
[ -d "$CONTRACTS_REPO" ] || { echo "ERROR: contracts repo not found: $CONTRACTS_REPO" >&2; exit 1; }

echo "════════════════════════════════════════════════════════════════════"
echo "  Channel Factory — MAINNET deploy (mpprouter channel playground)"
echo "════════════════════════════════════════════════════════════════════"
echo "  stellar CLI      : $(stellar --version | head -n1)"
echo "  Network          : $NETWORK  (REAL XLM — budget ~5-10 XLM)"
echo "  Contracts repo   : $CONTRACTS_REPO"
echo "  Source identity  : $STELLAR_SOURCE"

# Resolve the admin public key (G...) from the identity name.
ADMIN_PUBKEY="$(stellar keys public-key "$STELLAR_SOURCE")"
case "$ADMIN_PUBKEY" in
  G*) : ;;
  *) echo "ERROR: could not resolve a G... public key for identity '$STELLAR_SOURCE' (got: '$ADMIN_PUBKEY')." >&2; exit 1 ;;
esac
echo "  Admin (from key) : $ADMIN_PUBKEY"
echo "  Collector (fund separately, ~2-5 XLM): $COLLECTOR"
echo ""

# ── 1. Build both WASMs ──────────────────────────────────────────────────────
echo "═══ Step 1/5: stellar contract build ═══"
( cd "$CONTRACTS_REPO" && stellar contract build )
[ -f "$CHANNEL_WASM" ] || { echo "ERROR: channel wasm not found after build: $CHANNEL_WASM" >&2; exit 1; }
[ -f "$FACTORY_WASM" ] || { echo "ERROR: factory wasm not found after build: $FACTORY_WASM" >&2; exit 1; }
echo "  channel wasm : $CHANNEL_WASM"
echo "  factory wasm : $FACTORY_WASM"
echo ""

# Helper: sanity-check a value looks like a 64-char hex wasm hash.
assert_hash() {
  case "$1" in
    ????????????????????????????????????????????????????????????????) : ;; # 64 chars
    *) echo "ERROR: '$2' does not look like a 64-hex wasm hash: '$1'" >&2; exit 1 ;;
  esac
}

# ── 2. Upload CHANNEL wasm → capture hash (this becomes PLAYGROUND_CHANNEL_WASM_HASH) ──
echo "═══ Step 2/5: stellar contract upload (channel wasm) ═══"
CHANNEL_WASM_HASH="$(stellar contract upload \
  --wasm "$CHANNEL_WASM" \
  --source-account "$STELLAR_SOURCE" \
  --network "$NETWORK")"
CHANNEL_WASM_HASH="$(printf '%s\n' "$CHANNEL_WASM_HASH" | tail -n1 | tr -d '[:space:]')"
assert_hash "$CHANNEL_WASM_HASH" "channel wasm hash"
echo "  ✅ CHANNEL WASM HASH = $CHANNEL_WASM_HASH"
echo ""

# ── 3. Upload FACTORY wasm → capture hash ────────────────────────────────────
echo "═══ Step 3/5: stellar contract upload (factory wasm) ═══"
FACTORY_WASM_HASH="$(stellar contract upload \
  --wasm "$FACTORY_WASM" \
  --source-account "$STELLAR_SOURCE" \
  --network "$NETWORK")"
FACTORY_WASM_HASH="$(printf '%s\n' "$FACTORY_WASM_HASH" | tail -n1 | tr -d '[:space:]')"
assert_hash "$FACTORY_WASM_HASH" "factory wasm hash"
echo "  ✅ FACTORY WASM HASH = $FACTORY_WASM_HASH"
echo ""

# ── 4. Deploy the FACTORY (constructor args) → capture contract address ───────
# Constructor: __constructor(admin: Address, wasm_hash: BytesN<32>)
# NOTE: the stellar CLI derives constructor arg flag names from the Rust
# parameter identifiers. In contracts/channel-factory/src/lib.rs the second
# parameter is literally named `wasm_hash`, so the flag is `--wasm_hash`
# (NOT `--channel_wasm_hash`, despite how the task was phrased). The value is
# the CHANNEL wasm hash captured in Step 2 (hex → BytesN<32>).
echo "═══ Step 4/5: stellar contract deploy (factory) ═══"
FACTORY_ADDRESS="$(stellar contract deploy \
  --wasm-hash "$FACTORY_WASM_HASH" \
  --source-account "$STELLAR_SOURCE" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_PUBKEY" \
  --wasm_hash "$CHANNEL_WASM_HASH")"
FACTORY_ADDRESS="$(printf '%s\n' "$FACTORY_ADDRESS" | tail -n1 | tr -d '[:space:]')"
case "$FACTORY_ADDRESS" in
  C*) : ;;
  *) echo "ERROR: factory deploy did not return a C... contract address (got: '$FACTORY_ADDRESS')." >&2; exit 1 ;;
esac
echo "  ✅ FACTORY ADDRESS = $FACTORY_ADDRESS"
echo ""

# ── 5. Summary — the two values to hand back ─────────────────────────────────
echo "════════════════════════════════════════════════════════════════════"
echo "  DEPLOY COMPLETE — mainnet"
echo "════════════════════════════════════════════════════════════════════"
echo "  Admin (factory)       : $ADMIN_PUBKEY"
echo "  Channel wasm hash     : $CHANNEL_WASM_HASH"
echo "  Factory wasm hash     : $FACTORY_WASM_HASH"
echo "  Factory contract addr : $FACTORY_ADDRESS"
echo "  Explorer              : https://stellar.expert/explorer/public/contract/$FACTORY_ADDRESS"
echo ""
echo "  ▼▼▼ Hand these two values back (paste into mpprouter config) ▼▼▼"
echo "PLAYGROUND_CHANNEL_WASM_HASH=$CHANNEL_WASM_HASH"
echo "PLAYGROUND_CHANNEL_FACTORY=$FACTORY_ADDRESS"
echo "  ▲▲▲"
echo ""
echo "  Reminder: before go-live, XLM-fund the collector account (~2-5 XLM):"
echo "    $COLLECTOR"
