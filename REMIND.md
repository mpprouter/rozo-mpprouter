# REMIND — Channel Funds Operator Cheatsheet

> 这是给 operator 看的"我现在有哪些 channel、链上有多少钱、怎么充值"的速查表。
> 也可以用作未来 skill 的 source material（一键化操作）。

---

## API base URL

**Canonical**: `https://apiserver.mpprouter.dev`

This is the public custom domain that fronts the Cloudflare Worker.
All agent integrations, docs, and external links should use this
URL — NOT the internal `mpprouter.eng3798.workers.dev` workers.dev
default domain (which is what `wrangler deploy` prints, and what
operator scripts in this repo currently default to via
`ROUTER_URL`).

Both URLs route to the same worker:

```bash
# Production custom domain — give this to agents/users
curl -s https://apiserver.mpprouter.dev/services

# Internal workers.dev — what wrangler deploy prints
curl -s https://mpprouter.eng3798.workers.dev/services

# Both return identical content with the same Worker version
```

The `base_url` field returned by `/services` is hardcoded to
`https://apiserver.mpprouter.dev` (see `src/routes/services.ts`)
so even if an agent first finds the worker via the workers.dev
URL, the catalog directs them to the canonical domain.

The mppx HMAC realm in `src/mpp/stellar-server.ts` and
`src/mpp/stellar-channel-dispatch.ts` is also `apiserver.mpprouter.dev`,
so credentials issued under either hostname verify against the
same realm string.

---

## 0. 当前 session 模式只支持这 4 个 merchant (2026-04-11)

```
┌────────────────────┬──────────────────────────────────────┬───────────┬────────┐
│ merchant id        │ public path                          │ mode      │ status │
├────────────────────┼──────────────────────────────────────┼───────────┼────────┤
│ openrouter_chat    │ /v1/services/openrouter/chat         │ session   │ ✅    │
│ openai_chat        │ /v1/services/openai/chat             │ session   │ ✅    │
│ gemini_generate    │ /v1/services/gemini/generate?model=X │ session   │ ✅    │
│ tempo_rpc          │ /v1/services/tempo/rpc               │ session   │ ✅    │
└────────────────────┴──────────────────────────────────────┴───────────┴────────┘
```

**任何不在上面这 4 个 merchant 的请求**：要么走 charge 路径（router 自动 fallback），要么 broken。完整状态在 `internaldocs/v2-todo.md` 顶部的 "STATE OF THE WORLD" section。

`gemini_generate` 默认 model 是 `gemini-2.0-flash`；client 可以传 `?model=gemini-1.5-pro` override。`gemini-1.5-flash` 已经下线了，会 500。

**catalog API**：上面的状态也通过 `GET /services` 和 `GET /v1/services/catalog` 暴露 — 每条路由有 `verified_mode` 字段（`'session'` / `'charge'` / `false`）和 `verified_note`（broken 时给出原因）。Agent 可以做 `?verified_mode=session` 客户端过滤。

```bash
# 看哪些路由真的可用
curl -s https://apiserver.mpprouter.dev/services | jq '.services[] | {id, verified_mode, verified_note}'

# 只列出 session 模式可用的
curl -s https://apiserver.mpprouter.dev/services | jq '.services[] | select(.verified_mode == "session") | {id, public_path}'
```

---

Router 同时扮演两个角色：

```
                ┌─────────────────────┐
   agent ──────►│   ROZO MPP Router   │──────► merchant
   (Stellar)    │  (Cloudflare Worker)│       (Tempo)
                └─────────────────────┘
                  ↑                ↓
            stellar.channel    tempo.session
            (agent → router)   (router → merchant)
```

- **agent → router 的 Stellar channels**：每个 agent 自己 deploy 一个 Soroban
  one-way-channel 合约，把 XLM 或 USDC 锁进去，签 voucher 给 router。
- **router → merchant 的 Tempo channels**：router 用 TEMPO_ROUTER_PRIVATE_KEY
  自己开 escrow channel，锁 USDC 进去，签 voucher 给 8 个 session merchants
  （openrouter / anthropic / openai / gemini / dune / modal / alchemy / tempo
  rpc / storage_upload）。当前只有 `openrouter_chat` 真的开了。

---

## 1. 看一眼当前所有 channel 的状态

**唯一命令**（read-only，不会动链或 KV）：

