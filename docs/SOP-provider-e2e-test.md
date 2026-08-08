# SOP — MPP Router Provider 端到端付费测试

> 用途:当客户报某个 provider "verification-failed / 付了钱没返回 / 5xx" 时,**用我们自己的测试钱包走生产 Router 真打一笔**,在几分钟内判定责任在 **我们 / merchant / 客户**。
> 风险等级:**HIGH(动真钱)** — 每笔 ~0.001 USDC + Stellar 手续费。改 Router 代码后也用这套做 smoke test。

---

## 0. 一句话原理

Router 的链路是:`客户付 Stellar USDC → Router pool → Router 用 Tempo 付下游 merchant → 返回结果`。
光看代码/注释会误判,**必须真付一笔才能测到"付款之后的下游结算"**。零成本探测只能验证报价层,验不了下游。

---

## 1. 前置(一次性)

- **测试钱包**:`~/workspace/rozo/rozocontracts/rozoskilltest/.env` 里的 `STELLAR_ADDRESS` / `STELLAR_PRIVATE_KEY`(公钥 `GAN3YS...4UYY`)。需 Stellar 主网有 USDC 余额(查:`horizon.stellar.org/accounts/<G地址>`)。
- **客户端**:`stellar-agent-wallet` skill 的 `pay-per-call`(插件缓存 `~/.claude/plugins/cache/mpprouter/stellar-agent-wallet/<ver>/`)。它自动处理 402→签名→重试,默认走 MPP charge dialect。
- **Router base**:`https://apiserver.mpprouter.dev`(公开)。

### 🔒 密钥纪律(必须遵守)
- **绝不**把私钥打印到对话/日志。
- `pay-per-call` 的 `--secret-file` 期望**纯 S-key 单行文件**;直接传 `.env` 会报 "does not contain a valid Stellar secret key"。
- 正确做法:提取到 600 权限临时文件,**用完立即 `rm`**:
  ```bash
  TMP=$(mktemp /tmp/.stkey.XXXXXX); chmod 600 "$TMP"
  python3 -c "
  for l in open(__import__('os').path.expanduser('~/workspace/rozo/rozocontracts/rozoskilltest/.env')):
      if l.startswith('STELLAR_PRIVATE_KEY='):
          open('$TMP','w').write(l.split('=',1)[1].strip().strip('\"').strip(\"'\")); break
  "
  # ... 跑测试 ...
  rm -f "$TMP"   # 测完务必删
  ```

---

## 2. Step 1 — 零成本探测(先做,不花钱)

确认 Router 健康 + 看每个 provider 的 402 challenge(报价/intent/收款地址)。**这步能验证报价层,但验不了下游。**

```bash
BASE="https://apiserver.mpprouter.dev"
curl -s "$BASE/health" | head           # 确认 router_pool 地址
# 无付款 POST,看 402 challenge 头(intent=charge/session? 报价多少?)
curl -s -X POST "$BASE/v1/services/<svc>/<path>" \
  -H "Content-Type: application/json" -d '<最轻body>' \
  -D - -o /dev/null -w "[HTTP %{http_code}]\n" | grep -iE "www-authenticate|payment-required"
```
- 返回 **402 + `www-authenticate: Payment ... intent="..."`** = 报价层正常,继续 Step 2。
- 返回 **5xx / 无 challenge** = Router 入站层就坏了,先查 Router 本身。

### 各 provider 最轻 body(抄这个)
| provider | publicPath | 最轻 body |
|---|---|---|
| alchemy | `/v1/services/alchemy/rpc` | `{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}` |
| anthropic | `/v1/services/anthropic/messages` | `{"model":"claude-3-5-haiku-20241022","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}` |
| openai | `/v1/services/openai/chat` | `{"model":"gpt-4o-mini","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}` |
| gemini | `/v1/services/gemini/generate` | `{"contents":[{"parts":[{"text":"hi"}]}]}` |
| exa | `/v1/services/exa/search` | `{"query":"test"}` |
| firecrawl | `/v1/services/firecrawl/scrape` | `{"url":"https://example.com"}` |

(provider 全表见 `src/services/merchants.ts` 的 `OPERATOR_OVERLAY`。)

---

## 3. Step 2 — 付费实测(真打一笔,判定责任)

```bash
cd ~/.claude/plugins/cache/mpprouter/stellar-agent-wallet/*/   # skill 目录
npx tsx skills/pay-per-call/run.ts \
  "https://apiserver.mpprouter.dev/v1/services/<svc>/<path>" \
  --body '<最轻body>' --method POST \
  --secret-file "$TMP" --network pubnet --max-auto 0.10
```

### 怎么读结果(责任判定表)

| 实测返回 | 含义 | 责任 |
|---|---|---|
| **200 + 正常 body** | 全链路通 | ✅ 健康,无问题 |
| **502 "Merchant payment failed", detail = merchant 5xx**(如 `Internal error`) | 我们付款成功,merchant 自己 500 | **merchant 侧** |
| **502, detail = `verification-failed: descriptor required for TIP-1034 ...`** | 我们的 voucher 缺 TIP-1034 descriptor(mppx 旧) | **我们的**(升级 mppx + 补 descriptor) |
| **503 "Router session channel not installed"** | 该 session merchant 没开 Tempo channel | **我们的**(运营,开 channel) |
| **503 "Tempo pool balance insufficient"** | pool 钱不够 | **我们的**(运营,充值 pool) |
| **402 一直循环 / 签名后仍 402** | challenge 绑定不上(memo/凭证格式) | **我们的**(凭证逻辑/版本漂移) |
| **付款后 timeout/504** | 下游慢 or 我们多往返撞 CF 限额 | 需多跑几次区分:偶发=merchant 慢;每次必现=我们 |

> 关键:**merchant 返回 5xx → Router 映射成 502**(`proxy.ts:597`);**503 只来自我们这边**(channel 未开 / pool 不足,`proxy.ts:553,986`)。看到 503 别甩给 merchant。

---

## 4. Step 3 — 记录 + 同步

1. 结果写进 `analytics_log`(在 ainative):
   ```bash
   cd ~/workspace/ainative
   python3 scripts/analytics_log.py add --title "..." --summary "..." \
     --report docs/xxx.md --tags mpprouter,e2e-test
   ```
2. 若判定是**我们的 bug**:开 Trello 卡 / 项目 todo,标 high-risk,修复走 **codex review + 本 SOP 复测**。
3. **务必 `rm -f "$TMP"`** 删临时密钥。

---

## 5. 已知结论(2026-06-21 首次实测)

- **anthropic / openai**:`verification-failed: descriptor required for TIP-1034 session action` → **我们的**。`mppx@0.4.12` 太老,voucher 缺 TIP-1034 descriptor(`tempo-client.ts:229-233` 只传 action/channelId/cumulative)。`package.json` mppx pin 成 `"latest"` 是根因隐患。
- **alchemy**:merchant 500 `Internal error` → merchant 侧。
- **修复方向**(待排期,high-risk):升级 mppx 到支持 TIP-1034 → voucher 补 descriptor → 重开 session channel → 本 SOP 全量复测。

---

## 6. 安全清单(每次跑前后核对)

- [ ] 临时密钥文件 600 权限,内容从不打印
- [ ] 测完 `rm -f` 临时密钥
- [ ] 地址在对话里 mask(前6+后4)
- [ ] 这是 HIGH risk(动钱),改 Router 生产前先跟老板确认
- [ ] 测试用最小金额 / 最轻 body,别跑大 token 请求
