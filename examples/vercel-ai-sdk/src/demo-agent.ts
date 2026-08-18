/**
 * Full agent demo: an LLM decides what to buy and buys it.
 *
 *   OPENAI_API_KEY=sk-... STELLAR_SECRET=S... npm run demo:agent
 *
 * The model sees two tools. It has no idea a wallet exists — the secret is
 * closed over inside the tool, and the price ceiling is enforced in code, not
 * in the prompt.
 */

import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { createMppTools } from "./tools.js";

async function main() {
  const tools = createMppTools({ maxPriceUsd: 0.005 });

  const { text, steps } = await generateText({
    model: openai("gpt-4o-mini"),
    tools,
    stopWhen: stepCountIs(6),
    system:
      "You buy data from paid APIs on behalf of the user. Always call " +
      "mppDiscover first to find an endpoint and its exact HTTP method, then " +
      "call mppCall once. Never guess a URL.",
    prompt:
      "Scrape https://stellar.org and tell me in two sentences what Stellar " +
      "says it is for.",
  });

  const spent = steps
    .flatMap((s) => s.toolResults)
    .reduce((sum, r) => sum + Number((r.output as { paidUsd?: number })?.paidUsd ?? 0), 0);

  console.log(text);
  console.log(`\n[spent $${spent.toFixed(4)} USDC across ${steps.length} steps]`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
