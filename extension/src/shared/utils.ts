/**
 * 通用工具：会话 ID、域名提取、文本截断、正则编译等。
 * content script 与 background 共用。
 */

/** 生成 v4 UUID（sessionId 形如 s_<uuid>，契约 §1.2） */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // 兜底实现（老版本 Chrome / 隔离世界兼容）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 生成带前缀的会话 ID：s_<uuid> */
export function newSessionId(): string {
  return `s_${uuid()}`;
}

/**
 * 提取域名（契约 §1.2）：小写、去端口、去掉前导 www.，保留子域名。
 * 无法解析时返回空字符串。
 */
export function getDomain(url: string): string {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return '';
  }
}

/** 截断文本到指定长度（element.text ≤200 字符，input.value ≤500 字符，契约 §1.3） */
export function truncate(text: unknown, max: number): string {
  if (text === null || text === undefined) return '';
  const s = String(text);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 编译一组正则源文本为 RegExp 列表；非法正则跳过并在控制台输出中文告警。
 * 所有正则统一大小写不敏感（契约 §1.4 #2 为 /i 规则）。
 */
export function compilePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const raw of patterns) {
    const src = (raw ?? '').trim();
    if (!src) continue;
    try {
      out.push(new RegExp(src, 'i'));
    } catch (err) {
      console.warn(`[行为采集器] 敏感规则正则无效，已跳过：${src}`, err);
    }
  }
  return out;
}

/** 判断字符串是否命中任一正则 */
export function matchesAny(patterns: RegExp[], value: string | null | undefined): boolean {
  if (!value) return false;
  return patterns.some((re) => re.test(value));
}

/** 节流：ms 毫秒内最多执行一次（用于 mousemove / mouseenter / scroll，契约 §1.3） */
export function throttle<T extends (...args: never[]) => void>(ms: number, fn: T): T {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let trailingArgs: Parameters<T> | null = null;
  return ((...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      trailingArgs = args;
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        if (trailingArgs) fn(...trailingArgs);
      }, remaining);
    } else {
      trailingArgs = args;
    }
  }) as T;
}
