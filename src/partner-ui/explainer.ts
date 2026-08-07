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
    <p class="muted" style="max-width:560px;">
      这是给你的自助工具：登录后自己发 OpenRouter 充值卡密，卖给你的客户。
      我们不赚差价、不抽成 —— 你的利润在你卖给客户的那一层。
    </p>
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
    <h2>价格：1 credit = $1.05</h2>
    <p class="muted" style="margin-bottom:10px;">
      余额记<strong>美金</strong>。发一张 50 credits 的卡，扣你 50 × 1.05 = <strong>$52.50</strong>。
    </p>
    <div class="note note--warn">
      那 <strong>5%</strong> 是 <strong>OpenRouter 对加密支付收取的手续费，由 OpenRouter 收取，不是 Rozo 收的</strong>。
      我们原样透传，不加价、不打折。
    </div>
    <p class="dim" style="margin:0;">
      单张卡面额上限 $1050，下限 1 credit（$1.05）。
    </p>
  </section>

  <section class="card">
    <h2>你的客户怎么用这张卡</h2>
    <ol class="steps">
      <li class="step"><span class="step-n">1</span><span>你把发卡后拿到的 <code>claimUrl</code> 兑换链接和卡密发给他。</span></li>
      <li class="step"><span class="step-n">2</span><span>他在 OpenRouter 里生成一条<strong>金额正好等于卡密面额</strong>的加密支付链接。金额对不上会被拒。</span></li>
      <li class="step"><span class="step-n">3</span><span>他打开兑换页，贴上支付链接 + 输入卡密，我们替他把这张单付掉。</span></li>
    </ol>
    <p class="dim" style="margin:12px 0 0;">
      卡密是<strong>持有即可用</strong>的凭证 —— 谁拿到谁能兑。发出去之后请自己保管好，别群发、别公开贴。
    </p>
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
      联系我们（充值 / 忘记密码 / 任何问题）：<strong>${c}</strong>
    </div>
  </section>

  <section class="card" id="login-card">
    <h2>登录</h2>
    <p class="dim" style="margin-top:-2px;">没有注册入口 —— 账号由我们开通。</p>
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
`
}

function script(opts: PartnerUiOptions): string {
  return `${MONEY_JS}
${analyticsScript(opts)}
(function () {
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
