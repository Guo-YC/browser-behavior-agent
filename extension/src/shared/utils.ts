/** 通用工具：域名归一、选择器生成、事件节流、会话管理 */
import { fileURLToPath } from 'node:url';

/** hostname 归一：小写、去端口、去 www */
export function normalizeDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
