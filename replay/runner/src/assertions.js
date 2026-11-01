/**
 * 后置断言评估器（Paragent 思路：动作执行后轮询断言，超时未满足即 FAIL）。
 * 与后端解耦：只依赖探针接口 getUrl / exists / textOf，cdp、playwright、dry_run 各自实现探针。
 */
import {
  ASSERTION_LABELS,
  DEFAULT_ASSERTION_TIMEOUT_MS,
  ASSERTION_POLL_INTERVAL_MS,
} from './contract.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 评估单条断言，在 timeoutMs 内按固定间隔轮询。
 * @param {object} assertion 断言对象 {kind, target, timeoutMs}
 * @param {object} probe 后端探针
 * @param {string} actionSelector 所属动作的选择器（text_present / element_present 使用）
 * @param {string|null} baselineUrl 动作执行前记录的网址（url_change 使用）
 * @returns {Promise<{status: 'PASS'|'FAIL', detail: string}>}
 */
async function evaluateOne(assertion, probe, actionSelector, baselineUrl) {
  const timeoutMs = assertion.timeoutMs || DEFAULT_ASSERTION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const { kind, target } = assertion;
  // 选择器归属：断言自带 selector 优先，缺省回退动作选择器
  const selector = assertion.selector || actionSelector;

  /** 单次检查，返回 {ok, detail} */
  const check = async () => {
    switch (kind) {
      case 'url_contains': {
        const url = await probe.getUrl();
        const ok = typeof url === 'string' && url.includes(target);
        return {
          ok,
          detail: `当前网址「${url}」${ok ? '包含' : '不包含'}「${target}」`,
        };
      }
      case 'url_change': {
        const url = await probe.getUrl();
        const ok = typeof baselineUrl === 'string' && url !== baselineUrl;
        return {
          ok,
          detail: baselineUrl ? `动作前「${baselineUrl}」→ 当前「${url}」` : `当前网址「${url}」`,
        };
      }
      case 'element_present': {
        const exists = await probe.exists(selector);
        return {
          ok: exists,
          detail: exists ? '元素已在页面中找到' : `未找到元素：${selector}`,
        };
      }
      case 'text_present': {
        const text = await probe.textOf(selector);
        const ok = typeof text === 'string' && text.includes(target);
        const snippet = (text || '').slice(0, 80);
        return {
          ok,
          detail: ok
            ? `元素文本包含「${target}」`
            : `元素文本为「${snippet}」，未包含「${target}」`,
        };
      }
      default:
        return { ok: false, detail: `不支持的断言类型：${kind}` };
    }
  };

  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return { status: 'PASS', detail: last.detail };
    await sleep(ASSERTION_POLL_INTERVAL_MS);
  }
  const reason = last?.detail ?? '断言超时';
  return { status: 'FAIL', detail: `${reason}（已等待 ${timeoutMs}ms，超时未满足）` };
}

/**
 * 评估一个动作携带的全部断言，逐条返回结果。
 * @param {object[]} assertions 断言数组
 * @param {object} probe 后端探针
 * @param {string} actionSelector 动作选择器
 * @param {string|null} baselineUrl 动作前网址
 * @returns {Promise<Array<{kind,target,timeoutMs,status,detail}>>}
 */
export async function evaluateAssertions(assertions, probe, actionSelector, baselineUrl) {
  const results = [];
  for (const assertion of assertions || []) {
    const { status, detail } = await evaluateOne(assertion, probe, actionSelector, baselineUrl);
    results.push({
      kind: assertion.kind,
      kindLabel: ASSERTION_LABELS[assertion.kind] || assertion.kind,
      target: assertion.target,
      timeoutMs: assertion.timeoutMs || DEFAULT_ASSERTION_TIMEOUT_MS,
      status,
      detail,
    });
  }
  return results;
}
