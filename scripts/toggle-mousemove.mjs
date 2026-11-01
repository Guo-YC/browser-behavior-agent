// 关闭扩展的 mousemove 采样（降低噪声，保留 click/input/scroll/navigation 等有效行为）
// 前置：Chrome 以 --remote-debugging-port=<端口> --enable-unsafe-extension-debugging 启动且已装载扩展
// 用法：node scripts/toggle-mousemove.mjs [端口] [true|false]
const port = process.argv[2] || '9222';
const turnOn = process.argv[3] === 'true';

const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')); });

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
    const t = setTimeout(() => rej(new Error('timeout ' + method)), 20000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ' -> ' + JSON.stringify(m.error))) : res(m.result); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { targetInfos } = await send('Target.getTargets');
const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('chrome-extension://'));
if (!sw) throw new Error('未找到扩展 service_worker，请确认扩展已装载');

const { sessionId } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);

const r = await send('Runtime.evaluate', {
  expression: `(async () => {
    const KEY = 'behavior.collector.config';
    const cur = (await chrome.storage.local.get(KEY))[KEY] || {};
    cur.sampleMousemove = ${turnOn};
    await chrome.storage.local.set({ [KEY]: cur });
    await new Promise(r => setTimeout(r, 300));
    return JSON.stringify((await chrome.storage.local.get(KEY))[KEY]);
  })()`,
  awaitPromise: true,
  returnByValue: true,
}, sessionId);

console.log('当前配置：', r.result.value);
ws.close();
process.exit(0);
