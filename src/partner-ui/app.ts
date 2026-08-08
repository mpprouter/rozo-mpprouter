/**
 * `/partner/app` — the dashboard, plus the issue and void dialogs.
 *
 * One page, no client-side router: balance on top, the most recent 200 coupons
 * below, newest first. Deliberately cut from the spec: filters, pagination,
 * monthly stats, code masking, and any self-serve top-up. There is exactly one
 * partner using this today.
 *
 * Two invariants worth stating out loud, because both protect money:
 *  - the "约可发 N credits" line floors. See MONEY_JS.
 *  - voiding requires typing the last 4 digits of the code, and a coupon that
 *    is used or in flight cannot even open the dialog — its button is disabled
 *    with the reason shown.
 */
import {
  DEFAULT_CONTACT,
  type PartnerUiOptions,
  analyticsScript,
  escapeHtml,
  htmlPage,
  htmlResponse,
} from './layout'
import { MONEY_JS } from './money-js'

function body(contact: string): string {
  const c = escapeHtml(contact)
  return `
<header class="topbar">
  <div class="wrap wrap--wide">
    <a class="brand" href="/partner/app">ROZO<span class="sub">合伙人后台</span></a>
    <span class="dim" id="whoami"></span>
  </div>
</header>

<main class="wrap wrap--wide">
  <section class="card" style="margin-top:24px;">
    <span class="label">账户余额</span>
    <div class="balance" id="balance">$—</div>
    <div class="muted" id="balance-credits" style="margin:4px 0 18px;">约可发 — credits</div>
    <div class="row">
      <button class="btn" id="issue-open" type="button" disabled>发卡</button>
      <button class="btn btn--ghost" id="refresh" type="button">刷新</button>
    </div>
    <p class="dim" style="margin:14px 0 0;">需要充值？点右下角的对话按钮找我们。</p>
  </section>

  <section class="card">
    <h2 style="margin-bottom:14px;">卡密记录 <span class="dim" id="list-count"></span></h2>
    <div id="list-msg" class="muted">加载中…</div>
    <div class="scroll-x">
      <table id="list-table" style="display:none;">
        <thead>
          <tr>
            <th>卡密</th><th>credits</th><th>面额</th>
            <th>发出时间</th><th>过期时间</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody id="list-body"></tbody>
      </table>
    </div>
  </section>

  <section class="card">
    <details id="adv">
      <summary>
        <span>高级玩家 · API &amp; Agentic</span>
        <span class="dim">用脚本或 AI 助手发卡 / 作废</span>
      </summary>

      <div class="adv-body">
        <p class="muted" style="margin:0 0 16px;">
          页面上能做的两件事都有对应接口。需要一把 API Key 才能调用 —
          <b>点右下角对话按钮找我们要</b>，我们只会给你看一次，请当场存好。
          Key 泄露等于你的余额被别人花掉，别贴进聊天群或公开仓库。
        </p>

        <p class="label">鉴权（两个接口都一样）</p>
        <div class="copybox" id="adv-auth">Authorization: Bearer &lt;你的 API Key&gt;</div>
        <button class="btn btn--ghost btn--sm" type="button" data-copy="adv-auth">复制</button>

        <p class="label" style="margin-top:26px;">① 发卡</p>
        <p class="muted" style="margin:0 0 10px;">
          <code>clientKey</code> 是幂等键，你自己生成、每张卡一个。
          <b>同一个 clientKey 重复调用只会发出同一张卡</b>（返回里 <code>reused</code> 为 true），
          所以网络超时时放心重试，不会重复扣钱。<code>credits</code> 和 <code>amountUsd</code> 二选一。
        </p>
        <div class="copybox" id="adv-issue">curl -X POST https://coupon.rozo.ai/partner/coupon/issue \\
  -H "Authorization: Bearer $ROZO_PARTNER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"clientKey":"my-order-1001","credits":10,"note":"闲鱼订单 1001"}'</div>
        <button class="btn btn--ghost btn--sm" type="button" data-copy="adv-issue">复制</button>
        <p class="dim" style="margin:10px 0 0;">
          返回：<code>code</code>（卡密）、<code>claimUrl</code>（给客户的兑换链接）、
          <code>amountUsd</code>、<code>expiresAt</code>（默认 14 天）、<code>balanceAfterUsd</code>（发完后的余额）。
        </p>

        <p class="label" style="margin-top:26px;">② 作废回收</p>
        <p class="muted" style="margin:0 0 10px;">
          把未使用的卡作废，面额退回余额。<code>confirm</code> 必须填该卡密的<b>后 4 位</b> —
          防的是脚本传错变量把好卡废掉。已使用的卡废不掉。
        </p>
        <div class="copybox" id="adv-void">curl -X POST https://coupon.rozo.ai/partner/coupon/12345678/void \\
  -H "Authorization: Bearer $ROZO_PARTNER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"confirm":"5678"}'</div>
        <button class="btn btn--ghost btn--sm" type="button" data-copy="adv-void">复制</button>
        <p class="dim" style="margin:10px 0 0;">
          返回：<code>refundedUsd</code>（退回多少）、<code>balanceAfterUsd</code>。
        </p>

        <p class="label" style="margin-top:26px;">③ 查余额 / 查卡列表</p>
        <div class="copybox" id="adv-read">curl https://coupon.rozo.ai/partner/me -H "Authorization: Bearer $ROZO_PARTNER_KEY"
curl https://coupon.rozo.ai/partner/coupons -H "Authorization: Bearer $ROZO_PARTNER_KEY"</div>
        <button class="btn btn--ghost btn--sm" type="button" data-copy="adv-read">复制</button>

        <p class="label" style="margin-top:26px;">常见错误</p>
        <ul class="muted" style="margin:0;padding-left:18px;line-height:1.9;">
          <li><code>401 UNAUTHENTICATED</code> — Key 不对或没带 Authorization 头</li>
          <li><code>402 INSUFFICIENT_BALANCE</code> — 余额不够，先充值</li>
          <li><code>409 ISSUE_IN_FLIGHT</code> — 同一个 clientKey 正在处理中，<b>等一下重试，别换 clientKey</b></li>
          <li><code>409 TOO_MANY_PENDING</code> — 并发太多，降速</li>
          <li><code>403 PARTNER_SUSPENDED</code> — 账号被停用，联系我们</li>
        </ul>

        <hr class="adv-hr">

        <p class="label">④ Agentic — 交给 AI 助手来做</p>
        <p class="muted" style="margin:0 0 12px;">
          把下面这段整个复制，贴进 Claude / ChatGPT，然后直接用大白话指挥它
          （例如「发一张 10 credits 的卡，备注闲鱼订单 1001」）。
          <b>记得把最后一行的 Key 换成你自己的</b>，并且只在你信任的、私密的对话里用。
        </p>
        <div class="copybox" id="adv-prompt">你是我的 Rozo 合伙人后台操作助手，负责帮我发放和回收 OpenRouter 充值卡密。

## 接口
基址 https://coupon.rozo.ai
所有请求都要带头：Authorization: Bearer &lt;KEY&gt;   以及 Content-Type: application/json

1) 发卡  POST /partner/coupon/issue
   body: {"clientKey": 字符串, "credits": 数字, "note": 字符串（可选）}
   - clientKey 是幂等键，必须由你生成且每张卡唯一（建议用订单号，如 "order-1001"）
   - credits 和 amountUsd 只能二选一，一般用 credits
   - 返回 code（卡密）、claimUrl（发给客户的兑换链接）、balanceAfterUsd（余额）

2) 作废  POST /partner/coupon/{code}/void
   body: {"confirm": "该卡密的后 4 位"}
   - 只能作废未使用的卡，面额会退回余额
   - 返回 refundedUsd、balanceAfterUsd

3) 查余额  GET /partner/me
4) 查卡列表 GET /partner/coupons

## 批量发卡
我可以一次要多张、多种面额，例如「发 2 张 1 credit、5 张 10 credits」。

- 一张卡一个请求，串行发，不要并发。并发会在同一条余额记录上互相抢锁，
  重试变多、也更难对账。
- 每张卡的 clientKey 必须唯一。用「批次名-面额-序号」的格式，例如：
  batch-0808a-c1-1, batch-0808a-c1-2, batch-0808a-c10-1 … batch-0808a-c10-5
  同一批里绝不能出现两个相同的 clientKey，否则第二张开始会返回第一张的卡密，
  你会以为发了 5 张，其实只有 1 张。
- 开始前先算总额（张数 x 面额）并查 /partner/me 余额，不够就停下来告诉我，一张都别发。
- 发的过程中如果某一张失败：停下，把「已成功几张、各自卡密、失败在第几张」告诉我，
  不要自动跳过继续发后面的。
- 全部发完，用表格汇总：序号 | 面额 | 卡密 | 兑换链接，最后一行给出剩余余额。

## 规则（重要，请严格遵守）
- 发卡和作废都会真实动钱。每次执行前，先用一句话复述你要做什么
  （发几张、多少 credits、给谁），等我明确说「确认」再发请求。
- 请求超时或网络出错时：用**完全相同的 clientKey** 重试，不要换。
  换 clientKey 会真的发出第二张卡、扣第二次钱。
- 收到 409 ISSUE_IN_FLIGHT：等 2 秒后用同样的 clientKey 重试，最多重试 3 次。
- 收到 402 INSUFFICIENT_BALANCE：停下来告诉我余额不够，不要尝试改小金额绕过。
- 收到 401：停下来告诉我 Key 有问题，不要重试。
- 作废前先确认这张卡确实未使用（可先查 /partner/coupons 看 status）。
- 每次操作完，告诉我：卡密、兑换链接、以及操作后的余额。
- 绝对不要把我的 API Key 写进任何输出、代码文件或对话总结里。

我的 KEY 是：&lt;把这里换成你的 API Key&gt;</div>
        <button class="btn btn--sm" type="button" data-copy="adv-prompt">一键复制 Prompt</button>
      </div>
    </details>
  </section>
</main>

<button id="help-fab" type="button" aria-label="联系我们">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
</button>

<dialog id="issue-dlg" aria-labelledby="issue-title">
  <div id="issue-form-view">
    <h2 id="issue-title">发卡密</h2>
    <span class="label">选择面值（credits）</span>
    <div class="row" id="quick-row" style="margin-bottom:12px;">
      <button class="chip" type="button" data-credits="1" aria-pressed="false">1</button>
      <button class="chip" type="button" data-credits="5" aria-pressed="false">5</button>
      <button class="chip" type="button" data-credits="10" aria-pressed="false">10</button>
      <button class="chip" type="button" data-credits="20" aria-pressed="false">20</button>
      <button class="chip" type="button" data-credits="50" aria-pressed="false">50</button>
      <button class="chip" type="button" data-credits="100" aria-pressed="false">100</button>
    </div>
    <div style="margin-bottom:6px;">
      <label class="label" for="credits-input">或自定义 credits</label>
      <input class="input" id="credits-input" type="text" inputmode="decimal"
             autocomplete="off" placeholder="例如 30" />
    </div>

    <details class="adv" id="amount-mode">
      <summary>按金额发（高级）</summary>
      <p class="dim" style="margin:8px 0 8px;">
        客户先甩来支付链接、金额是非标数（$10.50 / $7.35）时用这个，直接填卡密面额。
      </p>
      <label class="label" for="amount-input">卡密面额（USD）</label>
      <input class="input" id="amount-input" type="text" inputmode="decimal"
             autocomplete="off" placeholder="例如 10.50" />
    </details>

    <p class="dim" style="margin:16px 0 6px;">卡密有效期 <strong>14 天</strong>。</p>

    <div id="issue-hint" class="note note--err" style="display:none;" role="alert"></div>
    <pre class="confirm" id="issue-confirm" style="display:none;"></pre>

    <div class="row row--end">
      <button class="btn btn--ghost" type="button" id="issue-cancel">取消</button>
      <button class="btn" type="button" id="issue-confirm-btn" disabled>确认发放</button>
    </div>
  </div>

  <div id="issue-done-view" style="display:none;">
    <h2>已发放</h2>
    <div class="note note--ok" id="issue-done-summary"></div>
    <span class="label">卡密</span>
    <pre class="confirm" id="issue-done-code"></pre>
    <span class="label">兑换链接</span>
    <pre class="confirm" id="issue-done-url"></pre>
    <span class="label">发给客户的话术</span>
    <pre class="confirm" id="issue-done-msg"></pre>
    <div class="row row--end">
      <button class="btn btn--ghost" type="button" id="copy-url">复制链接</button>
      <button class="btn" type="button" id="copy-msg">一键复制话术</button>
      <button class="btn btn--ghost" type="button" id="issue-close">关闭</button>
    </div>
  </div>
</dialog>

<dialog id="void-dlg" aria-labelledby="void-title">
  <h2 id="void-title">作废 / 回收卡密</h2>
  <p class="muted" id="void-desc"></p>
  <div class="note note--warn">
    作废后这张卡密立即失效，面额会回到你的余额。<strong>已经被使用的卡密不能作废。</strong>
  </div>
  <label class="label" for="void-input">请输入这张卡密的<strong>后 4 位</strong>以确认</label>
  <input class="input" id="void-input" type="text" inputmode="numeric"
         autocomplete="off" maxlength="4" placeholder="4 位数字" />
  <div id="void-msg" class="note note--err" style="display:none;margin-top:12px;" role="alert"></div>
  <div class="row row--end" style="margin-top:16px;">
    <button class="btn btn--ghost" type="button" id="void-cancel">取消</button>
    <button class="btn btn--danger" type="button" id="void-confirm-btn" disabled>确认作废</button>
  </div>
</dialog>
`
}

