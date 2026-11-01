/**
 * 回放执行器（Paragent 思路）：把技能动作链逐条交给对应后端执行，
 * 动作完成后轮询后置断言；按 optional 与 --continue-on-fail 决定失败策略。
 *
 * 失败策略（契约 §6）：
 * - optional:true 动作失败 → 状态 SKIP，继续后续动作；
 * - optional:false 动作失败 → 状态 FAIL，中止回放；
 * - --continue-on-fail 强制中止解除：非可选动作失败后仍继续跑完剩余动作，仅报告中如实标注 FAIL。
 */
import {
  MODES,
  STEP_STATUS,
  ACTION_LABELS,
  ASSERTION_LABELS,
  DEFAULT_WAIT_MS,
} from './contract.js';
import { precheckAction, precheckSkill } from './schema.js';
import { evaluateAssertions } from './assertions.js';
import { DryRunBackend } from './backends/dry-run.js';
import { CdpBackend } from './backends/cdp.js';
import { PlaywrightBackend } from './backends/playwright.js';
import { buildReport } from './report.js';

/**
 * 根据模式创建后端实例。
 * @param {string} mode 回放模式
 * @param {object} options 运行选项
 */
function createBackend(mode, options) {
  switch (mode) {
    case MODES.CDP:
      return new CdpBackend(options);
    case MODES.PLAYWRIGHT:
      return new PlaywrightBackend(options);
    case MODES.DRY_RUN:
    default:
      return new DryRunBackend(options);
  }
}

/**
 * 生成 dry_run 执行计划（供计划 JSON 输出与报告引用）。
 * @param {object} skill 技能对象
 * @returns {object[]} 计划条目
 */
export function buildPlan(skill) {
  return skill.actions.map((action, index) => ({
    seq: index + 1,
    step: action.step,
    type: action.type,
    typeLabel: ACTION_LABELS[action.type] || action.type,
    selector: action.selector || null,
    value: action.value ?? null,
    waitMs: action.waitMs || DEFAULT_WAIT_MS,
    optional: !!action.optional,
    assertions: (action.assertions || []).map((a) => ({
      kind: a.kind,
      target: a.target || null,
      timeoutMs: a.timeoutMs || 5000,
    })),
  }));
}

/**
 * 执行单步动作（真机模式），返回步骤记录。
 * @param {object} backend 后端实例
 * @param {object} action 动作对象
 * @param {object} options 运行选项
 * @returns {Promise<object>} 步骤记录
 */
async function runLiveStep(backend, action, options) {
  const record = {
    step: action.step,
    action: action.type,
    actionLabel: ACTION_LABELS[action.type] || action.type,
    selector: action.selector || null,
    value: action.value ?? null,
    optional: !!action.optional,
    status: STEP_STATUS.PASS,
    detail: '',
    checks: [],
    assertions: [],
  };

  // 记录动作前网址，供 url_change 断言比较
  let baselineUrl = null;
  try {
    baselineUrl = await backend.getUrl();
  } catch {
    baselineUrl = null;
  }

  // 1. 执行动作本体
  let actionError = null;
  try {
    switch (action.type) {
      case 'navigate':
        await backend.navigate(action.value);
        break;
      case 'click':
        await backend.click(action.selector);
        break;
      case 'dblclick':
        await backend.dblclick(action.selector);
        break;
      case 'input':
        await backend.input(action.selector, action.value);
        break;
      case 'hover':
        await backend.hover(action.selector);
        break;
      case 'scroll':
        await backend.scroll(action.selector, action.value);
        break;
      case 'wait':
        await backend.wait(action.waitMs || action.value || DEFAULT_WAIT_MS);
        break;
      case 'assert':
        // 纯断言动作：不操作页面，直接进入断言评估
        break;
      default:
        throw new Error(`未识别的动作类型：${action.type}`);
    }
    // 动作后停留（wait 动作本身已等待，不再叠加）
    if (action.type !== 'wait' && action.waitMs) {
      await backend.wait(action.waitMs);
    }
  } catch (err) {
    actionError = err.message;
  }

  // 2. 评估后置断言（动作失败时不再评估，直接记失败原因）
  if (!actionError) {
    record.assertions = await evaluateAssertions(
      action.assertions || [],
      backend,
      action.selector,
      baselineUrl,
    );
  }

  const assertionFailed = record.assertions.some((a) => a.status === STEP_STATUS.FAIL);

  if (actionError) {
    record.status = action.optional ? STEP_STATUS.SKIP : STEP_STATUS.FAIL;
    record.detail = `动作执行失败：${actionError}`;
  } else if (assertionFailed) {
    record.status = action.optional ? STEP_STATUS.SKIP : STEP_STATUS.FAIL;
    const failMsgs = record.assertions
      .filter((a) => a.status === STEP_STATUS.FAIL)
      .map((a) => `「${a.kindLabel}」${a.detail}`);
    record.detail = `后置断言未全部通过：${failMsgs.join('；')}`;
  } else {
    record.status = STEP_STATUS.PASS;
    record.detail =
      record.assertions.length > 0
        ? `动作执行成功，${record.assertions.length} 条后置断言全部通过`
        : '动作执行成功，本步无后置断言';
  }

  return record;
}