```bash
npx tsx scripts/admin/inspect-channels.ts
```

**它会输出 4 个 section**：

1. **Pool balances (chain)** — Stellar pool 和 Tempo pool 的链上 USDC 余额。
   - Stellar pool = `STELLAR_ROUTER_PUBLIC` 在 Horizon 的 USDC 余额
   - Tempo pool = `TEMPO_ROUTER_ADDRESS` 在 Tempo L2 的 USDC 余额
2. **Tempo channels (router → merchant)** — 每个 merchant channel 的
   `deposit / cumulative / remaining`，以 6 位 USDC 为单位。
3. **Stellar channels (agent → router)** — 每个 agent channel 的
   `deposit / cumulative / remaining`，以 7 位 (stroops) 为单位。注意 XLM
   和 USDC SAC 都用 7 位。
4. **Position summary** — 简要汇总（V2.1 会做精确净仓 math）。

**怎么读**：
- "agent 给我们开了多少钱" = 第 3 节的 `TOTAL deposit`
- "我们给 8 个 section 服务开了多少钱" = 第 2 节的 `TOTAL deposit`
- "已经被花掉的" = 各自的 `cumulative`
- "channel 里还剩多少" = 各自的 `remaining`
- "链上 cash" = 第 1 节的两个 pool balance

**链上余额 vs channel 余额的关系**：
- Tempo 的 `deposit` 早就从 pool 转进 escrow 了，所以 `pool.balance` ≠
  `pool.balance + sum(channel.remaining)`。要算"router 总持币" = pool +
  Σ(每个 tempo channel 的 remaining)。
- Stellar 同理：agent 已经把钱锁进 channel 合约了，所以 router 的 Stellar
  pool 余额是从 charge-mode（非 channel）支付收来的，跟 channel deposit 不
  叠加。

---

## 2. Stellar channel — agent → router

### 2.1 已知的 channels (2026-04-11)

| label | agent G... | channel C... | currency | deposit |
| --- | --- | --- | --- | --- |
| agent1 | `GAK67E2Z…RQI7B7K7` | `CCMIWJE7…SE77S5CW` | native XLM | 0.1 XLM |
| agent2 | `GARVYIEY…E6GADZFE3G` | `CAYS2LBU…N6UW` | Circle USDC SAC | 0.1 USDC |
| agent3 | `GB5XRI6U…HE6FKMQFK` | `CAQGTDOJ…HVWC` | native XLM | 0.1 XLM |

权威列表跑 `inspect-channels.ts` 看实时数据。

### 2.2 给一个现有 channel 充值（agent 视角）

**脚本**：`scripts/admin/topup-stellar-channel.ts`

```bash
# 给 agent2 的 USDC channel 加 0.5 USDC（5,000,000 stroops，7 位精度）
npx tsx scripts/admin/topup-stellar-channel.ts \
  --channel CAYS2LBUNO4STPRWVJ6H4LOCSWGQCFINAWIHID2GX67UDK3EJ4JJN6UW \
  --amount 5000000 \
  --agent-env AGENT2_SECRET

# 给 agent3 的 XLM channel 加 0.5 XLM
npx tsx scripts/admin/topup-stellar-channel.ts \
  --channel CAQGTDOJKLWMLPY7BXP3TTCQONGME2JK3JE6MLII24XUDQQXZPX6HVWC \
  --amount 5000000 \
  --agent-env AGENT3_SECRET
```

**它做什么**：
1. 读取 `stellarChannel:<C>` KV 记录拿到现有 deposit + 验证 agent 匹配
2. `stellar contract invoke <C> -- top_up --amount <stroops>` (agent 签名)
3. 写回 KV 把 `depositRaw` 加上 amount

**只有 funder（原始 agent）能 topUp** —— 合约里 `from.require_auth()` 强制。

**先 dry-run**：`--dry-run` 会打印将做什么但不执行。

### 2.3 开新 channel（新 agent 加入）

```bash
# 1. 用 multi-agent-bootstrap 生成 keypair + 充 XLM/USDC trustline
npx tsx scripts/admin/multi-agent-bootstrap.ts

# 2. 给新 agent deploy channel + 注册到 router KV（一步搞定）
npx tsx scripts/admin/deploy-stellar-channel-for-agent.ts \
  --agent-env AGENT4_SECRET \
  --deposit 1000000   # 0.1 XLM
```

