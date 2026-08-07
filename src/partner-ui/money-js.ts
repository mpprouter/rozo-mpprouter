/**
 * Shared browser-side money helpers for the partner UI.
 *
 * This is a *string* of plain ES2020 JavaScript, not a TypeScript module, and
 * that is deliberate. Every number the partner sees (balance, face value, the
 * "约可发 N credits" promise, the confirmation panel) is computed in the
 * browser from the atomic-USD strings the API returns. If the same logic also
 * lived as TS functions on the server we would have two implementations of the
 * money math and only one of them under test.
 *
 * So: this string is the single source of truth. It is injected verbatim into
 * every partner page, and the unit tests evaluate this exact string. What the
 * tests assert is what the browser runs.
 *
 * Money rules encoded here:
 *  - Amounts are atomic USD (6 decimals) as strings; all arithmetic is BigInt.
 *    No float ever touches money.
 *  - 1 credit <-> $1.05 face value. The 5% is OpenRouter's crypto-payment
 *    surcharge, charged by OpenRouter, not by Rozo.
 *  - `creditsAffordable` floors (BigInt division truncates). That line is a
 *    promise about what the partner can actually do — $5.50 shows 5, never 5.2
 *    and never 6, because 6 would make the button fail with
 *    INSUFFICIENT_BALANCE.
 */
export const MONEY_JS = `
var ATOMIC_ONE = 1000000n;
/** 1 credit = $1.05 face value. */
var CREDIT_ATOMIC = 1050000n;
/** Server-side cap, mirrored here only so the UI can warn early. */
var MAX_FACE_ATOMIC = 1050000000n;

/** Atomic USD string -> "52.50". Truncates (never rounds up) past 2dp. */
function atomicToUsd(a) {
  var n = BigInt(a);
  var neg = n < 0n;
  if (neg) n = -n;
  var whole = n / ATOMIC_ONE;
  var cents = (n % ATOMIC_ONE) / 10000n;
  return (neg ? '-' : '') + whole.toString() + '.' + cents.toString().padStart(2, '0');
}

/** "52.5" -> "52500000". Returns null when the input is not a plain amount. */
function usdToAtomic(s) {
  var m = String(s).trim().match(/^(\\d{1,9})(?:\\.(\\d{1,6}))?$/);
  if (!m) return null;
  var frac = (m[2] || '').padEnd(6, '0');
  return (BigInt(m[1]) * ATOMIC_ONE + BigInt(frac)).toString();
}

/**
 * How many whole credits this balance can actually buy.
 * FLOOR, always: BigInt division truncates, so $5.50 / $1.05 = 5, not 5.238
 * and not 6. Rounding up here would hand the partner a button that 402s.
 */
function creditsAffordable(balanceAtomic) {
  var b = BigInt(balanceAtomic);
  if (b <= 0n) return 0;
  return Number(b / CREDIT_ATOMIC);
}

/** credits (decimal string, <=2dp) -> face value in atomic USD. */
function creditsToFaceAtomic(credits) {
  var a = usdToAtomic(credits);
  if (a === null) return null;
  return ((BigInt(a) * 105n) / 100n).toString();
}

/** face value (atomic) -> credits label, e.g. "52500000" -> "50". */
function faceAtomicToCreditsLabel(faceAtomic) {
  var c100 = (BigInt(faceAtomic) * 100n) / CREDIT_ATOMIC;
  var whole = c100 / 100n;
  var rest = c100 % 100n;
  if (rest === 0n) return whole.toString();
  var s = rest.toString().padStart(2, '0').replace(/0$/, '');
  return whole.toString() + '.' + s;
}

/** Pads a 2-or-4 CJK-char label to a fixed monospace column. */
function padPartnerLabel(label) {
  return label + ' '.repeat((4 - label.length) * 2 + 4);
}

/**
 * The issue confirmation panel.
 *
 * The fee-attribution lines are reproduced verbatim from the spec and must not
 * be reworded: the partner has to be able to see that the 5% is OpenRouter's
 * surcharge and not a Rozo margin. There is a unit test pinning this output
 * character for character.
 */
function buildIssueConfirmText(creditsLabel, faceAtomic, balanceAtomic) {
  var face = atomicToUsd(faceAtomic);
  var bal = atomicToUsd(balanceAtomic);
  var after = atomicToUsd((BigInt(balanceAtomic) - BigInt(faceAtomic)).toString());
  var creditAtomic = usdToAtomic(creditsLabel) || '0';
  var credit = atomicToUsd(creditAtomic);
  var fee = atomicToUsd((BigInt(faceAtomic) - BigInt(creditAtomic)).toString());
  var w = Math.max(credit.length, fee.length);
  var indent = '              ';
  return [
    '发放卡密',
    '  ' + padPartnerLabel('面值') + creditsLabel + ' credits',
    '  ' + padPartnerLabel('卡密面额') + '$' + face,
    indent + '├ ' + credit.padStart(w) + '  OpenRouter 额度',
    indent + '└ ' + fee.padStart(w) + '  OpenRouter 加密支付手续费 5%（OpenRouter 收取，非 Rozo）',
    '  ' + padPartnerLabel('当前余额') + '$' + bal + '  →  发放后 $' + after,
    '',
    '  ⚠️ 客户在 OpenRouter 生成的支付链接金额必须正好是 $' + face
  ].join('\\n');
}

/** Customer-facing message the partner one-taps to copy. */
function buildCustomerMessage(code, faceAtomic, claimUrl, expiresAt) {
  var face = atomicToUsd(faceAtomic);
  return [
    '你的 OpenRouter 充值码：' + code,
    '面额：$' + face,
    '',
    '使用步骤：',
    '1. 在 OpenRouter 里生成一条金额正好是 $' + face + ' 的加密支付链接',
    '2. 打开 ' + claimUrl,
    '3. 贴上支付链接 + 输入充值码，点「立即兑换」',
    '',
    '有效期至：' + formatWhen(expiresAt) + '（过期后失效，请尽快使用）'
  ].join('\\n');
}

/** ISO timestamp -> local "YYYY-MM-DD HH:mm". Never throws on bad input. */
function formatWhen(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** Last 4 digits of a coupon code. Never log or transmit the full code. */
function codeLast4(code) {
  return String(code || '').slice(-4);
}

/**
 * Presentation state for one coupon row.
 * Four buckets only (spec §3.11): 未使用 / 兑换中 / 已使用 / 已作废或已过期.
 */
function couponStatusView(c) {
  var s = c && c.status;
  if (s === 'issued') {
    return { label: '未使用', tone: 'ok', actionable: !!c.refundable, reason: '' };
  }
  if (s === 'redeeming' || s === 'paying' || s === 'manual_review') {
    return { label: '兑换中', tone: 'busy', actionable: false, reason: '兑换进行中，不能作废' };
  }
  if (s === 'redeemed') {
    return { label: '已使用', tone: 'done', actionable: false, reason: '已使用，不可撤销' };
  }
  if (s === 'void' || s === 'expired') {
    return {
      label: '已作废或已过期',
      tone: 'dead',
      actionable: !!c.refundable,
      reason: c && c.refundable ? '' : '已回收，钱已回到余额'
    };
  }
  return { label: String(s || '未知'), tone: 'dead', actionable: false, reason: '状态未知' };
}
`
