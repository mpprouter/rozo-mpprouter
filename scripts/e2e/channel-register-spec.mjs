#!/usr/bin/env node
/**
 * mpp-spec §3.4 registration round trip against REAL pubnet.
 *
 *   open a channel through the factory (recording the salt)
 *   → negative registrations: bad salt, wrong `from`, unsigned (all 4xx)
 *   → spec-body registration { channel, commitmentKey, salt, from, signature }
 *   → one metered voucher call
 *   → close_start → wait the refund window → refund
 *
 * Usage (secret only from env, never an argument):
 *   STELLAR_SECRET=$(stellar keys show <identity>) STELLAR_CLI_SOURCE=<identity> \
 *     node scripts/e2e/channel-register-spec.mjs [--skip-close] [--api URL]
 *
 * STELLAR_CLI_SOURCE is the stellar CLI identity used as a refund fallback
 * when the SDK cannot decode the network's XDR.
 *
 * Net cost ≈ one metered call (~$0.03) + ~0.3 XLM gas; the deposit refunds.
 */

import { writeFileSync } from "node:fs";
import * as sdk from "@stellar/stellar-sdk";
import { Mppx } from "mppx/client";
import * as mpp from "@stellar/mpp/channel/client";

const args = process.argv.slice(2);
const apiIdx = args.indexOf("--api");
const API = apiIdx >= 0 ? args[apiIdx + 1] : "https://apiserver.mpprouter.dev";
const RPC = process.env.STELLAR_RPC_URL || "https://mainnet.sorobanrpc.com";
const FEE = "1000000";
const DEPOSIT_USD = "0.5";
const STATE_FILE = new URL("./channel-register-spec-state.json", import.meta.url).pathname;
const DOMAIN = "mpprouter.channel-register.v1";

const SECRET = process.env.STELLAR_SECRET?.trim();
if (!SECRET) {
  console.error("STELLAR_SECRET env var required");
  process.exit(1);
}
const funderKp = sdk.Keypair.fromSecret(SECRET);
const FUNDER = funderKp.publicKey();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const toBase = (usd) => {
  const [w, f = ""] = String(usd).split(".");
  return BigInt(w) * 10_000_000n + BigInt(f.padEnd(7, "0"));
};

async function getJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}
const post = (path, body) =>
  getJson(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const server = new sdk.rpc.Server(RPC);
async function submit(tx, label) {
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(funderKp);
  const hash = prepared.hash().toString("hex");
  log(`${label}: submitting tx ${hash}`);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") throw new Error(`${label} rejected: ${JSON.stringify(send.errorResult)}`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await server.getTransaction(hash).catch(() => null);
    if (st && st.status === "SUCCESS") { log(`${label}: SUCCESS ${hash}`); return { st, hash }; }
    if (st && st.status === "FAILED") throw new Error(`${label} FAILED on-chain (tx ${hash})`);
  }
  throw new Error(`${label} timed out (tx ${hash})`);
}

