/**
 * 真机端到端自测（cdp / playwright 两种模式各跑一遍本地静态页技能）。
 *
 * 前置条件：本机 Chrome 已以 --remote-debugging-port=9222 启动（playwright 模式会优先接管该端口）。
 * 若 9222 不可达，本脚本标记该模式为「待真机验证」并跳过，不视为代码失败；
 * 若浏览器已连接但动作 / 断言失败，则判定代码缺陷并以退出码 1 结束。
 *
 * 运行：node tests/run-live-test.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSkill, loadSkill } from '../index.js';
import { startFixtureServer, FIXTURE_PORT } from './serve-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillFile = path.join(__dirname, 'fixtures', 'local-skill.json');

const MODES = ['cdp', 'playwright'];

async function main() {
  const server = await startFixtureServer();
  // eslint-disable-next-line no-console
  console.log(`自测静态服务：http://127.0.0.1:${FIXTURE_PORT}/local-page.html\n`);

  const results = [];
  let code = 0;

  for (const mode of MODES) {
    // eslint-disable-next-line no-console
    console.log('='.repeat(64));
    // eslint-disable-next-line no-console
    console.log(`真机回放：${mode} 模式`);
    // eslint-disable-next-line no-console
    console.log('='.repeat(64));

    const { skill } = await loadSkill({ skillFile });
    let result;
    try {
      result = await runSkill(skill, { mode, targetUrl: `http://127.0.0.1:${FIXTURE_PORT}/local-page.html` });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[FAIL] ${mode} 模式执行异常：${err.message}`);
      results.push({ mode, status: 'FAIL', reason: err.message });
      code = 1;
      continue;
    }

    // 浏览器连接失败：明确标注待真机验证，不计入代码失败
    if (result.summary.connectError) {
      // eslint-disable-next-line no-console
      console.warn(`[待真机验证] ${mode} 模式未能连接浏览器：${result.summary.connectError}`);
      results.push({ mode, status: 'PENDING', reason: result.summary.connectError });
      continue;
    }

    // eslint-disable-next-line no-console
    console.log(result.report);

    if (result.summary.status === 'PASS') {
      results.push({ mode, status: 'PASS', summary: result.summary });
    } else {
      // eslint-disable-next-line no-console
      console.error(`[FAIL] ${mode} 模式未通过：${result.summary.message}`);
      results.push({ mode, status: 'FAIL', summary: result.summary });
      code = 1;
    }
  }

  // 浏览器对静态资源保持 keep-alive 长连接，直接 close 会等待连接超时；
  // 先强制关闭所有存活连接，再关闭服务监听。
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve(null));
  });

  // eslint-disable-next-line no-console
  console.log('\n' + '='.repeat(64));
  // eslint-disable-next-line no-console
  console.log('真机自测汇总');
  // eslint-disable-next-line no-console
  console.log('='.repeat(64));
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.mode.padEnd(12)} ${r.status}${r.summary ? `：成功 ${r.summary.passed} / 失败 ${r.summary.failed} / 跳过 ${r.summary.skipped}` : `：${r.reason}`}`);
  }

  if (code !== 0) {
    // eslint-disable-next-line no-console
    console.error('\n存在未通过的真机动作，请按上方失败步骤清单排查选择器与页面结构。');
  } else if (results.some((r) => r.status === 'PENDING')) {
    // eslint-disable-next-line no-console
    console.log('\n说明：部分模式未能连接浏览器，已标记「待真机验证」；准备步骤见 replay/README.md。');
  } else {
    // eslint-disable-next-line no-console
    console.log('\ncdp / playwright 真机端到端全部通过。');
  }
  process.exit(code);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`真机自测异常：${err.message}`);
  process.exit(1);
});
