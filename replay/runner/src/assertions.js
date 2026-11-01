// 模块E：断言求值器（依据 CONTRACTS.md §6 断言类型）
// 由各后端把当前浏览器状态抽象成 query 对象（url / text / present），本模块做纯逻辑判定，便于复用与单测。

/** 等待指定毫秒 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单条断言求值
 * @param {{kind:string, target:string, timeoutMs:number}} assertion
 * @param {{ url:()=>Promise<string>, text:(selector)=>Promise<string>, present:(selector)=>Promise<boolean> }} query 浏览器状态查询接口
 * @param {object} [opts]
 * @param {number} [opts.pollMs] 轮询间隔，默认 300
 * @returns {Promise<{pass:boolean, message:string}>}
 */
export async function evaluateAssertion(assertion, query, opts = {}) {
  const { pollMs = 300 } = opts;
  const deadline = Date.now() + assertion.timeoutMs;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const currentUrl = await query.url();
      let pass = false;
      let message = '';

      switch (assertion.kind) {
        case 'url_contains': {
          pass = currentUrl.includes(assertion.target);
          message = pass
            ? `地址栏包含「${assertion.target}」`
            : `地址栏 ${currentUrl} 不包含「${assertion.target}」`;
          break;
        }
        case 'url_change': {
          pass = currentUrl !== assertion.target; // 由调用方在断言前置入当前 URL 作为 target
          message = pass ? '地址栏 URL 已变化' : '地址栏 URL 未变化';
          break;
        }
        case 'element_present': {
          const selector = assertion.target || '';
          const found = selector ? await query.present(selector) : false;
          pass = found;
          message = found ? `元素 ${selector} 存在` : `元素 ${selector} 未找到`;
          break;
        }
        case 'text_present': {
          const selector = assertion.selector || 'body';
          const text = await query.text(selector);
          pass = typeof assertion.target === 'string' && text.includes(assertion.target);
          message = pass
            ? `在 ${selector} 内找到文本「${assertion.target}」`
            : `在 ${selector} 内未找到文本「${assertion.target}」（实际：${text.slice(0, 50)}）`;
          break;
        }
        default:
          return { pass: false, message: `未知断言类型：${assertion.kind}` };
      }

      if (pass) return { pass: true, message };
      lastError = message;
    } catch (err) {
      lastError = `断言执行异常：${err.message}`;
    }
    await sleep(pollMs);
  }

  return { pass: false, message: `超时（${assertion.timeoutMs}ms）未满足：${lastError}` };
}

/**
 * 对一个动作的全部断言求值
 * @param {object} action
 * @param {object} query 浏览器状态查询接口
 * @returns {Promise<{pass:boolean, failures:string[]}>}
 */
export async function evaluateAssertions(action, query) {
  const failures = [];
  for (const assertion of action.assertions || []) {
    const result = await evaluateAssertion(assertion, query);
    if (!result.pass) failures.push(result.message);
  }
  return { pass: failures.length === 0, failures };
}
