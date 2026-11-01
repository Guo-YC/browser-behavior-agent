// 模块E：中文回放报告生成（成功/失败步骤清单、执行计划 JSON）

/** 生成单步状态符号 */
function statusMark(status) {
  switch (status) {
    case 'PASS':
      return '[PASS]';
    case 'FAIL':
      return '[FAIL]';
    case 'SKIP':
      return '[SKIP]';
    default:
      return '[....]';
  }
}

/** 生成一条动作的可读摘要 */
function actionSummary(action) {
  let s = `${action.step}. ${action.type}`;
  if (action.selector) s += ` ${action.selector}`;
  if (action.value !== undefined && action.value !== '') s += ` → “${action.value}”`;
  return s;
}

/**
 * 生成完整中文回放报告
 * @param {object} summary 汇总对象
 * @param {object[]} steps 步骤结果
 * @param {object[]} plan 执行计划（规范化后的动作列表）
 * @returns {string}
 */
export function buildReport(summary, steps, plan) {
  const lines = [];
  lines.push('='.repeat(60));
  lines.push('回放报告');
  lines.push('='.repeat(60));
  lines.push(
    `总状态：${summary.status === 'PASS' ? '回放成功' : summary.status === 'PENDING' ? '待真机验证' : '回放失败'}`
  );
  lines.push(
    `成功 ${summary.passed} / 失败 ${summary.failed} / 跳过 ${summary.skipped}`
  );
  if (summary.aborted) lines.push('提示：因步骤失败已中止，后续步骤标记为跳过。');
  lines.push('');

  lines.push('步骤清单：');
  for (const step of steps) {
    const mark = statusMark(step.status);
    lines.push(`${mark} ${step.message || step.name || actionSummary(step.action || {})}`);
  }
  lines.push('');

  lines.push('执行计划 JSON：');
  lines.push(JSON.stringify(plan, null, 2));
  lines.push('='.repeat(60));
  return lines.join('\n');
}
