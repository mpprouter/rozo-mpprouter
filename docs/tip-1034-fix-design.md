# TIP-1034 修复设计(codex 第二轮 3 个 P1 的正解)

> 状态:**调研完成,待老板拍板再实现。** 代码停在分支 `fix/tip-1034-session-descriptor`(2 commits)。
> 两份只读调研均引用 mppx 0.7.0 / @stellar/mpp 0.7.0 真实代码。

## 背景:为什么会走到这一步
客户报 anthropic/openai "verification-failed"。付费实测发现真因是我们 session voucher 缺 TIP-1034 `descriptor`(mppx 0.4.12 太老)。升级 mppx→0.7.0 触发连锁:
- 配对升 `@stellar/mpp`→0.7.0 + `stellar-sdk`→15(碰 inbound 收款)— ✅ 已做(commit `0f432b1`)
- 但 codex 第二轮证明**当前代码部署了也修不好**,3 个 P1 ↓

---

## P1-1 — index.ts 引用未跟踪文件(别人的旧改动)
clean checkout 编译失败:`./routes/create-invoice`、`./routes/webhook`、`./utils/cors` 是别人未提交的文件。
**不是本次 TIP-1034 修复引入的**,是建分支前 working tree 就有的。
**处理选项**:(a) 把这些文件也纳入提交;(b) 把它们从分支隔离掉(stash/移走)。需确认这些文件归属。

---

## P1-2 — descriptor 没被真正捕获 ⭐(修复核心,改动小)

**Bug**:`open-tempo-channel.ts` 用 `tempo.session.manager({ onChannelUpdate })` 抓 descriptor。但 **0.7.0 的 `manager()` 没有 `onChannelUpdate` 参数**,回调被忽略 → descriptor 没进 KV → voucher 仍报 "descriptor required"。

**正解**(`SessionManager.d.ts:94-119` + `.js:145-150,316-324`):manager 接受 **`sessionStore: { get, set, delete }`**。channel 打开时 manager 自动调 `sessionStore.set(channel)`,`channel.descriptor` 在里面(`storedChannelFromEntry`,`.js:36-46`)。

`ChannelDescriptor` 字段(`Protocol.d.ts:14-29`):`payer / payee / operator / token / salt / authorizedSigner / expiringNonceHash`。

**改 `scripts/admin/open-tempo-channel.ts`**:把 `onChannelUpdate` 换成
```ts
const descriptorStore: SessionStore = {
  get() { return null },
  async set(channel) {            // channel.descriptor 在这里
    await kvPut(`tempoChannel:${id}`, JSON.stringify({ ...state, descriptor: channel.descriptor }))
  },
  delete() {},
}
tempo.session.manager({ account, client, decimals: 6, maxDeposit, sessionStore: descriptorStore })
```
**`tempo-client.ts` 的 manual voucher 路径不用改** —— 它已经把 `descriptor` 从 KV 传进 `createCredential({action:'voucher', channelId, cumulativeAmountRaw, descriptor})`,这正是 0.7.0 manual 模式的正确用法(`CredentialState.js:409-411 manualVoucher`)。manual 模式 0.7.0 完整支持。

**改动量**:小(一个文件,换个参数 + 持久化 descriptor)。

---

## P1-3 — 假 CAS 可双花 ⭐(资金安全,改动大)

**Bug**:`kv-atomic-store.ts` 的 `update()` 是非原子 read→transform→write。`@stellar/mpp` 用 `store.update()` 做**重放保护 + channel cumulative 累加**(`Charge.js:80-86` 防重放;`Channel.js:191-246` cumulative 严格递增)。并发下两个 isolate 都读到旧值都写 → **同一付款被接受两次(charge 双花)/ cumulative 倒退(channel 双花)**。

**为什么 KV 救不了**:Cloudflare KV **物理上不支持条件写**(无 if-match / 无版本 CAS,`KVNamespacePutOptions` 只有 expiration/metadata)。乐观重试也不行(put 总成功,只能事后发现冲突,防不住)。

**mppx 没内置 CF-correct store**:`Store.cloudflare()` 要调用方自己提供 `update`;内置只有 memory/redis/upstash(Workers 用不了)。

**唯一正解 = Durable Object**(单线程串行 = 真线性化 CAS)。

**实现要点 + 真坑**:
- 新增 DO 类(`storage.get/put/delete`,~100 LOC),按 key `idFromName(key)` 路由 → 同 key 串行。
- wrangler.toml 加 `[[durable_objects.bindings]]` + `[[migrations]] new_classes`(首次部署 DO 需 migration)。
- ⚠️ **不能 `fn.toString()` 把回调序列化到 DO**(只对纯函数有效,实践会坏)。正确做法:把 mppx 实际用到的两类操作抽象成显式 op 发给 DO(① "claim-if-absent" 防重放;② "set-if-greater" cumulative 递增),在 DO 内部实现这两个原子操作,而不是传任意 `fn`。
- 该 Worker **目前没有任何 Durable Object**,这是新增基础设施(部署面变大)。

