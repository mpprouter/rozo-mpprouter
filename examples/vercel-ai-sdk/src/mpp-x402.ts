/**
 * MPP Router payment core — framework-agnostic.
 *
 * Three functions, no agent framework imported:
 *
 *   discoverServices()  GET /services, filter the public catalog     (free)
 *   parse402()          decode the x402 `Payment-Required` challenge (free)
 *   payAndCall()        402 -> sign a Stellar USDC transfer -> retry (costs money)
 *
 * Wire format: x402 `exact` over Stellar, sponsored fees. The Router also
 * emits an `WWW-Authenticate: Payment ...` (MPP dialect) header describing the
 * same charge; this file deliberately speaks only x402 so it needs nothing
 * beyond @stellar/stellar-sdk.
 *
 * SECRETS: the Stellar secret key is read from the environment by the caller
 * and passed in as a function argument. It is used to build one Keypair, held
 * for the duration of the signature, and never logged, stored, or returned.
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

export const ROUTER_BASE_URL =
  process.env.MPP_ROUTER_URL ?? "https://apiserver.mpprouter.dev";

const DEFAULT_RPC_URL =
  process.env.STELLAR_RPC_URL ?? "https://mainnet.sorobanrpc.com";

/**
 * Placeholder source account for the sponsored simulation. The Router's
 * facilitator rebuilds the envelope with its own source (and pays the fee)
 * before submitting, so this value never reaches the ledger.
 */
const ALL_ZEROS_PUBKEY =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * The only assets we will ever sign a transfer for, per network. A 402
 * challenge controls the `asset` field, so without this pin a hostile or
 * compromised endpoint could name any token — a governance token, an NFT-ish
 * SAC — and our USD ceiling, which assumes USDC's 7 decimals, would be
 * meaningless. Signing is refused for anything not listed here.
 */
export const ALLOWED_ASSETS: Record<string, string> = {
  // Circle USDC (issuer GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN)
  "stellar:pubnet": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
};

/** Stellar closes a ledger in ~5.5s. Rounding UP shortens the validity
 * window we ask for, which is the safe direction: a verifier rejects an
 * auth entry that reaches further than its own limit. */
const CONSERVATIVE_LEDGER_CLOSE_SECONDS = 6;

// ---------------------------------------------------------------- discovery

export interface CatalogService {
  id: string;
  name: string;
  description: string;
  /** Path to append to the Router base URL, e.g. /v1/services/firecrawl/scrape */
  public_path: string;
  /** Authoritative HTTP method. Most services are POST-only; never assume GET. */
  method: string;
  /** Human string, e.g. "$0.002/request". */
  price: string;
  status: string;
  categories?: string[];
}

export interface DiscoverOptions {
  query: string;
  limit?: number;
  /** Skip anything priced above this, in USD. Entries with a non-numeric
   * (dynamic) price are dropped when this is set. */
  maxPriceUsd?: number;
  baseUrl?: string;
}

