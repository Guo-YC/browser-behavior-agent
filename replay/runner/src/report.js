/**
 * 中文汇总报告生成：控制台打印与返回结构共用同一份文案。
 * 状态标签：PASS 成功 / FAIL 失败 / SKIP 跳过。
 */
import { STEP_STATUS, MODES, ACTION_LABELS } from './contract.js';

const STATUS_LABEL = {
  [STEP_STATUS.PASS]: '成功',
  [STEP_STATUS.FAIL]: '失败',
  [STEP_STATUS.SKIP]: '跳过',
};

const MODE_LABEL = {
  [MODES.DRY_RUN]: '预检（dry_run，不连接浏览器）',
  [MODES.CDP]: 'CDP 真机回放（chrome-remote-interface）',
  [MODES.PLAYWRIGHT]: 'Playwright 真机回放（playwright-core）',
};

/** 状态行前缀，便于日志检索 */
function statusTag(status) {
  return `[${status}] ${STATUS_LABEL[status] || status}`;
}

/** 连接失败时给出的真机准备提示 */
function connectionHint(summary) {
  if (!summary.connectError) return [];
  const lines = [
    '【真机准备提示】',
    '1. 确认本机已安装 Chrome / Chromium；',
    '2. CDP 模式请先启动调试端口：',
    '   Chrome --remote-debugging-port=9222 --user-data-dir=<独立用户数据目录>',
    '3. Playwright 模式优先接管上述 9222 端口；未启动时会回退调用本机 Chrome（channel: chrome）；',
    '4. 无头回放：CLI 追加 --headless（仅 playwright 本机启动时生效）；',
    '5. 详细步骤见 replay/README.md「真机回放准备」章节。',
  ];
  return lines;
}

/**
 * 生成中文报告文本。
 * @param {object} skill 技能对象
 * @param {{summary: object, steps: object[], plan: object[]}} result 执行结果
 * @returns {string} 完整报告文本
 */
export function buildReport(skill, result) {
  const { summary, steps, plan } = result;
  const lines = [];

  const divider = '='.repeat(64);
  const subDivider = '-'.repeat(64);

  lines.push(divider);
  lines.push(`浏览器行为技能回放报告`);
  lines.push(divider);
  lines.push(`技能名称：${skill.name}`);
  lines.push(`技能 ID：${skill.skillId}`);
  lines.push(`所属域名：${skill.domain}`);
  if (skill.description) lines.push(`技能说明：${skill.description}`);
  lines.push(`回放模式：${MODE_LABEL[summary.mode] || summary.mode}`);
  lines.push(
    `运行选项：${summary.headless ? '无头模式' : '有头模式'}` +
      `${summary.targetUrl ? `；目标网址 ${summary.targetUrl}` : ''}` +
      `；失败策略：${summary.continueOnFail ? '失败后继续（--continue-on-fail）' : '非可选失败即中止'}`,
  );
  lines.push(`开始时间：${new Date(summary.startedAt).toLocaleString('zh-CN')}`);
  lines.push(`耗时：${summary.durationMs}ms`);
  if (summary.backendNote) lines.push(`后端说明：${summary.backendNote}`);

  // 技能级预检结果
  lines.push('');
  lines.push(subDivider);
  lines.push('一、技能级预检');
  lines.push(subDivider);
  for (const check of summary.skillChecks) {
    lines.push(`${statusTag(check.status)} ${check.message}`);
  }

  // 步骤明细
  lines.push('');
  lines.push(subDivider);
  lines.push('二、逐步骤明细');
  lines.push(subDivider);

  steps.forEach((step, idx) => {
    const label = step.actionLabel || ACTION_LABELS[step.action] || step.action;
    const optionalMark = step.optional ? '（可选）' : '';
    lines.push(
      `步骤 ${idx + 1}/${steps.length} #${step.step} ${statusTag(step.status)} ` +
        `${label}${optionalMark}`,
    );
    if (step.selector) lines.push(`  选择器：${step.selector}`);
    if (step.value !== null && step.value !== undefined && step.value !== '') {
      const display = step.value.length > 120 ? `${step.value.slice(0, 120)}…` : step.value;
      lines.push(`  参数值：${display}`);
    }
    lines.push(`  说明：${step.detail}`);

    // 动作级静态检查（dry_run）
    for (const check of step.checks || []) {
      lines.push(`  ${statusTag(check.status)} ${check.message}`);
    }
    // 后置断言 / 断言预检结果
    for (const assertion of step.assertions || []) {
      const kindLabel = assertion.kindLabel || assertion.kind;
      lines.push(`  ${statusTag(assertion.status)} 断言「${kindLabel}」：${assertion.detail}`);
    }
    lines.push('');
  });

  // 执行计划（dry_run 核心交付物之一）
  lines.push(subDivider);
  lines.push('三、执行计划 JSON（动作链顺序与参数快照）');
  lines.push(subDivider);
  lines.push(JSON.stringify({ skillId: skill.skillId, plan }, null, 2));

  // 汇总
  lines.push('');
  lines.push(divider);
  lines.push('四、汇总');
  lines.push(divider);
  lines.push(`总步数：${summary.totalSteps}　成功：${summary.passed}　失败：${summary.failed}　跳过：${summary.skipped}`);
  lines.push(`最终状态：${statusTag(summary.status)}`);
  lines.push(`结论：${summary.message}`);

  if (summary.connectError) {
    lines.push('');
    lines.push(...connectionHint(summary));
  }

  // 失败动作清单
  const failedSteps = steps.filter((s) => s.status === STEP_STATUS.FAIL);
  if (failedSteps.length > 0) {
    lines.push('');
    lines.push('失败步骤清单：');
    for (const s of failedSteps) {
      lines.push(`  - #${s.step} ${s.actionLabel || s.action}：${s.detail}`);
    }
  }

  lines.push(divider);
  return lines.join('\n');
}

/**
 * 控制台打印报告（CLI 使用；MCP 场景可直接取用 report 文本）。
 * @param {string} report 报告文本
 */
export function printReport(report) {
  // eslint-disable-next-line no-console
  console.log(report);
}