function signRegister({ channel, commitmentKey, saltHex, from }, kp) {
  const msg = [DOMAIN, channel, commitmentKey, saltHex.toLowerCase(), from].join("\n");
  return kp.sign(Buffer.from(msg, "utf8")).toString("base64");
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  const skipClose = args.includes("--skip-close");
  const { body: cfgRaw } = await getJson(`${API}/v1/playground/config`);
  const cfg = cfgRaw.channel;
  log("config:", cfg.factory_contract, "collector", cfg.channel_to, "period", cfg.refund_waiting_period);

  // ---- 0. The 402 OFFER (spec §3.4): an unknown agent's first call must be
  //         answered with a scheme:"channel" entry in accepts[] that names
  //         the same factory / collector / asset the config does.
  {
    const probe = await fetch(`${API}/v1/playground/channel/tx-decode?agent=${sdk.Keypair.random().publicKey()}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_hash: "00" }),
    });
    const hdr = probe.headers.get("payment-required");
    let offer = null;
    try { offer = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")).accepts.find((a) => a.scheme === "channel"); } catch {}
    check("402 carries channel offer", probe.status === 402 && !!offer
      && offer.extra?.factory === cfg.factory_contract && offer.payTo === cfg.channel_to && offer.asset === cfg.token_sac
      && offer.extra?.register === `${API}/v1/playground/channel/register` && offer.extra?.refundWaitingPeriodMinLedgers === cfg.refund_waiting_period,
      `status=${probe.status} offer=${JSON.stringify(offer)}`);
  }

  // ---- 1. OPEN through the factory ----
  const commitmentKp = sdk.Keypair.random();
  const salt = Buffer.from(sdk.Keypair.random().rawPublicKey());
  const saltHex = salt.toString("hex");
  const depositRaw = toBase(DEPOSIT_USD);
  const source = await server.getAccount(FUNDER);
  const openOp = new sdk.Contract(cfg.factory_contract).call(
    "open",
    sdk.nativeToScVal(salt, { type: "bytes" }),
    new sdk.Address(cfg.token_sac).toScVal(),
    new sdk.Address(FUNDER).toScVal(),
    sdk.nativeToScVal(Buffer.from(commitmentKp.rawPublicKey()), { type: "bytes" }),
    new sdk.Address(cfg.channel_to).toScVal(),
    sdk.nativeToScVal(depositRaw, { type: "i128" }),
    sdk.nativeToScVal(cfg.refund_waiting_period, { type: "u32" })
  );
  const built = new sdk.TransactionBuilder(source, { fee: FEE, networkPassphrase: cfg.network_passphrase })
    .addOperation(openOp).setTimeout(180).build();
  const { st, hash: openTx } = await submit(built, "open");
  const channel = sdk.scValToNative(st.returnValue);
  log("channel:", channel, "salt:", saltHex);
  const state = { channel, saltHex, commitmentSecret: commitmentKp.secret(), commitmentPublic: commitmentKp.publicKey(), openTx, networkPassphrase: cfg.network_passphrase };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  const tuple = { channel, commitmentKey: commitmentKp.publicKey(), saltHex, from: FUNDER };

  // ---- 2. NEGATIVE registrations ----
  const badSalt = "22".repeat(32);
  let r = await post("/v1/playground/channel/register", { ...tuple, salt: badSalt, signature: signRegister({ ...tuple, saltHex: badSalt }, funderKp) });
  check("bad salt → 4xx", r.status === 400 && r.body?.error === "address_mismatch", `${r.status} ${r.body?.error}`);

  const impostor = sdk.Keypair.random();
  r = await post("/v1/playground/channel/register", { ...tuple, from: impostor.publicKey(), salt: saltHex, signature: signRegister({ ...tuple, from: impostor.publicKey() }, impostor) });
  check("wrong from → 4xx", r.status === 400 && r.body?.error === "address_mismatch", `${r.status} ${r.body?.error}`);

  r = await post("/v1/playground/channel/register", { ...tuple, salt: saltHex });
  check("unsigned → 401", r.status === 401 && r.body?.error === "unauthenticated", `${r.status} ${r.body?.error}`);

  r = await post("/v1/playground/channel/register", { ...tuple, salt: saltHex, signature: signRegister(tuple, impostor) });
  check("signed by someone else → 401", r.status === 401, `${r.status} ${r.body?.error}`);

  // ---- 3. REGISTER (spec body) ----
  r = await post("/v1/playground/channel/register", { ...tuple, salt: saltHex, signature: signRegister(tuple, funderKp) });
  check("spec register → 200", r.status === 200 && r.body?.ok === true && r.body?.channel === channel, `${r.status} ${JSON.stringify(r.body)}`);
  if (r.status !== 200) throw new Error("register failed");

  r = await post("/v1/playground/channel/register", { ...tuple, salt: saltHex, signature: signRegister(tuple, funderKp) });
  check("re-register replays", r.status === 200 && r.body?.replayed === true, `${r.status} replayed=${r.body?.replayed}`);

  // ---- 4. VOUCHER CALLS ----
  const method = mpp.stellar.channel({ commitmentSecret: state.commitmentSecret, allowedChannels: [channel], rpcUrl: RPC });
  const client = Mppx.create({ methods: [method], polyfill: false });
  const cases = [
    ["voucher tx-decode", "/v1/playground/channel/tx-decode", { tx_hash: "9589ef539d04558edc048b88ca5205ac8ac30fadc97ec8d9eb66268e066fc254" }],
    ["voucher chat/deepseek", "/v1/playground/channel/chat", { model: "deepseek-v4-flash", messages: [{ role: "user", content: "Reply with exactly: PONG" }] }],
  ];
  for (const [name, path, body] of cases) {
    const res = await client.fetch(`${API}${path}?agent=${FUNDER}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    check(name, res.ok, `status=${res.status} charged=${out.charged_usd ?? "-"} ${String(out.message ?? out.summary ?? out.error ?? "").slice(0, 60).replace(/\n/g, " ")}`);
  }

  if (skipClose) { log("--skip-close: leaving channel open"); return; }

  // ---- 5. CLOSE_START → wait → REFUND ----
  const contract = new sdk.Contract(channel);
  const s1 = await server.getAccount(FUNDER);
  const { hash: closeTx } = await submit(
    new sdk.TransactionBuilder(s1, { fee: FEE, networkPassphrase: state.networkPassphrase }).addOperation(contract.call("close_start")).setTimeout(180).build(),
    "close_start"
  );
  const startLedger = (await server.getLatestLedger()).sequence;
  const target = startLedger + cfg.refund_waiting_period + 2;
  log(`waiting for ledger ${target} (~${Math.round((cfg.refund_waiting_period * 5.6) / 60)} min)…`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 20000));
    const now = (await server.getLatestLedger()).sequence;
    if (now >= target) break;
  }
  // refund via the SDK failed on 2026-09-15 with "unknown SorobanCredentialsType
  // member for value 2" (the pinned stellar-sdk XDR is older than the network
  // protocol), so retry the SDK path once and fall back to the stellar CLI,
  // which is what scripts/refund-stellar-channel.ts uses. Mainnet needs an
  // explicit inclusion fee or the CLI submission times out.
  let refundTx = "";
  try {
    const s2 = await server.getAccount(FUNDER);
    ({ hash: refundTx } = await submit(
      new sdk.TransactionBuilder(s2, { fee: FEE, networkPassphrase: state.networkPassphrase }).addOperation(contract.call("refund")).setTimeout(180).build(),
      "refund"
    ));
  } catch (err) {
    log("refund via SDK failed:", String(err).slice(0, 120));
    const cli = process.env.STELLAR_CLI_SOURCE;
    if (!cli) throw new Error("refund failed and STELLAR_CLI_SOURCE (stellar CLI identity name) not set; run: npm run refund-channel -- claim --channel " + channel + " --source <identity>");
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("stellar", ["contract", "invoke", "--id", channel, "--source-account", cli, "--network", "mainnet", "--fee", FEE, "--send=yes", "--", "refund"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("CLI refund failed: " + (r.stderr || "").slice(-300));
    refundTx = (r.stderr.match(/Signing transaction: ([0-9a-f]{64})/) || [])[1] || "cli";
    log("refund via stellar CLI: SUCCESS", refundTx);
  }
  writeFileSync(STATE_FILE, JSON.stringify({ done: true, channel, openTx, closeTx, refundTx, results }, null, 2));
  log("E2E COMPLETE:", results.every((x) => x.ok) ? "ALL PASSED" : "SOME FAILED", JSON.stringify(results));
}

main().catch((err) => { console.error("E2E FAILED:", err); writeFileSync(STATE_FILE, JSON.stringify({ failed: String(err), results }, null, 2)); process.exit(1); });
