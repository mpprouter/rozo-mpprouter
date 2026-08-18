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
  /** If set, refuse any 402 whose recipient is not this address. */
  expectPayTo?: string;
  baseUrl?: string;
}

export function createMppTools(options: MppToolOptions = {}) {
  const maxPriceUsd = options.maxPriceUsd ?? 0.005;
  const baseUrl = options.baseUrl ?? ROUTER_BASE_URL;

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
      "per call) and settles on Stellar automatically. Use the exact url and " +
      "method returned by mppDiscover.",
    inputSchema: z.object({
      url: z.string().url().describe("Full endpoint URL from mppDiscover"),
      method: z.enum(["GET", "POST"]).default("POST"),
      body: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("JSON request body, forwarded to the upstream API as-is"),
    }),
    execute: async ({ url, method, body }) => {
      if (!url.startsWith(baseUrl)) {
        throw new Error(`Refusing to pay a non-Router URL: ${url}`);
      }
      const result = await payAndCall({
        url,
        method,
        body,
        stellarSecret: requireSecret(),
        maxPriceUsd,
        expectPayTo: options.expectPayTo,
      });
      if (result.status >= 400) {
        return { error: `HTTP ${result.status}`, detail: result.data };
      }
      return {
        paidUsd: result.paidUsd,
        data: result.data,
      };
    },
  });

  return { mppDiscover, mppCall };
}
