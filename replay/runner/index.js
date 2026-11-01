/**
 * 模块E 入口：CLI 命令行 + ESM 导出（供 MCP 模块 trigger_replay 调用）。
 *
 * 用法：
 *   node replay/runner/index.js --skill <skillId> --mode dry_run
 *   node replay/runner/index.js --skill-file ./tests/fixtures/sample-skill.json --mode cdp --headless
 *
 * ESM 导出：
 *   import { runSkill, loadSkill } from './index.js';
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { runSkill } from './src/executor.js';
import { loadSkill } from './src/loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  await readFile(path.join(__dirname, 'package.json'), 'utf8'),
);

export { runSkill, loadSkill };

/** 帮助文本（全中文） */
const HELP_TEXT = `用法：node replay/runner/index.js --skill <skillId> [选项]

浏览器行为技能回放执行器（模块E）：把蒸馏产出的技能 JSON 转为确定性回放动作链，
支持预检、CDP 真机、Playwright 真机三种模式（契约 §6）。

必填项（二选一）：
  --skill <skillId>       技能 ID，自动读取 replay/skills/<skillId>.json
  --skill-file <路径>     直接指定技能 JSON 文件（绝对路径，或相对当前工作目录）

选项：
  --mode <模式>           dry_run（默认，预检不连浏览器）| cdp（CDP 真机）| playwright
  --headless              无头模式（仅 playwright 本机启动 Chrome 时生效）
  --target-url <网址>     连接后首先导航到该网址
  --continue-on-fail      非可选动作失败后继续跑完剩余步骤（默认遇失败即中止）
  -h, --help              显示本帮助
  --version               显示版本号

退出码：
  0  回放全部通过；或已开启 --continue-on-fail 跑完剩余步骤
  1  存在失败步骤且未开启 --continue-on-fail；浏览器连接失败同样返回 1

示例：
  # 预检样例技能（不连浏览器）
  node replay/runner/index.js --skill-file tests/fixtures/sample-skill.json --mode dry_run

  # CDP 真机回放（Chrome 需先以 --remote-debugging-port=9222 启动）
  node replay/runner/index.js --skill skl_demo000000000001 --mode cdp

  # Playwright 驱动本机 Chrome，无头运行，失败后继续
  node replay/runner/index.js --skill skl_demo000000000001 --mode playwright --headless --continue-on-fail
`;

/**
 * 解析命令行参数。
 * @param {string[]} argv 原始参数（不含 node 与脚本路径）
 * @returns {object} 解析结果 {options, help, version, errors}
 */
function parseArgs(argv) {
  const options = {
    mode: 'dry_run',
    headless: false,
    continueOnFail: false,
  };
  const errors = [];
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--skill':
        options.skillId = argv[++i];
        break;
      case '--skill-file':
        options.skillFile = argv[++i];
        break;
      case '--mode': {
        const mode = argv[++i];
        if (!['dry_run', 'cdp', 'playwright'].includes(mode)) {
          errors.push(`不支持的模式：${mode}（允许 dry_run / cdp / playwright）`);
        } else {
          options.mode = mode;
        }
        break;
      }
      case '--headless':
        options.headless = true;
        break;
      case '--target-url':
        options.targetUrl = argv[++i];
        break;
      case '--continue-on-fail':
        options.continueOnFail = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      case '--version':
        version = true;
        break;
      default:
        if (arg.startsWith('--')) {
          errors.push(`未知参数：${arg}`);
        } else {
          errors.push(`无法识别的参数：${arg}`);
        }
        break;
    }
  }

  if (!options.skillId && !options.skillFile) {
    errors.push('缺少技能标识：请使用 --skill <skillId> 或 --skill-file <路径>');
  }

  return { options, help, version, errors };
}

/** CLI 主流程 */
async function main() {
  const argv = process.argv.slice(2);
  const { options, help, version, errors } = parseArgs(argv);

  if (help) {
    // eslint-disable-next-line no-console
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (version) {
    // eslint-disable-next-line no-console
    console.log(`${pkg.name}@${pkg.version}`);
    process.exit(0);
  }
  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('参数错误：');
    for (const e of errors) console.error(`  - ${e}`);
    // eslint-disable-next-line no-console
    console.error('\n使用 --help 查看用法');
    process.exit(2);
  }

  let loaded;
  try {
    loaded = await loadSkill({ skillId: options.skillId, skillFile: options.skillFile });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`加载技能失败：${err.message}`);
    process.exit(1);
  }

  const { skill, filePath } = loaded;
  // eslint-disable-next-line no-console
  console.log(`已加载技能：${filePath}\n`);

  let result;
  try {
    result = await runSkill(skill, {
      mode: options.mode,
      headless: options.headless,
      targetUrl: options.targetUrl,
      continueOnFail: options.continueOnFail,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`回放执行异常：${err.message}`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(result.report);

  // 退出码：连接失败或存在失败步骤且未开启 continueOn-fail → 1
  const failed = result.summary.failed > 0;
  if (result.summary.connectError || (failed && !options.continueOnFail)) {
    process.exit(1);
  }
  process.exit(0);
}

// 仅作为脚本直接执行时启动 CLI；被 ESM import 时不自动运行
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`未捕获异常：${err.message}`);
    process.exit(1);
  });
}
