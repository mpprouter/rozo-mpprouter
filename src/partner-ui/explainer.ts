/**
 * `/partner` — the logged-out explainer + login page.
 *
 * This is the only page a partner sees before authenticating, so it has to
 * answer four things on its own: what the tool is, what a credit costs and who
 * charges the 5%, how their customer actually redeems a code, and how to get
 * back in next time. There is no self-registration, so there is deliberately
 * no signup link — accounts are created by us.
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
  <div class="wrap">
    <a class="brand" href="/partner">ROZO<span class="sub">合伙人后台</span></a>
    <span class="dim">卡密自助发放</span>
  </div>
</header>

<main class="wrap">
  <section style="padding:34px 0 4px;">
    <h1>发卡密，自己来。</h1>
  </section>

  <section class="card" id="customer-script">
    <h2>你的客户怎么用这张卡</h2>
    <p class="muted" style="margin-top:-4px;">把下面这段直接发给客户，把 <code>XXXXXX</code> 换成你发出的卡密。</p>
    <pre class="copybox" id="cust-copy">卡号：https://open.rozo.ai/claim?code=XXXXXX
先打开上面链接。输入代付款支付链接（例如 https://payments.coinbase.com/payment-sessions/paymentSession_xxxxxx ）。默认美国付款方式自动到账，自助自动发货。如果新用户不会操作，请等待人工客服。</pre>
    <button class="btn btn--ghost" id="cust-copy-btn" type="button">复制这段话</button>
  </section>

  <section class="card">
    <h2>三步开始</h2>
    <ol class="steps">
      <li class="step"><span class="step-n">1</span><span>用<strong>我们给你的用户名和密码</strong>登录（页面最下方的表单）。</span></li>
      <li class="step"><span class="step-n">2</span><span>联系我们充值，余额到账后就能发卡。</span></li>
      <li class="step"><span class="step-n">3</span><span>按需发卡密，把兑换链接发给你的客户。</span></li>
    </ol>
  </section>

  <section class="card">
    <h2>有效期和作废规则</h2>
    <ul style="margin:0;padding-left:20px;" class="muted">
      <li>卡密默认 <strong>14 天</strong>有效，也可以设得更短。</li>
      <li>还没被用掉的卡密，你可以随时<strong>作废</strong>；过期的卡密可以<strong>回收</strong>。两种情况钱都会回到你的余额。</li>
      <li><strong>已经被使用的卡密不可撤销</strong> —— 钱已经付给 OpenRouter 了，没有回头路。</li>
    </ul>
  </section>

  <section class="card">
    <h2>怎么再次登录</h2>
    <ul style="margin:0 0 12px;padding-left:20px;" class="muted">
      <li>用<strong>我们给你的用户名和密码</strong>，就在下面的表单里登录。</li>
      <li>登录一次，会话保持 <strong>45 天</strong>。过期了、或者换了设备/浏览器，再登录一次就行。</li>
      <li><strong>密码忘了怎么办：</strong>没有自助找回。直接联系我们，我们给你发一条一次性登录链接，点开即登录，然后我们再给你换新密码。</li>
    </ul>
    <div class="note note--ok" style="margin:0;">
      充值 / 忘记密码 / 任何问题 —— 点<strong>右下角的对话按钮</strong>直接找我们。
    </div>
  </section>

  <section class="card" id="login-card">
    <h2>登录</h2>
    <form id="login-form" autocomplete="on" novalidate>
      <div style="margin-bottom:14px;">
        <label class="label" for="username">用户名</label>
        <input class="input" id="username" name="username" type="text"
               autocomplete="username" autocapitalize="none" autocorrect="off"
               spellcheck="false" placeholder="我们给你的用户名" />
      </div>
      <div style="margin-bottom:18px;">
        <label class="label" for="password">密码</label>
        <input class="input" id="password" name="password" type="password"
               autocomplete="current-password" placeholder="我们给你的密码" />
      </div>
      <button class="btn btn--block" id="login-btn" type="submit">登录</button>
    </form>
    <div id="login-msg" class="note note--err" style="display:none;margin:14px 0 0;" role="alert"></div>
  </section>

  <footer class="wrap" style="padding:8px 0 48px;">
    <p class="dim" style="margin:0;">
      有问题找我们：${c}
    </p>
  </footer>
</main>

<button id="help-fab" type="button" aria-label="联系我们">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
</button>
`
}

function script(opts: PartnerUiOptions): string {
  return `${MONEY_JS}
${analyticsScript(opts)}
(function () {
  // Copy the customer-facing script. This is what a partner pastes to a buyer,
  // so it has to survive verbatim — retyping is how the claim URL ends up wrong.
  var custBtn = document.getElementById('cust-copy-btn');
  if (custBtn) {
    custBtn.addEventListener('click', function () {
      var text = document.getElementById('cust-copy').textContent;
      function done() {
        custBtn.textContent = '已复制';
        setTimeout(function () { custBtn.textContent = '复制这段话'; }, 1600);
      }
      function fallback() {
        // execCommand path for in-app browsers (WeChat) where the async
        // clipboard API is missing or blocked outside a secure context.
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* select manually */ }
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else { fallback(); }
    });
  }

  // Intercom, booted on the first click rather than on page load: the widget is
  // a few hundred KB and nobody opening this page needs it before they ask.
  var fab = document.getElementById('help-fab');
  if (fab) {
    var booted = false;
    fab.addEventListener('click', function () {
      var settings = { app_id: 'kpfdpai7', hide_default_launcher: false };
      function show() { if (typeof window.Intercom === 'function') window.Intercom('show'); }
      if (booted) { show(); return; }
      booted = true;
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

  var form = document.getElementById('login-form');
  var btn = document.getElementById('login-btn');
  var msg = document.getElementById('login-msg');

  function fail(text) {
    msg.textContent = text;
    msg.style.display = 'block';
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    msg.style.display = 'none';
    var username = document.getElementById('username').value.trim();
    var password = document.getElementById('password').value;
    if (!username || !password) { fail('请填写用户名和密码。'); return; }
    btn.disabled = true;
    btn.textContent = '登录中…';
    fetch('/partner/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: username, password: password })
    }).then(function (r) {
      if (r.ok) {
        // Never log the username: it is half of a credential pair.
        track('partner_login', { ok: true });
        window.location.href = '/partner/app';
        return;
      }
      track('partner_login', { ok: false, status: r.status });
      // Deliberately one message for every failure mode — telling the partner
      // whether the account exists would hand an attacker an enumeration oracle.
      fail(r.status === 429
        ? '尝试太频繁，请稍后再试。'
        : '用户名或密码不正确。忘记密码请联系我们要一条登录链接。');
      btn.disabled = false;
      btn.textContent = '登录';
    }).catch(function () {
      fail('网络异常，请重试。');
      btn.disabled = false;
      btn.textContent = '登录';
    });
  });
})();
`
}

/** Renders `GET /partner` (logged-out explainer + login). */
export function renderPartnerExplainerPage(opts: PartnerUiOptions = {}): Response {
  return htmlResponse(
    htmlPage({
      title: 'ROZO 合伙人后台 · 卡密自助发放',
      bodyHtml: body(opts.contact ?? DEFAULT_CONTACT),
      script: script(opts),
    }),
  )
}
