/**
 * MPP Router as two Vercel AI SDK tools.
 *
 * `mppDiscover` is free and safe to let the model call freely.
 * `mppCall` spends real USDC, so it carries a hard price ceiling and an
 * optional recipient allowlist that the model cannot talk its way past.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  ROUTER_BASE_URL,
  discoverServices,
  payAndCall,
  priceUsd,
} from "./mpp-x402.js";

/**
 * The wallet secret is read from the environment ONCE, here, and closed over
 * by the tool. It is never a tool parameter — a model must never be able to
 * see, choose, or emit a signing key.
 */
function requireSecret(): string {
  const secret = process.env.STELLAR_SECRET;
  if (!secret) {
    throw new Error(
      "STELLAR_SECRET is not set. Export it from your shell or a .env file " +
        "that is git-ignored; never hard-code a Stellar secret key.",
    );
  }
  return secret;
}

export interface MppToolOptions {
  /** Hard per-call ceiling in USD. The model cannot raise it. */
  maxPriceUsd?: number;
  /** Cumulative ceiling in USD across every call these tools make. */
  budgetUsd?: number;
  /** If set, refuse any 402 whose recipient is not this address. */
  expectPayTo?: string;
  baseUrl?: string;
}

/**
 * Same-origin check. `startsWith` is NOT enough: the model supplies the URL,
 * and `https://apiserver.mpprouter.dev.attacker.example/...` passes a prefix
 * test while pointing at someone else's 402 server.
 */
function isSameOrigin(candidate: string, base: string): boolean {
  try {
    const a = new URL(candidate);
    const b = new URL(base);
    return (
      a.protocol === b.protocol && a.host === b.host && a.pathname.startsWith("/v1/")
    );
  } catch {
    return false;
  }
}

export function createMppTools(options: MppToolOptions = {}) {
  const maxPriceUsd = options.maxPriceUsd ?? 0.005;
  const baseUrl = options.baseUrl ?? ROUTER_BASE_URL;

  // Cumulative budget for the lifetime of this tool set. Lives in a closure,
  // so neither the model nor a tool argument can reset it. `stopWhen` caps
  // model STEPS, not paid calls — one step can emit several parallel tool
  // calls — so this is the only real aggregate bound.
  const budgetUsd = options.budgetUsd ?? maxPriceUsd * 5;
  let spentUsd = 0;

  const mppDiscover = tool({
    description:
      "Search the MPP Router catalog of pay-per-call APIs. Free. Returns the " +
      "endpoint path, HTTP method and per-request price. Always call this " +
      "before mppCall so you use the correct path and method.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("Keywords, e.g. 'web scrape markdown' or 'nft metadata'"),
      limit: z.number().int().min(1).max(10).default(3),
    }),
    execute: async ({ query, limit }) => {
      const services = await discoverServices({
        query,
        limit,
        maxPriceUsd,
        baseUrl,
      });
      return services.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        url: `${baseUrl}${s.public_path}`,
        method: s.method,
        price: s.price,
        priceUsd: priceUsd(s),
      }));
    },
  });

  const mppCall = tool({
    description:
      `Call a paid MPP Router endpoint. This SPENDS real USDC (max $${maxPriceUsd} ` +
      `per call, $${budgetUsd} total for this session) and settles on Stellar ` +
      "automatically. Use the exact url and method returned by mppDiscover.",
    inputSchema: z.object({
      url: z.string().url().describe("Full endpoint URL from mppDiscover"),
      method: z.enum(["GET", "POST"]).default("POST"),
      body: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("JSON request body, forwarded to the upstream API as-is"),
    }),
    execute: async ({ url, method, body }) => {
      if (!isSameOrigin(url, baseUrl)) {
        throw new Error(`Refusing to pay a non-Router URL: ${url}`);
      }
      // Reserve the worst case BEFORE calling. Reserving after would let
      // concurrent tool calls in one step each see an unspent budget.
      if (spentUsd + maxPriceUsd > budgetUsd) {
        throw new Error(
          `Budget exhausted: $${spentUsd.toFixed(4)} of $${budgetUsd} spent. ` +
            "Refusing further paid calls.",
        );
      }
      spentUsd += maxPriceUsd;

      const result = await payAndCall({
        url,
        method,
        body,
        stellarSecret: requireSecret(),
        maxPriceUsd,
        expectPayTo: options.expectPayTo,
      });
      // Settle the reservation against what was actually charged. Note that a
      // failed upstream call can still have settled — never refund the
      // reservation on an HTTP error alone.
      spentUsd += result.paidUsd - maxPriceUsd;

      if (result.status >= 400) {
        return {
          error: `HTTP ${result.status}`,
          detail: result.data,
          paidUsd: result.paidUsd,
          settlement: result.settlement,
          note:
            result.paidUsd > 0
              ? "This call was PAID despite the error. Do not retry it blindly."
              : undefined,
        };
      }
      return {
        paidUsd: result.paidUsd,
        budgetRemainingUsd: Number((budgetUsd - spentUsd).toFixed(6)),
        data: result.data,
      };
    },
  });

  return { mppDiscover, mppCall };
}
