/**
 * Scheduled wrapper around charge-e2e.mjs for the Railway cron service
 * `mpprouter-charge-eval` (Mon + Thu 01:00 UTC).
 *
 *   1. balance guard — skip the paid run if the test wallet holds less
 *      USDC than MIN_USDC (default 2.0 ≈ 4 runs) and alert instead
 *   2. run charge-e2e.mjs (real money, ≤ MAX_AUTO_USD per call)
 *   3. persist one row per provider to Supabase when SUPABASE_URL +
 *      SUPABASE_KEY are set (table analytics_app_mpprouter_charge_evals);
 *      silently skipped otherwise
 *   4. Feishu: one compact summary every run, failures listed first
 *
 * Env: E2E_STELLAR_SECRET (required), E2E_STELLAR_ADDRESS (required, for
 * the read-only balance check), FEISHU_APP_ID/FEISHU_APP_SECRET/FEISHU_CHAT_ID
 * (or FEISHU_WEBHOOK), SUPABASE_URL, SUPABASE_KEY,
 * MIN_USDC, PAY_PER_CALL_DIR, MAX_AUTO_USD.
 * Never prints secrets; charge-e2e already redacts child output.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADDR = process.env.E2E_STELLAR_ADDRESS
const MIN_USDC = Number(process.env.MIN_USDC || '2')
const OUT = join(process.env.TMPDIR || '/tmp', `charge-eval-${Date.now()}.json`)

for (const k of ['E2E_STELLAR_SECRET', 'E2E_STELLAR_ADDRESS']) {
  if (!process.env[k]) { console.error(`${k} is required`); process.exit(2) }
}

// Feishu: bot identity (FEISHU_APP_ID + FEISHU_APP_SECRET + FEISHU_CHAT_ID,
// same bot as ainative notify_feishu.py) or a plain FEISHU_WEBHOOK. Neither
// set → print to stderr only.
async function feishu(text) {
  const { FEISHU_WEBHOOK: url, FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret, FEISHU_CHAT_ID: chatId } = process.env
  const base = (process.env.FEISHU_API_BASE || 'https://open.feishu.cn').replace(/\/$/, '')
  try {
    if (appId && appSecret && chatId) {
      const tok = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      }).then((r) => r.json())
      if (!tok.tenant_access_token) throw new Error(`tenant token code=${tok.code}`)
      const r = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.tenant_access_token}` },
        body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
      }).then((r) => r.json())
      if (r.code !== 0) throw new Error(`im send code=${r.code} ${r.msg}`)
      return
    }
    if (url) {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text } }) })
      if (!r.ok) throw new Error(`webhook ${r.status}`)
      return
    }
    console.error('[feishu skipped]\n' + text)
  } catch (e) {
    console.error('feishu send failed:', e.message, '\n' + text)
  }
}

async function usdcBalance() {
  const r = await fetch(`https://horizon.stellar.org/accounts/${ADDR}`)
  if (!r.ok) throw new Error(`horizon ${r.status}`)
  const j = await r.json()
  const b = (j.balances || []).find((x) => x.asset_code === 'USDC')
  return b ? Number(b.balance) : 0
}

async function persist(report) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY
  if (!url || !key) return 'not configured'
  const rows = report.results.map((r) => ({
    run_ts: report.ts, router_base: report.base, provider: r.id, family: r.family,
    mode: r.mode, verdict: r.verdict, blame: r.blame, detail: r.detail,
  }))
  const res = await fetch(`${url}/rest/v1/analytics_app_mpprouter_charge_evals`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  })
  return res.ok ? `${rows.length} rows` : `HTTP ${res.status}`
}

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z'

async function main() {
  const bal = await usdcBalance().catch((e) => { console.error('balance check failed:', e.message); return null })
  if (bal !== null && bal < MIN_USDC) {
    await feishu(`【MPP Router 付费巡检 · ${stamp()}】\n⏸ 本轮跳过：测试钱包 USDC 仅 ${bal.toFixed(3)}，低于 ${MIN_USDC}。\n🟡 请老板补 Stellar USDC 到 ${ADDR.slice(0, 6)}...${ADDR.slice(-4)}（约 $10 够一个月）。`)
    process.exit(3)
  }

  const t0 = Date.now()
  const run = spawnSync(process.execPath, [join(HERE, 'charge-e2e.mjs'), ...process.argv.slice(2)], {
    env: { ...process.env, JSON_OUT: OUT }, stdio: ['ignore', 'ignore', 'inherit'], timeout: 20 * 60 * 1000,
  })
  const secs = Math.round((Date.now() - t0) / 1000)

  if (!existsSync(OUT)) {
    await feishu(`【MPP Router 付费巡检 · ${stamp()}】\n🔴 巡检脚本本身没跑完（exit ${run.status}, ${secs}s），没有结果。看 Railway 服务 mpprouter-charge-eval 的日志。`)
    process.exit(1)
  }
  const report = JSON.parse(readFileSync(OUT, 'utf8'))
  unlinkSync(OUT)
  const persisted = await persist(report).catch((e) => `error ${e.message}`)
  const after = await usdcBalance().catch(() => null)

  const skipped = report.results.filter((r) => r.verdict === 'SKIP')
  const fails = report.results.filter((r) => r.verdict !== 'PASS' && r.verdict !== 'SKIP')
  const tested = report.results.length - skipped.length
  const pass = tested - fails.length
  const nothingTested = tested === 0
  const lines = [`【MPP Router 付费巡检 · ${stamp()}】`,
    nothingTested
      ? `🟡 0 个 provider 被测试（全部被目录标为不可付款），本轮没有真实付款，不算通过`
      : `${fails.length ? '🔴' : '🟢'} ${pass}/${tested} provider 全链路付款成功，用时 ${secs}s`]
  if (skipped.length) lines.push(`⚪ 目录标为不可付款、未测: ${skipped.map((r) => r.id).join(', ')}`)
  for (const f of fails) lines.push(`· ${f.id} ${f.verdict} [${f.blame === 'us' ? '我们的问题' : f.blame === 'merchant' ? '商家问题' : '待判'}] ${f.detail}`)
  if (fails.length) lines.push(`→ 责任在「我们的问题」的项先修；排查 SOP: docs/SOP-provider-e2e-test.md`)
  if (bal !== null && after !== null) lines.push(`💰 钱包 USDC ${bal.toFixed(3)} → ${after.toFixed(3)}（本轮花 $${(bal - after).toFixed(3)}）`)
  lines.push(`📎 落库: ${persisted}`)
  await feishu(lines.join('\n'))
  process.exit(nothingTested ? 4 : fails.length ? 1 : 0)
}

main().catch(async (e) => { console.error(e); await feishu(`【MPP Router 付费巡检】🔴 wrapper crashed: ${String(e.message || e).slice(0, 200)}`); process.exit(1) })
