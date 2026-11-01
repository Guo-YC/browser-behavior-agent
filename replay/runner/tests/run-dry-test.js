/**
 * 模块E 自检脚本（契约 §8 验收标准）：
 * 1. 对合规样例技能跑 dry_run：逐动作 PASS，退出码 0；
 * 2. 对缺陷样例技能跑 dry_run：默认遇失败中止，退出码 1；
 * 3. 缺陷样例追加 --continue-on-fail：跑完剩余步骤，退出码 0；
 * 4. 校验返回结构 {summary, steps, plan} 字段齐全。
 *
 * 运行：node tests/run-dry-test.js（在 replay/runner 目录下）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runSkill, loadSkill } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runnerDir = path.resolve(__dirname, '..');
const goodFile = path.join(__dirname, 'fixtures', 'sample-skill.json');
const badFile = path.join(__dirname, 'fixtures', 'broken-skill.json');

const results = [];

/** 记录一条自检结论 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

/** 计算 CLI 退出码（与 index.js 保持一致的规则） */
function expectedExitCode(result, continueOnFail) {
  if (result.summary.connectError) return 1;
  if (result.summary.failed > 0 && !continueOnFail) return 1;
  return 0;
}

/** 以子进程方式调用 CLI，返回退出码与输出 */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(runnerDir, 'index.js'), ...args], {
      cwd: runnerDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status || 1, stdout: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

async function main() {
  // ---------- 1. 合规样例：dry_run 全通过 ----------
  const good = await loadSkill({ skillFile: goodFile });
  const goodResult = await runSkill(good.skill, { mode: 'dry_run' });

  check('合规样例返回结构包含 summary / steps / plan',
    goodResult.summary && Array.isArray(goodResult.steps) && Array.isArray(goodResult.plan));
  check('合规样例最终状态为 PASS', goodResult.summary.status === 'PASS',
    `成功 ${goodResult.summary.passed} / 失败 ${goodResult.summary.failed} / 跳过 ${goodResult.summary.skipped}`);
  check('合规样例 5 个动作全部 PASS',
    goodResult.steps.every((s) => s.status === 'PASS'),
    `实际步数 ${goodResult.steps.length}`);
  check('执行计划 JSON 包含 5 条动作', goodResult.plan.length === 5);
  check('合规样例 CLI 退出码为 0',
    expectedExitCode(goodResult, false) === 0);

  // ---------- 2. 缺陷样例：默认遇失败中止，退出码 1 ----------
  const bad = await loadSkill({ skillFile: badFile });
  const badResult = await runSkill(bad.skill, { mode: 'dry_run' });

  check('缺陷样例最终状态为 FAIL', badResult.summary.status === 'FAIL',
    `成功 ${badResult.summary.passed} / 失败 ${badResult.summary.failed} / 跳过 ${badResult.summary.skipped}`);
  check('缺陷样例默认中止（aborted=true）', badResult.summary.aborted === true);
  check('缺陷样例第 1 步失败，后续步骤标记 SKIP',
    badResult.steps[0].status === 'FAIL' &&
    badResult.steps.slice(1).every((s) => s.status === 'SKIP'));
  check('缺陷样例 CLI 退出码为 1', expectedExitCode(badResult, false) === 1);

  // ---------- 3. 缺陷样例：--continue-on-fail 跑完，退出码 0 ----------
  const badContinue = await runSkill(bad.skill, {
    mode: 'dry_run',
    continueOnFail: true,
  });
  check('continue-on-fail 模式下 8 个动作全部跑完',
    badContinue.steps.length === 8,
    `实际步数 ${badContinue.steps.length}`);
  check('continue-on-fail 模式下存在失败步骤与可选跳过步骤',
    badContinue.summary.failed > 0 && badContinue.summary.skipped > 0,
    `失败 ${badContinue.summary.failed} / 跳过 ${badContinue.summary.skipped}`);
  check('continue-on-fail 模式 CLI 退出码为 0',
    expectedExitCode(badContinue, true) === 0);

  // ---------- 4. 子进程 CLI 真实退出码校验 ----------
  const cliGood = runCli(['--skill-file', goodFile, '--mode', 'dry_run']);
  check('CLI 子进程：合规样例退出码 0', cliGood.code === 0, `退出码 ${cliGood.code}`);

  const cliBad = runCli(['--skill-file', badFile, '--mode', 'dry_run']);
  check('CLI 子进程：缺陷样例默认退出码 1', cliBad.code === 1, `退出码 ${cliBad.code}`);

  const cliBadContinue = runCli([
    '--skill-file', badFile,
    '--mode', 'dry_run',
    '--continue-on-fail',
  ]);
  check('CLI 子进程：缺陷样例 --continue-on-fail 退出码 0',
    cliBadContinue.code === 0, `退出码 ${cliBadContinue.code}`);

  // ---------- 5. 报告文案校验 ----------
  check('合规样例报告含中文「回放成功」结论', goodResult.report.includes('回放成功'));
  check('缺陷样例报告含失败步骤清单', badContinue.report.includes('失败步骤清单'));
  check('报告包含执行计划 JSON 段落', goodResult.report.includes('执行计划 JSON'));

  // ---------- 汇总 ----------
  // eslint-disable-next-line no-console
  console.log('\n' + '='.repeat(60));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  // eslint-disable-next-line no-console
  console.log(`自检汇总：${passed} 项通过，${failed} 项失败`);
  // eslint-disable-next-line no-console
  console.log('='.repeat(60));

  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error('存在未通过的自检项，详见上方 [FAIL] 条目');
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('全部 dry_run 自检项通过；真机模式请执行 npm run test:live 复验（待验证清单见 README 第 6.3 节）。');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`自检脚本异常：${err.message}`);
  process.exit(1);
});