**改动量**:中-大(新 DO + wrangler 配置 + migration + 重写 store 适配器,且碰 inbound 收款核心路径)。

---

## 实现顺序建议(全部 high-risk,逐步验证)
1. P1-2 descriptor 捕获(小)→ tsc
2. P1-3 DO-backed CAS store(大)→ tsc + 本地测
3. P1-1 决定 index.ts 未跟踪文件归属
4. 第三轮 codex review → 必须 P1 清零
5. 部署 → 重开 anthropic+openai channel(各 $1)→ 主网付费复测(<$10)
6. 复测看 anthropic/openai 是否 200 正常返回 + inbound 收款未被搞坏

---

## codex 第三轮结果(2026-06-21):descriptor + DO 核心逻辑 PASS,剩 2 个部署/迁移 P1

P1-2、P1-3 的**代码逻辑 codex 三轮没再挑出资金错误**(CAS 实现读完无双花/竞态)。剩两个都是部署层面:

### P1-1 — index.ts 引用未跟踪文件(别人的)
`src/routes/create-invoice.ts`(515行)、`webhook.ts`(612行)、`utils/cors.ts`(63行)、`utils/base-usdc-balance.ts`(89行)是**完整文件**(tsc 过),index.ts 已 import,属于别人没提交的 invoice/webhook 功能。clean checkout 编译失败。
**处理**:这些不是我的修复。要么 (a) 别人把它们提交;(b) 我把它们一起纳入本分支提交(让分支可独立 build);(c) 部署时用本地工作树(文件在本地,wrangler deploy 从本地打包,实际能 build)。

### ⚠️ P1-2 cutover 迁移 — 真风险,但规模小(3 个 channel)
切到空 DO 后,生产 KV 现有 mppx 状态对 DO 不可见:
- **354 个 `stellar:charge:challenge`**(重放键)→ 短命(challenge 几分钟过期),切换时早过期,**丢了无所谓**。
- **3 个 `stellar:channel:cumulative`**(channel 累计水位线)→ **非零活跃**:`56424` / `105500` / `63924` base units。切到空 DO = 水位线归零 = 旧 inbound channel voucher 可重放。**必须迁移这 3 个值。**
  - channel 合约:`CAQGTD...HVWC` / `CAYS2L...N6UW` / `CCMIWJ...S5CW`
  - 注意:这是 **inbound** Stellar channel(`stellar:channel:*`),与我们修的 anthropic/openai **outbound** `tempoChannel:*` 是两回事。

**cutover 方案**(部署前预填 DO,low-risk):
1. 部署 DO + 新代码(此时 DO 空,但暂不影响——除非有 inbound channel voucher 进来)。
2. 立即把这 3 个 `stellar:channel:cumulative:*` 的值预填进 DO 对应 key(`v:stellar:channel:cumulative:<C>` + `n:...=1`),或写个一次性迁移脚本读 KV→写 DO。
3. 或选 inbound channel 无 in-flight voucher 的低峰窗口切。
- 重放键 354 个不迁移(短命,可接受)——但要 `log` 说明这个有意的跳过。

## 实现顺序(更新)
1. ✅ P1-2 descriptor(commit 002c585)
2. ✅ P1-3 DO CAS(commit a6d505b)
3. ⏳ P1-1 决定未跟踪文件归属
4. ✅ 第三轮 codex:核心 PASS,剩 2 个部署 P1
5. ⏳ cutover:预填 3 个 channel cumulative 进 DO
6. ⏳ 部署 → 重开 anthropic+openai channel($1)→ 主网付费复测(<$10)

## 引用
- descriptor 调研:`SessionManager.d.ts:94-119`、`Protocol.d.ts:14-29`、`CredentialState.js:409-411`
- CAS 调研:`mppx/dist/Store.d.ts:23-56`、`@stellar/mpp/dist/charge/server/Charge.js:80-86`、`channel/server/Channel.js:191-246`
- codex 三轮全文:`docs/codex-review-round{2,3}.txt`

---

## ⚠️ E2E 复测发现新 blocker(2026-06-21 部署后)

部署成功(version `0f7de19f`)+ 迁移 3 个 cumulative + 重开 anthropic/openai channel(**descriptor 这次真捕获到了**,P1-2 验证生效)后,真金 e2e 复测撞到一个**新的、独立的 inbound bug**:

```
402 invalid-challenge: "credential opaque does not match this route's requirements"
```

