/**
 * Paid demo WITHOUT a model — the tools' `execute` functions called directly.
 *
 *   STELLAR_SECRET=S... npm run demo:paid
 *
 * Spends real USDC on Stellar mainnet, capped at $0.005. Use this to verify
 * your wallet works before handing the tools to a model.
 */

import { createMppTools } from "./tools.js";

const MAX_PRICE_USD = 0.005;

async function main() {
  const { mppDiscover, mppCall } = createMppTools({ maxPriceUsd: MAX_PRICE_USD });

  const found = (await mppDiscover.execute!(
    { query: "scrape web page markdown", limit: 3 },
    { toolCallId: "1", messages: [] },
  )) as Array<{ url: string; method: string; price: string; id: string }>;

  const target = found[0];
  console.log(`Calling ${target.id} at ${target.price}`);

  const result = (await mppCall.execute!(
    {
      url: target.url,
      method: target.method as "GET" | "POST",
      body: { url: "https://stellar.org", formats: ["markdown"] },
    },
    { toolCallId: "2", messages: [] },
  )) as { paidUsd?: number; data?: unknown; error?: string; detail?: unknown };

  if (result.error) {
    console.error("Call failed:", result.error, result.detail);
    process.exit(1);
  }

  const preview = JSON.stringify(result.data).slice(0, 300);
  console.log(`Paid $${result.paidUsd} USDC`);
  console.log(`Result: ${preview}...`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