`--deposit` 单位是 stroops（1 XLM = 10^7 stroops）。USDC 通道也是 7 位精度。

### 2.4 关闭 channel（回收余额）

**目前没有自动化脚本**（在 v2-todo.md#B 里）。手动流程：
1. agent 调 `prepare_commitment(cumulative)` → 拿到要签的 bytes
2. agent 用 ed25519 私钥 sign
3. router 调用 `channel.close()` 广播 close 交易
4. 等待 100 ledger 的 refund waiting period
5. agent 调 `refund()` 拿回剩余

**警告**：close 不可逆。如果想 reopen 必须重新付 ~2 XLM gas。

---

## 3. Tempo channel — router → merchant

### 3.1 已知的 channels (2026-04-11)

| merchant id | service URL | channel 状态 |
| --- | --- | --- |
| `openrouter_chat` | `openrouter.mpp.tempo.xyz` | OPEN, $1 deposit |
| `anthropic_messages` | `anthropic.mpp.tempo.xyz` | NOT OPENED |
| `openai_chat` | `openai.mpp.tempo.xyz` | NOT OPENED |
| `gemini_generate` | `gemini.mpp.tempo.xyz` | NOT OPENED |
| `dune_execute` | `dune.mpp.tempo.xyz` | NOT OPENED |
| `modal_exec` | `modal.mpp.tempo.xyz` | NOT OPENED |
| `alchemy_rpc` | `alchemy.mpp.tempo.xyz` | NOT OPENED |
| `tempo_rpc` | `rpc.mpp.tempo.xyz` | NOT OPENED |
| `storage_upload` | `storage.mpp.tempo.xyz` | NOT OPENED |

打开未开的 8 个是 v2-todo.md#A 任务。

### 3.2 开一个新 merchant channel

**脚本**：`scripts/admin/open-tempo-channel.ts`

```bash
# Tempo pool 至少要有 (depositAmount + 0.05 gas) USDC
npx tsx scripts/admin/open-tempo-channel.ts openrouter_chat --deposit 1
npx tsx scripts/admin/open-tempo-channel.ts anthropic_messages --deposit 1
```

**它做什么**：
1. 用 `tempo.session({ maxDeposit })` auto mode probe merchant
2. mppx 自动构造 open transaction → broadcast → 等 settlement
3. 把 channel state 写到 KV `tempoChannel:<merchantId>`

**预算**：每个 merchant 1 USDC + 大约 0.04 USDC gas，总共 ~$8.4 USDC 开 8 个。

### 3.3 给现有 Tempo channel 充值

**目前没有专用脚本** — 因为 Tempo topup 协议要求 router 构造 viem
transaction → 走 merchant `verify` path，merchant 在链上 broadcast 之后 router
才更新本地 state。这是 v2-todo.md#B 配套要做的。

**手动 workaround**（任选一个）：
- **关闭并重开**：调用 close 把余额拿回 pool，再 `open-tempo-channel.ts`
  with 更大 deposit。受限于现在没有 close 脚本。
- **等到 channel 用完**：因为 router 充值流程现在没自动化，最简单是把
  initial deposit 开大一点（比如 $5 而不是 $1），channel 用完之前不用管。

如果以后真的需要"在线 topup"，需要写：
1. `topup-tempo-channel.ts` — 用 viem 构造 escrow.topUp(channelId, amount)
   transaction，然后通过 mppx manual mode `action: 'topUp'` 把 transaction
   交给 merchant verify path。参考
   `node_modules/mppx/dist/tempo/client/Session.js:200-211` 和
   `node_modules/mppx/dist/tempo/session/escrow.abi.js`。

### 3.4 关闭 Tempo channel（回收余额）

**目前没有自动化脚本**。同样是 v2-todo.md#B。

**手动**：用 mppx manual mode `action: 'close'`，参考
`Session.js:228-249`。Tempo 的 close 一步到位（没有 refund waiting
period），settled 部分给 merchant，剩余直接回 router pool。

---

## 4. 怎么验证 "router 是 broker，净仓 ≈ 0"

V2 的核心 invariant：router 不持币，只搬运。每个 session 请求会：

```
agent_voucher_amount  ≈  merchant_voucher_amount  ≈  0.00075 USDC
```

（XLM channel 走 FX rate 转换，0.00075 USDC ≈ 0.0048924 XLM at 0.1533 rate）

