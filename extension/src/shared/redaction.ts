/**
 * 敏感字段硬丢弃工具（契约 §1.4）。
 * 所有函数在采集层执行，不落盘原文。
 */
const fieldPattern = /(passw|pwd|token|secret|api[_-]?key|apikey|credit|card|cvv|cvc|pin|auth|session[_-]?id|ssn)/i;
const urlQueryPattern = /(token|access_token|signature|key|secret)/i;

export const STRIPPED_HEADERS = [
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-csrf-token',
];

/** 判断元素是否命中敏感字段正则 */
export function isSensitiveField(name = '', id = '', autocomplete = '', ariaLabel = '', placeholder = '') {
  return fieldPattern.test(`${name} ${id} ${autocomplete} ${ariaLabel} ${placeholder}`);
}

/** 判断是否为密码类输入 */
export function isPasswordInput(el: HTMLInputElement | HTMLTextAreaElement) {
  return el.type === 'password';
}

/** 对敏感输入值脱敏：一律返回 **** */
export function redactValue(value: string) {
  return '****';
}

/** 清理请求头（整头剥离敏感项） */
export function sanitizeHeaders(headers: Record<string, string> | undefined) {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (STRIPPED_HEADERS.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** 清理 URL 查询参数中的敏感值 */
export function sanitizeUrl(url: string) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (urlQueryPattern.test(key)) u.searchParams.set(key, '****');
    }
    return u.toString();
  } catch {
    return url;
  }
}
