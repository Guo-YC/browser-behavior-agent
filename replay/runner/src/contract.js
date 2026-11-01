// 模块E：契约常量与数据校验工具（依据 CONTRACTS.md §5 动作类型白名单、§6 断言类型）

// 契约 §5 允许的动作类型
const ACTION_TYPES = [
  'navigate',
  'click',
  'dblclick',
  'input',
  'scroll',
  'hover',
  'wait',
  'assert',
];

// 契约 §6 允许的断言类型
const ASSERTION_KINDS = ['url_contains', 'text_present', 'element_present', 'url_change'];

/** 是否为合法的动作类型 */
export function isActionType(type) {
  return ACTION_TYPES.includes(type);
}

/** 是否为合法的断言类型 */
export function isAssertionKind(kind) {
  return ASSERTION_KINDS.includes(kind);
}

/** 是否为合法 URL（宽松校验，供 navigate / url_* 断言使用） */
export function isValidHttpUrl(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 非空字符串 */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}
