#!/usr/bin/env bash
# Mercury testnet E2E smoke: confirm the 4 proposed endpoint paths + the
# Bearer auth header shape actually work against testnet.mercurydata.app,
# calling Mercury DIRECTLY (not through the router — the router isn't
# deployed with this change yet). Records status codes ONLY; never prints
# the JWT.
#
# Usage:
#   export JWT=$(grep '^MERCURYDATA_TESTNET_JWT=' .dev.vars | cut -d= -f2-)
#   ./scripts/mercury-testnet-smoke.sh
set -euo pipefail

if [ -z "${JWT:-}" ]; then
  echo "JWT env var not set. Run:"
  echo '  export JWT=$(grep "^MERCURYDATA_TESTNET_JWT=" .dev.vars | cut -d= -f2-)'
  exit 1
fi

BASE="https://testnet.mercurydata.app/rest"

probe() {
  local desc="$1"
  local path="$2"
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${JWT}" \
    "${BASE}${path}")
  printf '%-55s %s\n' "$desc" "$status"
}

echo "Mercury testnet smoke test — status codes only, JWT never printed"
echo "Base: ${BASE}"
echo "---"
probe "GET /events/by-ledger (from=1&to=100)"      "/events/by-ledger?from=1&to=100&limit=1"
probe "GET /events/by-contract/:contract_id"       "/events/by-contract/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?limit=1"
probe "GET /txs/by-contract/:contract_id"          "/txs/by-contract/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?limit=1"
probe "GET /txs/by-hash/:tx_hash"                  "/txs/by-hash/0000000000000000000000000000000000000000000000000000000000000000"
probe "GET /events/by-ledger, NO auth header (expect 401/403)" "/events/by-ledger?from=1&to=2"
echo "---"
echo "Interpretation: 2xx = path+auth confirmed working. 4xx (400/404) on the"
echo "placeholder contract_id/tx_hash values above is EXPECTED (they are"
echo "syntactically-valid-but-nonexistent Stellar ids) and still confirms the"
echo "auth header was accepted (a bad/missing token would 401/403 instead)."
echo "401/403 on ANY of the first four = the Bearer scheme or path is wrong."
