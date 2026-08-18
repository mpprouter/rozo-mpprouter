/**
 * Free-tier demo. No wallet, no API key, no money spent.
 *
 *   npm run demo:free
 *
 * Proves the two halves that cost nothing: catalog discovery and decoding a
 * live 402 challenge.
 */

import { ROUTER_BASE_URL, discoverServices, parse402, toUsd } from "./mpp-x402.js";

const MAX_PRICE_USD = 0.005;

async function main() {
  console.log(`Router: ${ROUTER_BASE_URL}\n`);

  console.log(`1. Discover  (free)  — services under $${MAX_PRICE_USD}/request`);
  const services = await discoverServices({
    query: "scrape web page markdown",
    limit: 3,
    maxPriceUsd: MAX_PRICE_USD,
  });
  for (const s of services) {
    console.log(`   ${s.price.padEnd(16)} ${s.method.padEnd(5)} ${s.public_path}`);
  }
  if (services.length === 0) throw new Error("no services matched");

  const target = services[0];
  const url = `${ROUTER_BASE_URL}${target.public_path}`;

  console.log(`\n2. Challenge (free)  — unpaid ${target.method} ${target.public_path}`);
  const res = await fetch(url, {
    method: target.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://stellar.org", formats: ["markdown"] }),
  });
  console.log(`   HTTP ${res.status}`);

  const challenge = await parse402(res);
  const requirement = challenge.accepts[0];
  console.log(`   x402Version   ${challenge.x402Version}`);
  console.log(`   scheme        ${requirement.scheme} on ${requirement.network}`);
  console.log(`   amount        ${requirement.amount} base units = $${toUsd(requirement.amount)}`);
  console.log(`   payTo         ${requirement.payTo}`);
  console.log(`   sponsored     ${requirement.extra?.areFeesSponsored}`);

  console.log("\nOK — discovery and 402 parsing verified. $0.00 spent.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