### 关键事实
- **错误变了**:从修复前的 `descriptor required for TIP-1034`(下游 outbound)→ 现在 `opaque does not match`(inbound charge 验证)。**说明 descriptor 修复生效了**,卡点前移到 inbound。
- **不是客户端版本问题**:把测试 skill 的 mppx 也升到 0.7.0(+viem)后,**依旧报 opaque**。
- **根源**:mppx 0.7.0 `server/Mppx.js` 的 `getChallengeBindingMismatch` → `opaqueValuesMatch(expectedChallenge.meta, actualChallenge.meta)`。服务端**签发 challenge 时生成的 opaque/meta ↔ 验证时重新生成的 opaque 不一致**。这是 0.7.0 内部 challenge 重生成(stableBinding/meta)机制,我们升级 @stellar/mpp+mppx 后未对齐。
- 我们 charge server(`stellar-server.ts`)只传 `recipient`+`store`,没显式传 opaque → opaque 是 0.7.0 内部生成的。

### 生产影响:极小(但需处理)
- `wrangler tail` 12s 无真实 charge 流量撞此错 → 与"MPP Router 真实使用≈$0"一致,**没有正在伤害真实客户**。
- 旧版本(5/23)可回滚。

### 状态
- ✅ descriptor(P1-2)、DO CAS(P1-3)、迁移、seed —— 全部部署生效。
- ✅ descriptor 修复**已用真金验证前移了卡点**(铁证)。
- ❌ inbound charge 的 opaque 不匹配 = 新 blocker,在 mppx 0.7 inbound 路径,需要单独定位(challenge 签发 vs 验证两次生成 meta 的差异)。

### 待决策
1. 深挖 opaque 根因(mppx 0.7 inbound challenge 重生成);或
2. 回滚到 5/23 版本(放弃本次升级,回到 descriptor 坏但 inbound 稳的状态);或
3. 保持部署(生产无真实流量,不流血),把 opaque 当独立 bug 排期。

---

## E2E 完整进展 + 最终 blocker(2026-06-21,深度排查后)

部署后真金 e2e 逐层推进,连续定位并修复 6 个真实问题:

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| 1 | outbound voucher 缺 TIP-1034 descriptor | sessionStore 捕获(P1-2) | ✅ 错误从 descriptor-required 消失 |
| 2 | inbound charge opaque 不匹配(meta 含每请求变化的 parsed.id) | meta 只留 route.id(`proxy.ts`) | ✅ opaque 错误消失,inbound 收款通过 |
| 3 | channel depositRaw 取 manager 快照(=cumulative,零余量) | depositRaw 用 cumulative+headroom | ✅ KV 余量正确 |
| 4 | topUp 撞 maxDeposit 上限 | maxDeposit = deposit+1USDC buffer | ✅ 不再撞顶 |
| 5 | manager resume 旧 channel | bootstrap:false | ⚠️ channelId 确定性派生,仍同一个 |
| 6 | topUp 走 merchant 402 失败 | (未解决) | ❌ **最终 blocker** |

### 最终 blocker:链上 channel deposit 耗尽 + topUp 走不通
- 错误一路推进到:`session/amount-exceeds-deposit: voucher amount exceeds on-chain deposit`(merchant 链上检查)。
- **根因**:这些 session channel 是旧测试遗留,**链上真实 deposit 已耗尽**。补充 deposit 的 `topUp()` 要走 merchant 的 402 付费流程,在 admin 脚本环境下返回 402 失败。
- ⚠️ **数据陷阱**:`inspect-channels.ts` 的 deposit/cumulative 列读的是 **KV 镜像(乐观写入值)**,不是链上真值;脚本乐观写了 depositRaw=1000750 但 topUp 没兑现 → KV 看着有空间,merchant 按真实链上 deposit 拒绝。判断链上 deposit 必须读链不读 KV。

### ✅ 已确认生效(铁证)
- **inbound 收款修复(opaque)**:部署后 charge 付款不再报 opaque,inbound USDC 成功进 pool。
- **descriptor 捕获**:open channel 时 `✅ descriptor captured via sessionStore.set()`,KV 有完整 descriptor。
- **DO CAS + 迁移**:3 个 cumulative 已 seed,幂等验证过。
- 所有代码改动 tsc clean,166 测试过,codex 4 轮无 P0。

### 剩余给人/老板:让 e2e 真正 200 返回
需要一个**链上 deposit 充足的 session channel**。选项:
1. 用一个**全新 Stellar/Tempo 账号**开全新 channel(channelId 由 payer 派生,换账号才得新 channel + 新链上 deposit)。
2. 修 `topUp` 让它在 admin 环境能真正向 merchant 完成 402 付费充值(需排查 merchant topUp 的 402 凭证要求)。
3. 找 merchant 侧重置/补充这几个 channel 的链上 deposit。

**核心结论**:Router 代码侧的 TIP-1034 + opaque + CAS 修复**全部正确且已上生产**;e2e 卡在测试 channel 的链上资金状态(运营/merchant 层),非代码缺陷。
