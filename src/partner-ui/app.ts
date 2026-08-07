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
    <p class="dim" style="margin:14px 0 0;">需要充值？联系我们：${c}</p>
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
</main>

<dialog id="issue-dlg" aria-labelledby="issue-title">
  <div id="issue-form-view">
    <h2 id="issue-title">发卡密</h2>
    <span class="label">选择面值（credits）</span>
    <div class="row" id="quick-row" style="margin-bottom:12px;">
      <button class="chip" type="button" data-credits="10" aria-pressed="false">10</button>
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

    <div style="margin:16px 0 6px;">
      <label class="label" for="expires-input">有效期（小时，留空 = 12）</label>
      <input class="input" id="expires-input" type="text" inputmode="numeric"
             autocomplete="off" placeholder="12（最长 168 = 7 天）" />
    </div>

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
    $('expires-input').value = '';
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
    var hours = parseInt($('expires-input').value.trim(), 10);
    if (hours > 0) payload.expiresMinutes = Math.min(hours, 168) * 60;

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
      $('issue-done-msg').textContent = buildCustomerMessage(r.code, pending.faceAtomic, r.claimUrl, r.expiresAt);
      $('issue-form-view').style.display = 'none';
      $('issue-done-view').style.display = '';
      btn.textContent = '确认发放';
      refresh();
    }).catch(function (e) {
      if (e && e.message === 'unauthenticated') return;
      var hint = $('issue-hint');
      hint.textContent = (e && e.status === 402)
        ? '余额不足，发放未执行。需要充值请联系我们。'
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
  $('expires-input').addEventListener('input', updateIssue);
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
