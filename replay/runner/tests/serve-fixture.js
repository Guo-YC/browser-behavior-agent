/**
 * 真机自测静态服务：在 127.0.0.1:18923 提供 tests/fixtures/local-page.html。
 * 既可作为模块被 run-live-test.js 调用，也可单独启动供手工浏览器访问。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
export const FIXTURE_PORT = 18923;

/**
 * 启动静态服务，返回 server 实例（调用方负责 close）。
 * @returns {Promise<import('node:http').Server>}
 */
export function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = urlPath === '/' ? 'local-page.html' : urlPath;
      const file = path.join(FIXTURE_DIR, rel);
      try {
        const data = await readFile(file);
        res.writeHead(200, {
          'Content-Type': file.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : 'application/octet-stream',
        });
        res.end(data);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('未找到自测资源');
      }
    });
    server.on('error', reject);
    server.listen(FIXTURE_PORT, '127.0.0.1', () => resolve(server));
  });
}

// 单独启动：node tests/serve-fixture.js
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const server = await startFixtureServer();
  // eslint-disable-next-line no-console
  console.log(
    `自测静态服务已启动：http://127.0.0.1:${FIXTURE_PORT}/local-page.html（Ctrl+C 退出）`,
  );
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}
