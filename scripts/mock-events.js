#!/usr/bin/env node
/**
 * mock-events.js — 模拟扩展批量事件，灌入本地守护进程（HTTP /api/events）
 * 用途：端到端最小链路验证 + 为技能蒸馏提供含重复链的轨迹数据
 * 用法：
 *   node scripts/mock-events.js                    # 默认 POST http://127.0.0.1:8756
 *   node scripts/mock-events.js --url <base>       # 指定 daemon 地址
 *   node scripts/mock-events.js --out data.json    # 只写文件不发送
 *   node scripts/mock-events.js --domains demo     # 只灌指定域
 * 事件字段严格遵循 docs/CONTRACTS.md §1.2/§1.3。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NOW = Date.now();
const MIN = 60_000;
function ev(type, sessionId, tabId, url, title, detail, ts = null) {
  const u = new URL(url);
  return { type, ts: ts ?? Date.now(), sessionId, tabId, url, title, domain: u.hostname.toLowerCase().replace(/^www\./, ''), ...(detail ? { detail } : {}) };
}
function makeOrderSession(seed, tabId) {
  const sessionId = `s_mock_${seed}`;
  const base = NOW - (10 - seed) * MIN;
  const events = []; let t = base;
  const push = (e) => { e.ts = t; events.push(e); t += 1200 + Math.floor(Math.random() * 800); };
  push(ev('session_start', sessionId, tabId, 'https://example.com/', '示例商城 - 首页', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', screenWidth: 1920, screenHeight: 1080, startUrl: 'https://example.com/' }));
  push(ev('page_load', sessionId, tabId, 'https://example.com/', '示例商城 - 首页', { referrer: '', title: '示例商城 - 首页' }));
  push(ev('mousemove', sessionId, tabId, 'https://example.com/', '示例商城 - 首页', { selector: 'html > body > div#app > header > nav > a[href="/products"]', clientX: 320, clientY: 40 }));
  push(ev('scroll', sessionId, tabId, 'https://example.com/', '示例商城 - 首页', { scrollX: 0, scrollY: 400, scrollHeight: 1800, clientHeight: 900, direction: 'down' }));
  push(ev('click', sessionId, tabId, 'https://example.com/', '示例商城 - 首页', { selector: 'html > body > div#app > div.product-list > div.card[data-pid="p100"] > button.btn-view', element: { tag: 'BUTTON', id: '', class: 'btn-view', text: '查看商品', href: '', role: '', ariaLabel: '', inputType: '', redacted: false }, button: 0, clientX: 640, clientY: 480 }));
  push(ev('navigation', sessionId, tabId, 'https://example.com/product/p100', '无线机械键盘 K100', { url: 'https://example.com/product/p100', title: '无线机械键盘 K100', transitionType: 'link' }));
  push(ev('page_load', sessionId, tabId, 'https://example.com/product/p100', '无线机械键盘 K100', { referrer: 'https://example.com/', title: '无线机械键盘 K100' }));
  push(ev('focus', sessionId, tabId, 'https://example.com/product/p100', '无线机械键盘 K100', { selector: 'html > body > div#app > div.product-detail > div.buy-box > input.qty-input', element: { tag: 'INPUT', id: '', class: 'qty-input', text: '', href: '', role: 'spinbutton', ariaLabel: '购买数量', inputType: 'number', redacted: false } }));
  push(ev('input', sessionId, tabId, 'https://example.com/product/p100', '无线机械键盘 K100', { selector: 'html > body > div#app > div.product-detail > div.buy-box > input.qty-input', element: { tag: 'INPUT', id: '', class: 'qty-input', text: '', href: '', role: 'spinbutton', ariaLabel: '购买数量', inputType: 'number', redacted: false }, inputType: 'insertText', value: '2' }));
  push(ev('click', sessionId, tabId, 'https://example.com/product/p100', '无线机械键盘 K100', { selector: 'html > body > div#app > div.product-detail > div.buy-box > button.btn-add-cart', element: { tag: 'BUTTON', id: '', class: 'btn-add-cart', text: '加入购物车', href: '', role: '', ariaLabel: '', inputType: '', redacted: false }, button: 0, clientX: 900, clientY: 700 }));
  push(ev('request', sessionId, tabId, 'https://example.com/product/p100', '无线机械键盘 K100', { method: 'POST', requestUrl: 'https://example.com/api/cart/add', status: 200, durationMs: 180, resourceType: 'xhr', reqHeaders: { 'content-type': 'application/json' }, respHeaders: { 'content-type': 'application/json' }, postBodyPreview: '{"pid":"p100","qty":2}' }));
  push(ev('navigation', sessionId, tabId, 'https://example.com/cart', '购物车', { url: 'https://example.com/cart', title: '购物车', transitionType: 'link' }));
  push(ev('page_load', sessionId, tabId, 'https://example.com/cart', '购物车', { referrer: 'https://example.com/product/p100', title: '购物车' }));
  push(ev('click', sessionId, tabId, 'https://example.com/cart', '购物车', { selector: 'html > body > div#app > div.cart-page > div.cart-footer > button.btn-checkout', element: { tag: 'BUTTON', id: '', class: 'btn-checkout', text: '去结算', href: '', role: '', ariaLabel: '', inputType: '', redacted: false }, button: 0, clientX: 1000, clientY: 980 }));
  push(ev('navigation', sessionId, tabId, 'https://example.com/checkout', '结算', { url: 'https://example.com/checkout', title: '结算', transitionType: 'link' }));
  push(ev('page_load', sessionId, tabId, 'https://example.com/checkout', '结算', { referrer: 'https://example.com/cart', title: '结算' }));
  push(ev('click', sessionId, tabId, 'https://example.com/checkout', '结算', { selector: 'html > body > div#app > div.checkout-page > form.order-form > button.btn-submit-order', element: { tag: 'BUTTON', id: '', class: 'btn-submit-order', text: '提交订单', href: '', role: '', ariaLabel: '', inputType: '', redacted: false }, button: 0, clientX: 960, clientY: 860 }));
  push(ev('request', sessionId, tabId, 'https://example.com/checkout', '结算', { method: 'POST', requestUrl: 'https://example.com/api/order/create', status: 201, durationMs: 420, resourceType: 'xhr', reqHeaders: { 'content-type': 'application/json' }, respHeaders: { 'content-type': 'application/json' }, postBodyPreview: '{"items":[{"pid":"p100","qty":2}]}' }));
  push(ev('navigation', sessionId, tabId, 'https://example.com/order/10086', '订单成功', { url: 'https://example.com/order/10086', title: '订单成功', transitionType: 'link' }));
  push(ev('page_load', sessionId, tabId, 'https://example.com/order/10086', '订单成功', { referrer: 'https://example.com/checkout', title: '订单成功' }));
  push(ev('session_end', sessionId, tabId, 'https://example.com/order/10086', '订单成功', { reason: 'tab_close' }));
  return events;
}
function makeDocsSession() {
  const sessionId = 's_mock_docs_1'; const events = []; let t = NOW - 60 * MIN;
  const push = (e) => { e.ts = t; events.push(e); t += 1500; };
  push(ev('session_start', sessionId, 7, 'https://docs.example.org/', '文档中心', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', screenWidth: 1440, screenHeight: 900, startUrl: 'https://docs.example.org/' }));
  push(ev('page_load', sessionId, 7, 'https://docs.example.org/', '文档中心', { referrer: '', title: '文档中心' }));
  push(ev('input', sessionId, 7, 'https://docs.example.org/', '文档中心', { selector: 'html > body > header > form.search-box > input.search-input', element: { tag: 'INPUT', id: '', class: 'search-input', text: '', href: '', role: 'searchbox', ariaLabel: '搜索文档', inputType: 'text', redacted: false }, inputType: 'insertText', value: 'MCP 接入' }));
  push(ev('keydown', sessionId, 7, 'https://docs.example.org/', '文档中心', { selector: 'html > body > header > form.search-box > input.search-input', key: 'Enter', code: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }));
  push(ev('navigation', sessionId, 7, 'https://docs.example.org/search?q=MCP', '搜索结果', { url: 'https://docs.example.org/search?q=MCP', title: '搜索结果', transitionType: 'typed' }));
  push(ev('page_load', sessionId, 7, 'https://docs.example.org/search?q=MCP', '搜索结果', { referrer: 'https://docs.example.org/', title: '搜索结果' }));
  push(ev('session_end', sessionId, 7, 'https://docs.example.org/search?q=MCP', '搜索结果', { reason: 'idle' }));
  return events;
}
export function buildAllEvents(scope = 'all') {
  const events = [];
  if (scope === 'all' || scope === 'example.com') { for (let seed = 1; seed <= 3; seed++) events.push(...makeOrderSession(seed, seed)); }
  if (scope === 'all' || scope === 'docs.example.org') events.push(...makeDocsSession());
  return events;
}
async function main() {
  const args = process.argv.slice(2);
  const urlArg = args.find((a) => a.startsWith('--url='))?.split('=')[1] ?? 'http://127.0.0.1:8756';
  const outArg = args.find((a) => a.startsWith('--out='))?.split('=')[1];
  const scopeArg = args.find((a) => a.startsWith('--domains='))?.split('=')[1] ?? 'all';
  const events = buildAllEvents(scopeArg);
  const envelope = { type: 'batch', seq: 1, events };
  const summary = { total: events.length, sessions: new Set(events.map((e) => e.sessionId)).size, domains: [...new Set(events.map((e) => e.domain))], types: [...new Set(events.map((e) => e.type))] };
  console.log(`[mock-events] 生成 ${summary.total} 条事件（${summary.sessions} 个会话，域名: ${summary.domains.join(', ')}）`);
  console.log(`[mock-events] 事件类型: ${summary.types.join(', ')}`);
  if (outArg) { writeFileSync(outArg, JSON.stringify(envelope, null, 2)); console.log(`[mock-events] 已写入 ${outArg}（未发送）`); return; }
  try {
    const resp = await fetch(`${urlArg}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
    const body = await resp.json();
    if (!resp.ok || !body.ok) { console.error(`[mock-events] 发送失败: HTTP ${resp.status} ${JSON.stringify(body)}`); process.exit(1); }
    console.log(`[mock-events] 发送成功: 收到 ${body.received}，新插入 ${body.inserted}，去重忽略 ${body.ignored}`);
  } catch (err) { console.error(`[mock-events] 无法连接 daemon ${urlArg}：${err.message}`); console.error(`[mock-events] 提示：先启动 daemon（node daemon/bin/daemon.js），或用 --out 导出后经 cli ingest 导入`); process.exit(1); }
}
main();
