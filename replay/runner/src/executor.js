// 模块E：动作执行器（依据 CONTRACTS.md §5 动作类型、§6 回放执行）
import { isValidHttpUrl } from './contract.js';
import { evaluateAssertions } from './assertions.js';

/** 等待指定毫秒 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行单个动作（对后端做动作 + 后置断言）
 * @param {object} action 技能中的单步动作
 * @param {object} backend 后端实例（dry-run / cdp / playwright）
 * @param {object} [opts]
 * @param {boolean} [opts.continueOnFail] 失败时是否继续后续步骤
 * @returns {Promise<{status:'PASS'|'FAIL'|'SKIP'|'ERROR', message:string, skipped?:boolean}>}
 */
export async function executeAction(action, backend, opts = {}) {
  const continueOnFail = Boolean(opts.continueOnFail);

  // 1. 预检：动作类型合法（dry-run 后端也会执行此步，其余由前端统一校验）
  const actionOk = await backend.precheck(action);
  if (!actionOk.pass) {
    return failOrSkip(action, actionOk.message, continueOnFail);
  }

  // 2. 可选动作：执行环境不可用时跳过并告警，不视为失败
  if (action.optional && !backend.capabilities?.[action.type]) {
    return {
      status: 'SKIP',
      message: `可选动作 ${action.type} 当前后端不支持，已跳过`,
      skipped: true,
    };
  }

  // 3. 执行动作
  let exec;
  try {
    exec = await backend.run(action);
  } catch (err) {
    const message = `执行动作 ${action.type} 异常：${err.message}`;
    return failOrSkip(action, message, continueOnFail);
  }
  if (!exec.pass) {
    return failOrSkip(action, exec.message || '动作执行未满足预期', continueOnFail);
  }

  // 4. 等待（契约 §6：动作间等待）
  const waitMs = typeof action.waitMs === 'number' && action.waitMs > 0 ? action.waitMs : 0;
  if (waitMs > 0) await sleep(waitMs);

  // 5. 后置断言
  const query = {
    url: () => backend.getUrl(),
    text: (selector) => backend.getText(selector),
    present: (selector) => backend.isPresent(selector),
  };
  const assertionResult = await evaluateAssertions(action, query);
  if (!assertionResult.pass) {
    const message = `步骤 ${action.step} 断言失败：${assertionResult.failures.join('；')}`;
    return failOrSkip(action, message, continueOnFail);
  }

  return { status: 'PASS', message: `步骤 ${action.step} ${action.type} 执行成功` };
}

/** 动作失败时按 continueOnFail 决定 FAIL 还是 SKIP */
function failOrSkip(action, message, continueOnFail) {
  if (action.optional) {
    return { status: 'SKIP', message: `可选动作未满足：${message}`, skipped: true };
  }
  if (continueOnFail) {
    return { status: 'FAIL', message };
  }
  return { status: 'FAIL', message, aborted: true };
}
