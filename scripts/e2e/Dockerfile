# Railway cron service `mpprouter-charge-eval` — real-money provider
# charge suite, Mon + Thu 01:00 UTC. See docs/SOP-provider-e2e-test.md.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Payer: stellar-agent-wallet pay-per-call skill, pinned commit.
ARG WALLET_SKILL_REF=b56a8bfe0bb497b5f6b64edf26824385eb2102c4
RUN git clone --quiet https://github.com/mpprouter/stellar-agent-wallet-skill.git wallet \
 && cd wallet && git checkout --quiet ${WALLET_SKILL_REF} && npm ci --omit=dev --no-audit --no-fund
# Runner: only the e2e scripts from this repo (no wrangler/worker code).
COPY scripts/e2e/*.mjs /app/e2e/
ENV PAY_PER_CALL_DIR=/app/wallet/skills/pay-per-call
ENV MAX_AUTO_USD=0.10
CMD ["node", "/app/e2e/scheduled-run.mjs"]
