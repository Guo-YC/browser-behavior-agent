// 模块D：路径解析、表名清洗、默认配置（依据 CONTRACTS.md §0、§2.2、§3）
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 当前文件位于 replay/distill/src/，逐级回退得到 distill 目录与项目根目录
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const distillDir = path.resolve(moduleDir, '..');
export const projectRoot = path.resolve(distillDir, '..', '..');

// 技能 JSON 输出目录：replay/skills/（契约 §0、§5）
export const skillsDir = path.join(projectRoot, 'replay', 'skills');

// 数据库路径优先级：显式传入 > 环境变量 DB_PATH > 项目默认 daemon/data/behavior.db（契约 §3）
export function resolveDbPath(dbPathOpt) {
  const raw = dbPathOpt || process.env.DB_PATH || path.join(projectRoot, 'daemon', 'data', 'behavior.db');
  return path.resolve(raw);
}

// daemon HTTP API 地址（契约 §3：127.0.0.1:8756），可用环境变量 DAEMON_URL 覆盖
export function resolveDaemonUrl() {
  return (process.env.DAEMON_URL || 'http://127.0.0.1:8756').replace(/\/+$/, '');
}

/**
 * 域名清洗为表名后缀（契约 §2.2：非 [a-zA-Z0-9_] 字符替换为 _）
 * 例：example.com → example_com；sub.example.com → sub_example_com
 */
export function sanitizeDomain(domain) {
  return String(domain || '').toLowerCase().replace(/[^a-zA-Z0-9_]/g, '_');
}

// 行为记录实体表名：behaviors_<清洗后域名>
export function behaviorsTable(domain) {
  return `behaviors_${sanitizeDomain(domain)}`;
}

/**
 * 生成技能目标 URL 匹配正则（契约 §5 targetUrlPattern）
 * 例：example.com → ^https://example\.com/.*
 */
export function targetUrlPattern(domain) {
  const escaped = String(domain).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^https://${escaped}/.*`;
}