/**
 * 执行单步动作（dry_run 模式）：只做静态预检，不连接浏览器。
 * @param {object} action 动作对象
 * @returns {object} 步骤记录
 */
function runDryStep(action) {
  const pre = precheckAction(action);
  const record = {
    step: action.step,
    action: action.type,
    actionLabel: ACTION_LABELS[action.type] || action.type,
    selector: action.selector || null,
    value: action.value ?? null,
    optional: !!action.optional,
    status: pre.overall ? STEP_STATUS.PASS : action.optional ? STEP_STATUS.SKIP : STEP_STATUS.FAIL,
    detail: '',
    checks: pre.checks,
    assertions: pre.assertionChecks.map((c) => ({
      kind: c.assertion.kind,
      kindLabel: ASSERTION_LABELS[c.assertion.kind] || c.assertion.kind,
      target: c.assertion.target || null,
      timeoutMs: c.assertion.timeoutMs || 5000,
      status: c.status,
      detail: c.message,
    })),
  };

  if (pre.overall) {
    record.detail = `静态预检通过（${record.checks.length} 项动作检查 + ${record.assertions.length} 项断言检查）`;
  } else {
    const failures = [...record.checks, ...record.assertions]
      .filter((c) => c.status === STEP_STATUS.FAIL)
      .map((c) => c.detail || c.message);
    record.detail = action.optional
      ? `可选动作预检未通过，已跳过：${failures.join('；')}`
      : `预检未通过：${failures.join('；')}`;
  }
  return record;
}

/**
 * 回放入口：供 CLI 与 MCP 模块统一调用。
 *
 * @param {object} skill 技能对象（§5 格式）
 * @param {object} [opts]
 * @param {'dry_run'|'cdp'|'playwright'} [opts.mode='dry_run'] 回放模式
 * @param {boolean} [opts.headless=false] 是否无头（仅 playwright 启动本机 Chrome 时生效）
 * @param {string} [opts.targetUrl] 启动后首先导航到的网址
 * @param {boolean} [opts.continueOnFail=false] 非可选动作失败后是否继续
 * @param {string} [opts.cdpEndpoint] CDP 端点，默认 http://127.0.0.1:9222
 * @returns {Promise<{summary: object, steps: object[], plan: object[], report: string}>}
 */
