// 真机采集链路验证：扩展 → Native Messaging Host → daemon 入库 → HTTP API 可查
// 步骤：CDP 加载未打包扩展 → 打开本地 fixture 页 → 派发真实鼠标移动/输入/点击/滚动 → 回查 daemon
//
// 前置：
//   1) daemon 已启动：node daemon/bin/daemon.js（127.0.0.1:8756）
//   2) 扩展已构建：cd extension && pnpm build
//   3) Native Host 已注册：scripts/install-native-host.ps1 -ExtensionId <扩展ID>
//   4) fixture 站点已启动：node -e "import('./serve-fixture.js').then(m=>m.startFixtureServer())"
//      （在 replay/runner/tests 目录下执行，监听 127.0.0.1:18923）
//   5) Chrome 带调试端口启动：
//      chrome.exe --user-data-dir=<临时目录> --headless=new --remote-debugging-port=9222
//                 --enable-unsafe-extension-debugging --no-first-run
//
// 运行：node scripts/verify-live-collect.mjs [CDP端口] [扩展产物目录] [测试页URL] [daemon地址]
const port = process.argv[2] || '9222';
const extPath = process.argv[3];
const pageUrl = process.argv[4] || 'http://127.0.0.1:18923/local-page.html';
const daemonUrl = process.argv[5] || 'http://127.0.0.1:8756';

const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });

let seq = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function send(method, params = {}, sessionId) {
  const id = seq++;
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + method)), 30000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ' -> ' + JSON.stringify(m.error))) : res(m.result); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 加载扩展，拿真实 ID
const { id: extId } = await send('Extensions.loadUnpacked', { path: extPath });
console.log('扩展已加载，ID =', extId);

// 2) 打开 fixture 页面
const { targetId } = await send('Target.createTarget', { url: pageUrl });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await sleep(2500); // 等 content script 注入

// 3) 真实输入：聚焦搜索框并打字
const rect = (sel) => send('Runtime.evaluate', {
  expression: `(()=>{const e=document.querySelector('${sel}');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  returnByValue: true,
}, sessionId).then((r) => r.result.value);

const inputRect = await rect('#q');
if (!inputRect) throw new Error('未找到 #q 元素');
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: inputRect.x, y: inputRect.y }, sessionId);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inputRect.x, y: inputRect.y, button: 'left', clickCount: 1 }, sessionId);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputRect.x, y: inputRect.y, button: 'left', clickCount: 1 }, sessionId);
await send('Input.insertText', { text: '真机采集验证' }, sessionId);
console.log('已在搜索框输入文本');

// 4) 真实滚动
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: 400, deltaX: 0, deltaY: 240 }, sessionId);
console.log('已派发滚动');

// 5) 真实点击「搜索」按钮
const btnRect = await rect('#submit');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnRect.x, y: btnRect.y, button: 'left', clickCount: 1 }, sessionId);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnRect.x, y: btnRect.y, button: 'left', clickCount: 1 }, sessionId);
console.log('已点击「搜索」按钮');

// 6) 等扩展批量上报（Native Messaging）
await sleep(6000);

// 7) 查 daemon
const sites = await (await fetch(`${daemonUrl}/api/sites`)).json();
const hit = sites.filter((s) => String(s.domain).includes('127.0.0.1'));
console.log('\n[daemon] 采集到的站点:', sites.map((s) => `${s.domain}(${s.eventCount})`).join(', '));
if (hit.length) {
  const d = hit[0].domain;
  const b = await (await fetch(`${daemonUrl}/api/behaviors?domain=${encodeURIComponent(d)}&limit=8`)).json();
  console.log(`[daemon] ${d} 行为总数=${b.total}，最近记录：`);
  for (const it of b.items) console.log('   -', it.type, '|', it.url, '|', it.selector || '');
  const q = await (await fetch(`${daemonUrl}/api/search?q=${encodeURIComponent('真机采集验证')}`)).json();
  console.log('[daemon] 全文检索「真机采集验证」命中条数 =', Array.isArray(q) ? q.length : 0);
} else {
  console.log('[结果] 未采集到 127.0.0.1 站点数据');
}

ws.close();
process.exit(0);
