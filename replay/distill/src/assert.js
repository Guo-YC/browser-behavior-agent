// 模块D：技能断言自动生成（契约 §7 第6步、§5 assertions 字段）
// 规则：
//  1. click/dblclick 目标元素文本非空 → text_present（断言点击后页面仍出现该文本）；
//  2. input 动作 → element_present（断言输入框仍存在）；
//  3. navigate 动作 → url_contains（断言页面停留在该站点域名下）；
//  4. 链尾动作后 2s 内 URL 变化：同源路径变化 → url_contains；跨域/整站跳转 → url_change。

/** 解析 URL，失败返回 null（兼容非标准相对路径） */
function parseUrl(url) {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** 从 URL 中提取主机名（解析失败时原样返回） */
export function extractHostname(url) {
  const parsed = parseUrl(url);
  return parsed ? parsed.hostname : url;
}

/** 判断两个 URL 是否同源 */
function isSameOrigin(a, b) {
  const pa = parseUrl(a);
  const pb = parseUrl(b);
  if (!pa || !pb) return false;
  return pa.origin === pb.origin;
}

/** 取 URL 的路径+查询串，作为 url_contains 的目标片段 */
function pathFragment(url) {
  const parsed = parseUrl(url);
  if (!parsed) return url;
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * 生成单个动作的内置断言
 * @param {object} action 清洗后的动作对象
 * @returns {Array<{kind:string, target:string, timeoutMs:number}>}
 */
export function buildStepAssertions(action) {
  const assertions = [];

  if (action.type === 'click' || action.type === 'dblclick') {
    // 点击目标元素文本非空 → 断言文本在场
    if (action.text) {
      assertions.push({ kind: 'text_present', target: action.text, timeoutMs: 5000 });
    }
  } else if (action.type === 'input') {
    // 输入动作 → 断言元素在场（选择器非空才生成）
    if (action.selector) {
      assertions.push({ kind: 'element_present', target: action.selector, timeoutMs: 5000 });
    }
  } else if (action.type === 'navigate') {
    assertions.push({ kind: 'url_contains', target: extractHostname(action.value), timeoutMs: 5000 });
  }

  return assertions;
}

/**
 * 链尾动作后 2 秒内的 URL 变化断言（契约 §7 第6步）
 * 仅认 navigation / page_load 事件作为 URL 变化依据；tabswitch、page_hide 等噪声事件携带旧页面 URL，不参与判断
 * @param {object} tailAction 链尾动作（最后一个用户动作）
 * @param {object[]} rawEvents 代表会话的原始事件列表（已按 ts 升序）
 * @returns {Array<{kind:string, target:string, timeoutMs:number}>}
 */
export function buildTailAssertion(tailAction, rawEvents) {
  const tailTs = tailAction.ts;
  if (!tailTs || !Array.isArray(rawEvents)) return [];

  // 时间窗：链尾动作后 2000ms
  const windowEvents = rawEvents.filter((e) => e.ts > tailTs && e.ts <= tailTs + 2000);

  // 只取真正的页面跳转/加载事件；噪声事件携带的旧 URL 不作为变化依据
  const navigationEvent = windowEvents.find(
    (e) => (e.type === 'navigation' || e.type === 'page_load') && (e.detail.url || e.url)
  );
  if (!navigationEvent) return [];

  const newUrl = navigationEvent.detail.url || navigationEvent.url;
  const oldUrl = tailAction.source?.url || tailAction.value || '';

  if (oldUrl && isSameOrigin(oldUrl, newUrl)) {
    // 同源仅路径/查询串变化 → url_contains
    return [{ kind: 'url_contains', target: pathFragment(newUrl), timeoutMs: 5000 }];
  }
  // 跨域或整站 URL 被替换 → url_change
  return [{ kind: 'url_change', target: newUrl, timeoutMs: 5000 }];
}