function script(opts: PartnerUiOptions): string {
  return `${MONEY_JS}
${analyticsScript(opts)}
(function () {
  // Intercom, booted on first click. Same pattern as the explainer and the
  // blog pages: the widget is a few hundred KB and nobody needs it before
  // they ask for it.
  var fab = document.getElementById('help-fab');
  if (fab) {
    var icBooted = false;
    fab.addEventListener('click', function () {
      var settings = { app_id: 'kpfdpai7', hide_default_launcher: false };
      function show() { if (typeof window.Intercom === 'function') window.Intercom('show'); }
      if (icBooted) { show(); return; }
      icBooted = true;
      window.intercomSettings = settings;
      var el = document.createElement('script');
      el.async = true;
      el.src = 'https://widget.intercom.io/widget/kpfdpai7';
      el.onload = function () {
        if (typeof window.Intercom === 'function') { window.Intercom('boot', settings); show(); }
      };
      document.head.appendChild(el);
    });
  }

  var MOCK = new URLSearchParams(location.search).has('mock');
  var state = { balanceAtomic: '0', coupons: [] };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(id) { return document.getElementById(id); }

  // ── API ────────────────────────────────────────────────────────────────
  var MOCK_ME = { partnerId: 'ptn_mock', email: 'mock@example.com', balanceAtomic: '100000000' };
  var MOCK_COUPONS = [
    { code: '1234567890', amountUsd: '52.5', status: 'issued', refundable: true,
      issuedAt: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() + 39600000).toISOString() },
    { code: '2234567891', amountUsd: '10.5', status: 'paying', refundable: false,
      issuedAt: new Date(Date.now() - 7200000).toISOString(),
      expiresAt: new Date(Date.now() + 36000000).toISOString() },
    { code: '3234567892', amountUsd: '105', status: 'redeemed', refundable: false,
      issuedAt: new Date(Date.now() - 90000000).toISOString(),
      expiresAt: new Date(Date.now() - 46800000).toISOString() },
    { code: '4234567893', amountUsd: '5.25', status: 'expired', refundable: true,
      issuedAt: new Date(Date.now() - 180000000).toISOString(),
      expiresAt: new Date(Date.now() - 130000000).toISOString() }
  ];

  function api(path, init) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, init || {}))
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { location.href = '/partner'; throw new Error('unauthenticated'); }
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) { var e = new Error(data.error || ('HTTP ' + r.status)); e.status = r.status; e.data = data; throw e; }
          return data;
        });
      });
  }

  function loadMe() {
    if (MOCK) return Promise.resolve(MOCK_ME);
    return api('/partner/me');
  }
  function loadCoupons() {
    if (MOCK) return Promise.resolve(MOCK_COUPONS);
    return api('/partner/coupons').then(function (d) { return Array.isArray(d) ? d : (d.coupons || []); });
  }

  // ── Balance ────────────────────────────────────────────────────────────
  function renderBalance() {
    $('balance').textContent = '$' + atomicToUsd(state.balanceAtomic);
    var n = creditsAffordable(state.balanceAtomic);
    $('balance-credits').textContent = '约可发 ' + n + ' credits';
    $('issue-open').disabled = n < 1;
  }

  // ── List ───────────────────────────────────────────────────────────────
  function renderList() {
    var tbody = $('list-body');
    if (!state.coupons.length) {
      $('list-msg').textContent = '还没有发过卡密。';
      $('list-msg').style.display = '';
      $('list-table').style.display = 'none';
      return;
    }
    $('list-msg').style.display = 'none';
    $('list-table').style.display = '';
    $('list-count').textContent = '（' + state.coupons.length + ' 条，最近 200）';
    var html = '';
    for (var i = 0; i < state.coupons.length; i++) {
      var c = state.coupons[i];
      var faceAtomic = usdToAtomic(c.amountUsd) || '0';
      var v = couponStatusView(c);
      var btn = v.actionable
        ? '<button class="btn btn--ghost" type="button" data-void="' + esc(c.code) + '">作废回收</button>'
        : '<button class="btn btn--ghost" type="button" disabled title="' + esc(v.reason) + '">' + esc(v.reason || '不可操作') + '</button>';
      html += '<tr>' +
        '<td class="code">' + esc(c.code) + '</td>' +
        '<td class="num">' + esc(faceAtomicToCreditsLabel(faceAtomic)) + '</td>' +
        '<td class="num">$' + esc(atomicToUsd(faceAtomic)) + '</td>' +
        '<td class="num">' + esc(formatWhen(c.issuedAt)) + '</td>' +
        '<td class="num">' + esc(formatWhen(c.expiresAt)) + '</td>' +
        '<td><span class="badge ' + esc(v.tone) + '">' + esc(v.label) + '</span></td>' +
        '<td>' + btn + '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
    var buttons = tbody.querySelectorAll('button[data-void]');
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].addEventListener('click', function (ev) {
        openVoid(ev.currentTarget.getAttribute('data-void'));
      });
    }
  }

  function refresh() {
    return Promise.all([loadMe(), loadCoupons()]).then(function (res) {
      state.balanceAtomic = String(res[0].balanceAtomic || '0');
      setPartnerId(res[0].partnerId || null);
      if (res[0].email) $('whoami').textContent = res[0].email;
      state.coupons = res[1] || [];
      renderBalance();
      renderList();
      track('partner_list_view', { count: state.coupons.length });
    }).catch(function (e) {
      if (e && e.message === 'unauthenticated') return;
      $('list-msg').textContent = '加载失败：' + (e && e.message ? e.message : '未知错误');
    });
  }

  // ── Issue dialog ───────────────────────────────────────────────────────
  var issueDlg = $('issue-dlg');
  var clientKey = null;
  var pending = null; // { creditsLabel, faceAtomic, mode }

  function selectedFaceAtomic() {
    var amountMode = $('amount-mode').open;
    var raw = amountMode ? $('amount-input').value.trim() : $('credits-input').value.trim();
    if (!raw) return null;
    var faceAtomic = amountMode ? usdToAtomic(raw) : creditsToFaceAtomic(raw);
    if (faceAtomic === null) return null;
    return { faceAtomic: faceAtomic, mode: amountMode ? 'amount' : 'credits', raw: raw };
  }

  function updateIssue() {
    var hint = $('issue-hint');
    var pre = $('issue-confirm');
    var btn = $('issue-confirm-btn');
    var affordable = creditsAffordable(state.balanceAtomic);

    // Grey out the quick amounts the balance cannot cover, and say by how much.
    var chips = $('quick-row').querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) {
      var need = Number(chips[i].getAttribute('data-credits'));
      chips[i].disabled = need > affordable;
      chips[i].title = need > affordable ? ('余额不足，还差 ' + (need - affordable) + ' credits') : '';
    }

    pending = null;
    btn.disabled = true;
    var sel = selectedFaceAtomic();
    if (!sel) { pre.style.display = 'none'; hint.style.display = 'none'; return; }

    var faceAtomic = BigInt(sel.faceAtomic);
    if (faceAtomic < CREDIT_ATOMIC) {
      pre.style.display = 'none';
      hint.textContent = '最小面值是 1 credit（$1.05）。';
      hint.style.display = 'block';
      return;
    }
    if (faceAtomic > MAX_FACE_ATOMIC) {
      pre.style.display = 'none';
      hint.textContent = '单张卡密面额上限是 $' + atomicToUsd(MAX_FACE_ATOMIC.toString()) + '。';
      hint.style.display = 'block';
      return;
    }
    if (faceAtomic > BigInt(state.balanceAtomic)) {
      pre.style.display = 'none';
      var short = Number(((faceAtomic - BigInt(state.balanceAtomic)) + CREDIT_ATOMIC - 1n) / CREDIT_ATOMIC);
      hint.textContent = '余额不足，还差 ' + short + ' credits（约 $' +
        atomicToUsd((faceAtomic - BigInt(state.balanceAtomic)).toString()) + '）。需要充值请联系我们。';
      hint.style.display = 'block';
      return;
    }

    hint.style.display = 'none';
    var creditsLabel = sel.mode === 'credits' ? sel.raw : faceAtomicToCreditsLabel(sel.faceAtomic);
    pre.textContent = buildIssueConfirmText(creditsLabel, sel.faceAtomic, state.balanceAtomic);
    pre.style.display = 'block';
    pending = { creditsLabel: creditsLabel, faceAtomic: sel.faceAtomic, mode: sel.mode, raw: sel.raw };
    btn.disabled = false;
  }

  function openIssue() {
    $('issue-form-view').style.display = '';
    $('issue-done-view').style.display = 'none';
    $('credits-input').value = '';
    $('amount-input').value = '';
    $('amount-mode').open = false;
    var chips = $('quick-row').querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-pressed', 'false');
    // One idempotency key per dialog opening: a double-tap on 确认发放 must not
    // issue two coupons and charge twice.
    clientKey = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    updateIssue();
    issueDlg.showModal();
    track('partner_issue_open', {});
  }

  function doIssue() {
    if (!pending) return;
    var btn = $('issue-confirm-btn');
    btn.disabled = true;
    btn.textContent = '发放中…';
    track('partner_issue_confirm', { credits: pending.creditsLabel, mode: pending.mode });

    var payload = { clientKey: clientKey };
    if (pending.mode === 'credits') payload.credits = Number(pending.creditsLabel);
    else payload.amountUsd = atomicToUsd(pending.faceAtomic);
    // No expiry field: the server default (14 days) is the only answer, so
    // there is nothing to send and nothing to keep in sync with it.

    var req = MOCK
      ? Promise.resolve({
          code: '9876543210',
          claimUrl: 'https://open.rozo.ai/claim?code=9876543210',
          expiresAt: new Date(Date.now() + (hours > 0 ? hours : 12) * 3600000).toISOString(),
          balanceAfterAtomic: (BigInt(state.balanceAtomic) - BigInt(pending.faceAtomic)).toString()
        })
      : api('/partner/coupon/issue', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });

    req.then(function (r) {
      state.balanceAtomic = String(r.balanceAfterAtomic || state.balanceAtomic);
      renderBalance();
      // Only the last 4 digits ever reach analytics: the code is a bearer token.
      track('partner_issue_success', { last4: codeLast4(r.code), credits: pending.creditsLabel });
      $('issue-done-summary').textContent =
        pending.creditsLabel + ' credits · 面额 $' + atomicToUsd(pending.faceAtomic) +
        ' · 余额剩 $' + atomicToUsd(state.balanceAtomic);
      $('issue-done-code').textContent = r.code;
      $('issue-done-url').textContent = r.claimUrl;
      $('issue-done-msg').textContent = buildCustomerMessage(r.code, pending.faceAtomic, r.claimUrl, pending.creditsLabel);
      $('issue-form-view').style.display = 'none';
      $('issue-done-view').style.display = '';
      btn.textContent = '确认发放';
      refresh();
    }).catch(function (e) {
      if (e && e.message === 'unauthenticated') return;
      var hint = $('issue-hint');
      hint.textContent = (e && e.status === 402)
        ? '余额不足，发放未执行。需要充值请点右下角对话按钮。'
        : ('发放失败：' + (e && e.message ? e.message : '未知错误') + '。请刷新后确认这张卡有没有发出去。');
      hint.style.display = 'block';
      btn.textContent = '确认发放';
      btn.disabled = false;
    });
  }

  function copyText(text, btn) {
    var done = function () { var t = btn.textContent; btn.textContent = '已复制'; setTimeout(function () { btn.textContent = t; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  // ── Void dialog ────────────────────────────────────────────────────────
  var voidDlg = $('void-dlg');
  var voidCode = null;

  function openVoid(code) {
    var c = null;
    for (var i = 0; i < state.coupons.length; i++) if (state.coupons[i].code === code) c = state.coupons[i];
    // Belt and braces: the button is already disabled for these, but a coupon
    // that is used or in flight must never reach this dialog.
    if (!c || !couponStatusView(c).actionable) {
      track('partner_void_rejected', { last4: codeLast4(code), reason: 'not_actionable' });
      return;
    }
    voidCode = code;
    $('void-desc').textContent = '卡密 ' + code + ' · 面额 $' + atomicToUsd(usdToAtomic(c.amountUsd) || '0');
    $('void-input').value = '';
    $('void-msg').style.display = 'none';
    $('void-confirm-btn').disabled = true;
    voidDlg.showModal();
    track('partner_void_open', { last4: codeLast4(code) });
  }

  function updateVoid() {
    $('void-confirm-btn').disabled = !voidCode || $('void-input').value.trim() !== codeLast4(voidCode);
  }

  function doVoid() {
    if (!voidCode) return;
    var confirmInput = $('void-input').value.trim();
    if (confirmInput !== codeLast4(voidCode)) {
      track('partner_void_rejected', { last4: codeLast4(voidCode), reason: 'confirm_mismatch' });
      $('void-msg').textContent = '后 4 位对不上，请再看一眼卡密。';
      $('void-msg').style.display = 'block';
      return;
    }
    var btn = $('void-confirm-btn');
    btn.disabled = true;
    btn.textContent = '处理中…';
    track('partner_void_confirm', { last4: codeLast4(voidCode) });

    var req = MOCK
      ? Promise.resolve({ balanceAfterAtomic: state.balanceAtomic })
      : api('/partner/coupon/' + encodeURIComponent(voidCode) + '/void', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: confirmInput })
        });

    req.then(function (r) {
      track('partner_void_success', { last4: codeLast4(voidCode) });
      if (r && r.balanceAfterAtomic) { state.balanceAtomic = String(r.balanceAfterAtomic); renderBalance(); }
      btn.textContent = '确认作废';
      voidDlg.close();
      voidCode = null;
      refresh();
    }).catch(function (e) {
      if (e && e.message === 'unauthenticated') return;
      track('partner_void_rejected', { last4: codeLast4(voidCode), reason: 'server', status: e && e.status });
      $('void-msg').textContent = '作废失败：' + (e && e.message ? e.message : '未知错误') +
        '。如果这张卡已经被使用，它就不能作废了。';
      $('void-msg').style.display = 'block';
      btn.textContent = '确认作废';
      btn.disabled = false;
    });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  $('issue-open').addEventListener('click', openIssue);
  $('refresh').addEventListener('click', refresh);
  $('issue-cancel').addEventListener('click', function () { issueDlg.close(); });
  $('issue-close').addEventListener('click', function () { issueDlg.close(); });
  $('issue-confirm-btn').addEventListener('click', doIssue);
  $('credits-input').addEventListener('input', function () {
    var chips = $('quick-row').querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-pressed', 'false');
    updateIssue();
  });
  $('amount-input').addEventListener('input', updateIssue);
  $('amount-mode').addEventListener('toggle', updateIssue);
  (function () {
    var chips = $('quick-row').querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function (ev) {
        var all = $('quick-row').querySelectorAll('.chip');
        for (var k = 0; k < all.length; k++) all[k].setAttribute('aria-pressed', 'false');
        ev.currentTarget.setAttribute('aria-pressed', 'true');
        $('amount-mode').open = false;
        $('credits-input').value = ev.currentTarget.getAttribute('data-credits');
        updateIssue();
      });
    }
  })();
  // Advanced section: every button carries the id of the block it copies, so
  // adding a snippet is HTML-only and cannot drift out of sync with the JS.
  var copyBtns = document.querySelectorAll('[data-copy]');
  for (var ci = 0; ci < copyBtns.length; ci++) {
    copyBtns[ci].addEventListener('click', function (ev) {
      var src = $(ev.currentTarget.getAttribute('data-copy'));
      if (src) copyText(src.textContent, ev.currentTarget);
    });
  }

  $('copy-url').addEventListener('click', function (ev) { copyText($('issue-done-url').textContent, ev.currentTarget); });
  $('copy-msg').addEventListener('click', function (ev) { copyText($('issue-done-msg').textContent, ev.currentTarget); });
  $('void-cancel').addEventListener('click', function () { voidDlg.close(); });
  $('void-input').addEventListener('input', updateVoid);
  $('void-confirm-btn').addEventListener('click', doVoid);

  refresh();
})();
`
}

/** Renders `GET /partner/app` (the dashboard). */
export function renderPartnerAppPage(opts: PartnerUiOptions = {}): Response {
  return htmlResponse(
    htmlPage({
      title: 'ROZO 合伙人后台 · 卡密',
      bodyHtml: body(opts.contact ?? DEFAULT_CONTACT),
      script: script(opts),
    }),
  )
}