跑测试前后两次 `inspect-channels.ts`，对比：

| | 应该看到 |
| --- | --- |
| Stellar pool USDC | 不变（session voucher 是 off-chain） |
| Tempo pool USDC | 不变（session voucher 是 off-chain） |
| `tempoChannel:openrouter_chat.cumulative` | +0.00075 |
| `stellarChannel:<C>.cumulative` (agent2 USDC) | +0.00075 |
| `stellarChannel:<C>.cumulative` (agent1/3 XLM) | +0.0048924 (after FX) |

如果 charge mode（不是 session）：
- Stellar pool USDC | +charge price (因为 agent 真的转了 USDC 上链)
- Tempo pool USDC  | -charge price (router 真的付给 merchant)
- 两边互相抵消，net = 0

---

## 5. 重要的环境变量

| 变量 | 在哪 | 干什么 |
| --- | --- | --- |
| `STELLAR_ROUTER_PUBLIC` | `.dev.vars` + wrangler secret | router 收 USDC 的 G 地址 |
| `TEMPO_ROUTER_ADDRESS` | `.dev.vars` + wrangler secret | router 在 Tempo 的 0x 地址 |
| `TEMPO_ROUTER_PRIVATE_KEY` | `.dev.vars` + wrangler secret | router 付 merchant 的 0x 私钥 |
| `XLM_USD_RATE` | `wrangler.toml` `[vars]` | XLM/USD 固定汇率（V2.1 FX fix） |
| `MAINNET_PAYER_SECRET` | `stellar-mpp-sdk/.env.dev` | dogfood agent1 的 S 私钥 |
| `AGENT2_SECRET` / `AGENT3_SECRET` | 同上 | 多 agent dogfood 私钥 |

**`XLM_USD_RATE` 何时更新**：每当 XLM 价格波动 >5% 时。当前 `0.1533`
（2026-04-11 设置）。改完跑 `wrangler deploy`。

---

## 6. 一句话 cheat sheet

```bash
# 看现在所有钱在哪
npx tsx scripts/admin/inspect-channels.ts

# 给某个 stellar channel 充值
npx tsx scripts/admin/topup-stellar-channel.ts \
  --channel <C...> --amount <stroops> --agent-env <SECRET_KEY>

# 给某个 merchant 开新 tempo channel
npx tsx scripts/admin/open-tempo-channel.ts <merchantId> --deposit <usdc>

# 给新 agent 开 stellar channel
npx tsx scripts/admin/deploy-stellar-channel-for-agent.ts \
  --agent-env <SECRET_KEY> --deposit <stroops>

# 拿一个 agent 测端到端 session 路径
AGENT_ENV=AGENT2_SECRET ROUTER_URL=https://mpprouter.eng3798.workers.dev \
  npx tsx scripts/admin/test-stellar-channel.ts
```

---

## 7. 当某些事不工作时去哪看

| 症状 | 第一站 |
| --- | --- |
| 某个 agent 报 "Router does not recognize this agent" | 跑 `inspect-channels.ts` 看 stellar channels 列表，确认 stellarAgent:<G> 索引存在 |
| Tempo session 报 "ChannelNotInstalledError" | 确认 `tempoChannel:<merchantId>` KV 存在 |
| stellar topup 报 "Agent mismatch" | --agent-env 用错了 secret 文件里的变量名 |
| stellar topup CLI timeout | Stellar CLI 偶尔会在 simulate 后 broadcast 超时 — 用 `curl https://horizon.stellar.org/transactions/<hash>` 确认是否真的没上链，再决定要不要重试 |
| FX rate 不对，broker 在亏 | 跑 `inspect-channels.ts`，看 XLM channels 的 cumulative 是否 ≈ USDC 等价值除以 `XLM_USD_RATE` |
| 不知道某个 commit 改了什么 | `git log --oneline internaldocs/v2-*.md` 找最近的设计 doc |

---

## 8. 涉及到的文档

- `internaldocs/v2-session-session-done.md` — V2 §6 完整 working state
- `internaldocs/v2-todo.md` — 下一步任务队列（A/B/C/backlog）
- `internaldocs/v2-stellar-channel-notes.md` — Stellar channel 协议细节
- `internaldocs/v2-full-session-design.md` — 设计动机和 §7 broker math