/** Free: read the public catalog and keyword-filter it. No payment, no key. */
export async function discoverServices(
  opts: DiscoverOptions,
): Promise<CatalogService[]> {
  const baseUrl = opts.baseUrl ?? ROUTER_BASE_URL;
  const res = await fetch(`${baseUrl}/services`);
  if (!res.ok) {
    throw new Error(`Catalog fetch failed: HTTP ${res.status}`);
  }
  const catalog = (await res.json()) as { services: CatalogService[] };

  const terms = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = catalog.services
    .filter((s) => s.status !== "unavailable")
    .filter((s) => {
      if (opts.maxPriceUsd === undefined) return true;
      const price = priceUsd(s);
      return price !== null && price <= opts.maxPriceUsd;
    })
    .map((s) => {
      const hay = [s.id, s.name, s.description, ...(s.categories ?? [])]
        .join(" ")
        .toLowerCase();
      return { s, score: terms.filter((t) => hay.includes(t)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (priceUsd(a.s) ?? 1) - (priceUsd(b.s) ?? 1));

  return scored.slice(0, opts.limit ?? 5).map((x) => x.s);
}

/** Parse "$0.002/request" -> 0.002. Returns null for dynamic/range prices. */
export function priceUsd(service: CatalogService): number | null {
  const m = /^\$([0-9]*\.?[0-9]+)\s*\/\s*request$/.exec(service.price.trim());
  return m ? Number(m[1]) : null;
}

// ------------------------------------------------------------- 402 challenge

export interface PaymentRequirements {
  scheme: "exact";
  network: "stellar:pubnet" | "stellar:testnet";
  /** Base units (USDC has 7 decimals on Stellar): "20000" == $0.002. */
  amount: string;
  /** Stellar Asset Contract address for the token. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { areFeesSponsored?: boolean };
}

export interface Challenge {
  x402Version: number;
  accepts: PaymentRequirements[];
}

/**
 * Free: decode the x402 challenge from a 402 response. Header first
 * (`Payment-Required`), falling back to the JSON body used by older
 * x402 servers.
 */
export async function parse402(res: Response): Promise<Challenge> {
  const header = res.headers.get("payment-required");
  if (header) {
    return JSON.parse(
      Buffer.from(header, "base64").toString("utf8"),
    ) as Challenge;
  }
  const body = (await res.clone().json()) as Partial<Challenge>;
  if (body?.accepts?.length) return body as Challenge;
  throw new Error("402 response carried no x402 challenge");
}

/** Base units -> human USD string, for logs and confirmation prompts. */
export function toUsd(amountBaseUnits: string, decimals = 7): number {
  return Number(amountBaseUnits) / 10 ** decimals;
}

// ----------------------------------------------------------------- signing

/**
 * Sign a Soroban SAC `transfer(from, to, amount)` in sponsored mode: the
 * source account is a zero placeholder and only the Soroban auth entries
 * carry our signature, so the facilitator can fee-bump and submit it.
 */
async function signSacTransfer(
  secret: string,
  req: PaymentRequirements,
  rpcUrl: string,
): Promise<{ transactionXdr: string; signerPubkey: string }> {
  const keypair = Keypair.fromSecret(secret);
  const networkPassphrase =
    req.network === "stellar:pubnet" ? Networks.PUBLIC : Networks.TESTNET;
  const server = new rpc.Server(rpcUrl, { allowHttp: false });
  const signerPubkey = keypair.publicKey();

  const op = new Contract(req.asset).call(
    "transfer",
    nativeToScVal(Address.fromString(signerPubkey), { type: "address" }),
    nativeToScVal(Address.fromString(req.payTo), { type: "address" }),
    nativeToScVal(BigInt(req.amount), { type: "i128" }),
  );

  const builtTx = new TransactionBuilder(new Account(ALL_ZEROS_PUBKEY, "0"), {
    fee: "0",
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(req.maxTimeoutSeconds)
    .build();

  const sim = await server.simulateTransaction(builtTx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  if (!sim.result?.auth) {
    throw new Error("Simulation returned no auth entries");
  }

  const validUntilLedger =
    sim.latestLedger +
    Math.ceil(req.maxTimeoutSeconds / CONSERVATIVE_LEDGER_CLOSE_SECONDS);

  const signedAuth = await Promise.all(
    sim.result.auth.map((entry: xdr.SorobanAuthorizationEntry) =>
      authorizeEntry(entry, keypair, validUntilLedger, networkPassphrase),
    ),
  );

  // Patch the signed auth entries onto the host-function op. The high-level
  // Operation object has no re-serializing setter, so go through the envelope.
  const envelope = rpc.assembleTransaction(builtTx, sim).build().toEnvelope();
  envelope.v1().tx().operations()[0].body().invokeHostFunctionOp().auth(signedAuth);

  return { transactionXdr: envelope.toXDR("base64"), signerPubkey };
}

// ------------------------------------------------------------- pay and call

export interface PayAndCallOptions {
  url: string;
  method?: string;
  body?: unknown;
  /** Stellar secret key (S...). Read it from the environment — never inline. */
  stellarSecret: string;
  rpcUrl?: string;
  /** Refuse to sign anything above this, in USD. Always set it. */
  maxPriceUsd: number;
  /** Refuse to sign if the challenge names a different recipient. Set it from
   * the catalog or /health when you have it. */
  expectPayTo?: string;
  /** Override the per-network asset pin. Defaults to `ALLOWED_ASSETS`. */
  allowedAssets?: Record<string, string>;
}

export interface PayAndCallResult {
  status: number;
  /** Parsed JSON when the service returns JSON, raw text otherwise. */
  data: unknown;
  /** What we actually paid, in USD. 0 only when nothing settled. */
  paidUsd: number;
  /** Whether the transfer settled, independent of the upstream HTTP status. */
  settlement?: "settled" | "failed" | "not-settled";
  /** Stellar transaction hash of the settled transfer, when the Router reports one. */
  settlementTx?: string;
  payTo?: string;
  /** Router-issued receipt header, when present. */
  receipt?: string;
}

/**
 * Call a 402-gated MPP Router endpoint, paying once if challenged.
 *
 * 1. Plain request.  2. On 402, decode the challenge.  3. Check it against
 * your own price/recipient limits.  4. Sign.  5. Retry with `Payment-Signature`.
 *
 * The payment credential is single-use and bound by the Router to this exact
 * amount and recipient. If the retry fails, do NOT replay it — start over.
 */
export async function payAndCall(
  opts: PayAndCallOptions,
): Promise<PayAndCallResult> {
  const method = opts.method ?? "POST";
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
  };

  const first = await fetch(opts.url, init);
  if (first.status !== 402) {
    return { status: first.status, data: await readBody(first), paidUsd: 0 };
  }

  const challenge = await parse402(first);
  const requirement = challenge.accepts.find(
    (a) => a.scheme === "exact" && a.network.startsWith("stellar:"),
  );
  if (!requirement) {
    throw new Error("No Stellar `exact` payment option in the 402 challenge");
  }
  if (requirement.extra?.areFeesSponsored === false) {
    throw new Error("Router advertised areFeesSponsored=false; unsupported");
  }

  // --- guards. Without these, a hostile 402 can name any asset, recipient
  // and price. Check the ASSET FIRST: every downstream number, including the
  // USD ceiling below, assumes USDC's 7 decimals.
  const allowed = opts.allowedAssets ?? ALLOWED_ASSETS;
  const pinnedAsset = allowed[requirement.network];
  if (!pinnedAsset || requirement.asset !== pinnedAsset) {
    throw new Error(
      `Refusing to sign: challenge asset is not the pinned asset for ${requirement.network}`,
    );
  }

  const priceUsdValue = toUsd(requirement.amount);
  if (priceUsdValue > opts.maxPriceUsd) {
    throw new Error(
      `Refusing to pay $${priceUsdValue}: above the $${opts.maxPriceUsd} ceiling`,
    );
  }
  if (opts.expectPayTo && requirement.payTo !== opts.expectPayTo) {
    throw new Error(
      `Refusing to pay: challenge recipient does not match the expected address`,
    );
  }

  const { transactionXdr } = await signSacTransfer(
    opts.stellarSecret,
    requirement,
    opts.rpcUrl ?? DEFAULT_RPC_URL,
  );

  // x402 v2 echoes back the exact requirement object that was accepted;
  // servers compare it field-by-field, so pass the parsed object through.
  const payload =
    challenge.x402Version >= 2
      ? {
          x402Version: challenge.x402Version,
          accepted: requirement,
          payload: { transaction: transactionXdr },
        }
      : {
          x402Version: challenge.x402Version,
          scheme: "exact" as const,
          network: requirement.network,
          payload: { transaction: transactionXdr },
        };

  const paid = await fetch(opts.url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      // x402 v2 header. The Router also accepts the older
      // `Authorization: Payment <base64>` form; it does NOT read `X-Payment`.
      "Payment-Signature": Buffer.from(
        JSON.stringify(payload),
        "utf8",
      ).toString("base64"),
    },
  });

  // Settlement is INDEPENDENT of the upstream HTTP status. A 5xx from the
  // upstream API can still follow an accepted, settled transfer, so
  // `paid.ok === false` does NOT mean the money stayed put. Read the Router's
  // settlement headers and treat "unknown" as spent, never as free — the
  // expensive mistake here is retrying a call you already paid for.
  const settleStatus = paid.headers.get("x-payment-settle-status");
  const settled =
    settleStatus === "settled" ||
    (settleStatus === null && paid.status !== 402);

  return {
    status: paid.status,
    data: await readBody(paid),
    paidUsd: settled ? priceUsdValue : 0,
    settlement:
      settleStatus === "failed"
        ? "failed"
        : settled
          ? "settled"
          : "not-settled",
    settlementTx: paid.headers.get("x-payment-tx") ?? undefined,
    payTo: requirement.payTo,
    receipt: paid.headers.get("payment-receipt") ?? undefined,
  };
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
