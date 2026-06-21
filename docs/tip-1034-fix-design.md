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

## 引用
- descriptor 调研:`SessionManager.d.ts:94-119`、`Protocol.d.ts:14-29`、`CredentialState.js:409-411`
- CAS 调研:`mppx/dist/Store.d.ts:23-56`、`@stellar/mpp/dist/charge/server/Charge.js:80-86`、`channel/server/Channel.js:191-246`
- codex 第二轮全文:`docs/codex-review-round2.txt`