export async function runSkill(skill, opts = {}) {
  const mode = opts.mode || MODES.DRY_RUN;
  if (![MODES.DRY_RUN, MODES.CDP, MODES.PLAYWRIGHT].includes(mode)) {
    throw new Error(
      `不支持的回放模式：${mode}（允许：${MODES.DRY_RUN} / ${MODES.CDP} / ${MODES.PLAYWRIGHT}）`,
    );
  }

  const options = {
    mode,
    headless: !!opts.headless,
    targetUrl: opts.targetUrl,
    continueOnFail: !!opts.continueOnFail,
    cdpEndpoint: opts.cdpEndpoint,
  };

  const startedAt = Date.now();
  const skillChecks = precheckSkill(skill);
  const plan = buildPlan(skill);
  const steps = [];
  let aborted = false;
  let connectError = null;

  const backend = createBackend(mode, options);

  // 连接浏览器（dry_run 不连真机）
  try {
    await backend.connect();
  } catch (err) {
    connectError = err.message;
    aborted = true;
  }

  if (!connectError) {
    for (const action of skill.actions) {
      const record =
        mode === MODES.DRY_RUN ? runDryStep(action) : await runLiveStep(backend, action, options);
      steps.push(record);

      // 失败策略：非可选动作失败 → 中止；optional 失败 → SKIP 继续；--continue-on-fail 解除中止
      if (record.status === STEP_STATUS.FAIL && !options.continueOnFail) {
        aborted = true;
        break;
      }
    }

    // 中止后剩余动作标记 SKIP，保证步骤清单完整
    if (aborted) {
      for (const action of skill.actions.slice(steps.length)) {
        steps.push({
          step: action.step,
          action: action.type,
          actionLabel: ACTION_LABELS[action.type] || action.type,
          selector: action.selector || null,
          value: action.value ?? null,
          optional: !!action.optional,
          status: STEP_STATUS.SKIP,
          detail: '前序非可选动作失败，按失败策略中止，本步未执行',
          checks: [],
          assertions: [],
        });
      }
    }

    await backend.disconnect().catch(() => undefined);
  } else {
    // 浏览器连接失败：全部动作记 SKIP，避免空跑误报
    for (const action of skill.actions) {
      steps.push({
        step: action.step,
        action: action.type,
        actionLabel: ACTION_LABELS[action.type] || action.type,
        selector: action.selector || null,
        value: action.value ?? null,
        optional: !!action.optional,
        status: STEP_STATUS.SKIP,
        detail: `浏览器连接失败，动作未执行：${connectError}`,
        checks: [],
        assertions: [],
      });
    }
  }

  const finishedAt = Date.now();
  const passed = steps.filter((s) => s.status === STEP_STATUS.PASS).length;
  const failed = steps.filter((s) => s.status === STEP_STATUS.FAIL).length;
  const skipped = steps.filter((s) => s.status === STEP_STATUS.SKIP).length;

  let status;
  if (connectError) status = STEP_STATUS.FAIL;
  else if (failed > 0) status = STEP_STATUS.FAIL;
  else if (skipped > 0 && passed === 0) status = STEP_STATUS.SKIP;
  else status = STEP_STATUS.PASS;

  const message = connectError
    ? `浏览器连接失败：${connectError}`
    : status === STEP_STATUS.PASS
      ? `回放成功：${passed} 步通过${skipped ? `，${skipped} 步跳过` : ''}`
      : status === STEP_STATUS.SKIP
        ? `回放结束：${skipped} 步跳过，${passed} 步通过`
        : `回放失败：${failed} 步未通过${passed ? `，${passed} 步通过` : ''}${skipped ? `，${skipped} 步跳过` : ''}${aborted ? '，已中止' : ''}`;

  const summary = {
    skillId: skill.skillId,
    name: skill.name,
    domain: skill.domain,
    description: skill.description || '',
    mode,
    headless: options.headless,
    targetUrl: options.targetUrl || null,
    continueOnFail: options.continueOnFail,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    totalSteps: steps.length,
    passed,
    failed,
    skipped,
    status,
    aborted,
    connectError,
    backendNote: backend.connectedVia
      ? backend.connectedVia === 'launch'
        ? 'Playwright 本机启动 Chrome 驱动'
        : mode === MODES.CDP
          ? 'CDP 协议直连调试端口 Chrome'
          : 'Playwright 通过 CDP 接管已有 Chrome'
      : null,
    message,
    skillChecks,
  };

  const report = buildReport(skill, { summary, steps, plan });
  return { summary, steps, plan, report };
}

export { MODES, STEP_STATUS };
