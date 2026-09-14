# MPP Router — Provider E2E Test Suite

> **目的**：用一套脚本对 MPP Router 转售的核心 provider 做端到端验证 —— 既能零成本探测报价层，也能真金跑通整条结算链路（客户付 Stellar USDC → Router → Tempo 付下游 merchant → 返回结果）。
>
> **风险等级**：真金测试 = **HIGH（动钱）**。每笔 $0.001–$0.06 USDC + Stellar 手续费，全套 < $1。
>
> 配套：通用排查流程见 [`SOP-provider-e2e-test.md`](./SOP-provider-e2e-test.md)（责任判定表的权威来源）。

---

## 1. 覆盖的 provider（10 个，两类）

| 类别 | provider | publicPath | 模式 | 单笔价 |
|---|---|---|---|---|
| **AI inference** | OpenAI | `/v1/services/openai/chat` | session* | 动态 |
| | Anthropic | `/v1/services/anthropic/messages` | session* | 动态 |
| | OpenRouter | `/v1/services/openrouter/chat` | session* | 动态 |
| | Google Gemini | `/v1/services/gemini/generate` | session* | 动态 |
| | DeepSeek | `/v1/services/deepseek/chat` | charge | ~$0.004–0.025 |
| | Groq | `/v1/services/groq/chat` | charge | ~$0.005–0.10 |
| **Blockchain / data** | Alchemy | `/v1/services/alchemy/rpc` | charge | $0.000 |
| | Dune | `/v1/services/dune/execute` | session* | 动态 |
| | CoinGecko | `/v1/services/coingecko/simple-price` | charge | $0.06 |
| | QuickNode | `/v1/services/quicknode/rpc` | charge | $0.001 |

\* `session` 列出的是 upstream 默认 payment method。**但 catalog 对所有路由只对外广告 `charge` intent**（见 `merchants.ts:stellarIntentsFor`）——客户始终用单发 charge 付款，Router 内部处理下游 session dance。所以 E2E 客户端永远走 charge。

DeepSeek / Groq / CoinGecko / QuickNode 的简洁 publicPath 由 `OPERATOR_OVERLAY` 提供（2026-06-22 新增），需 **部署后** 才在生产生效。其余 6 个早已上线。

---

## 2. 需要什么（前置）

1. **测试钱包**：`rozoskilltest/.env` 的 `STELLAR_PRIVATE_KEY`（公钥 `GAN3YS...4UYY`）。Stellar 主网需有 USDC 余额（≥ $1）+ XLM reserve。查余额（地址 mask）：
   ```bash
   ADDR=$(grep '^STELLAR_ADDRESS=' .../rozoskilltest/.env | cut -d= -f2-)
   curl -s "https://horizon.stellar.org/accounts/$ADDR" | jq '.balances[] | select(.asset_code=="USDC")'
   ```
2. **pay-per-call skill**：`stellar-agent-wallet` 插件（自动从 `~/.claude/plugins/cache/mpprouter/stellar-agent-wallet/<ver>/` 解析最新版）。它处理 402→签名→重试。
3. **Router base**：`https://apiserver.mpprouter.dev`（公开）。
4. **Node ≥ 18**（用了 `node:fs` 的 `globSync`，建议 22）。

### 🔒 密钥纪律

- 测试脚本从 `.env` 提取 S-key 到 `0600` 临时文件，**用完 `finally` 删除**，全程不打印 key。
- 对话/日志里地址一律 mask（前6+后4）。
- **绝不** `source .env`。

---

## 3. 怎么测

### Step 1 — 零成本探测（不花钱，先跑）

确认每个 provider 的路由存在、Router 能签发 402 charge challenge（报价层健康）。**验不了下游结算**。

```bash
node scripts/e2e/probe-402.mjs            # 全部 10 个
node scripts/e2e/probe-402.mjs openai deepseek   # 子集
```

读结果：
- `✅ QUOTE_OK intent=charge` → 报价层正常。
- `❌ NO_ROUTE` → 路由没注册（新 provider 未部署，或路径写错 → 检查 overlay）。
- `❌ ROUTER_5XX` → Router 入站层就坏了，先查 Router 本身。

### Step 2 — 真金 charge（动钱，判定责任）

```bash
node scripts/e2e/charge-e2e.mjs                   # 全部
node scripts/e2e/charge-e2e.mjs coingecko quicknode  # 子集
MAX_AUTO_USD=0.10 node scripts/e2e/charge-e2e.mjs    # 调每笔自动付上限
```

- stdout = 机器可读 JSON 报告（`{ base, ts, results: [{id, verdict, blame, detail}] }`）。
- stderr = 逐 provider 进度 + 汇总。
- exit 0 = 全 PASS；非 0 = 有失败。

### 责任判定（脚本自动分类，权威表在 SOP §3）

| verdict / blame | 含义 | 责任 |
|---|---|---|
| `PASS` | 200 + 合法 upstream body，全链路通 | ✅ |
| `PASS_WEAK` | 200 但 body 形状意外，需人工看 | ⚠️ 人工 |
| `FAIL/us` (descriptor required) | voucher 缺 TIP-1034 descriptor | **我们**（mppx 旧） |
| `FAIL/us` (channel not installed / underfunded) | session channel 没开 / deposit 耗尽 | **我们**（运营） |
| `FAIL/us` (pool insufficient) | Router pool 钱不够 | **我们**（充值） |
| `FAIL/merchant` (502 + 5xx) | 我们付款成功，merchant 自己 500 | **merchant** |
| `FAIL/unknown` | 未匹配，看 detail | 人工排查 |

> 关键：merchant 5xx → Router 映射成 **502**；**503 只来自我们这边**（channel 未开 / pool 不足）。

---

## 4. 并行跑（subagent）

10 个 provider 互相独立，可以用 subagent 并行加速。每个 subagent 跑一个 provider 的 `charge-e2e.mjs <id>`，回收 JSON verdict。注意：它们共用同一个测试钱包 + 同一个临时密钥提取逻辑，并发付款没有 nonce 冲突（每笔是独立 Stellar 交易），但**总花费 = 各 provider 单价之和**，跑前确认在预算内。

---

## 5. 跑完之后

1. 报告写入 `docs/e2e-results-<YYYY-MM-DD>.md`。
2. 登记 ainative `analytics_log`：
   ```bash
   cd ~/workspace/ainative
   python3 scripts/analytics_log.py add --title "MPP Router 10-provider E2E" \
     --summary "一行结论" --report docs/... --tags mpprouter,e2e-test
   ```
3. 若判定是**我们的 bug**：开 todo / Trello，标 high-risk，修复走 codex review + 本 suite 复测。
4. 把 verifiedMode 结果回填 `OPERATOR_OVERLAY`（哪些 provider 确认 charge 通）。

---

## 6. 文件清单

```
scripts/e2e/
├── providers.mjs      # 单一事实源：10 个 provider 的 path + 最轻 body + okCheck
├── probe-402.mjs      # Step 1 零成本探测
└── charge-e2e.mjs     # Step 2 真金 charge + 责任判定
docs/
├── e2e-provider-suite.md   # 本文件
└── SOP-provider-e2e-test.md # 通用排查 SOP（责任表权威）
```
