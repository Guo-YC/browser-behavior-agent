// 把已构建的扩展装入一个「已在运行、且带 --enable-unsafe-extension-debugging」的 Chrome
// 原理：CDP 的 Extensions.loadUnpacked（Chrome 137+ 起命令行 --load-extension 已失效）
//
// 前置：Chrome 以 --remote-debugging-port=<端口> --enable-unsafe-extension-debugging 启动
// 运行：node scripts/load-extension-cdp.mjs [端口] [扩展产物目录]
// 默认：端口 9222，产物目录 <项目根>/extension/.output/chrome-mv3
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.argv[2] || '9222';
const extPath = process.argv[3] || path.join(projectRoot, 'extension', '.output', 'chrome-mv3');

const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('无法连接 CDP，请先启动带调试端口的 Chrome')); });

let seq = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function send(method, params = {}) {
  const id = seq++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + method)), 30000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ' -> ' + JSON.stringify(m.error))) : res(m.result); });
  });
}

const { id } = await send('Extensions.loadUnpacked', { path: extPath });
console.log('EXT_ID=' + id);
ws.close();
process.exit(0);
