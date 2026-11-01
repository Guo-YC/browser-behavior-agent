// util.js —— 通用工具：域名清洗、哈希、JSON 安全解析、文本截断、SQL 标识符校验
import crypto from 'node:crypto';

// 域名清洗规则（契约 §2.2）：转小写，非 [a-zA-Z0-9_] 字符一律替换为 _
// 清洗结果只允许出现字母、数字、下划线，可直接拼入 SQL 表名，杜绝注入。
export function cleanDomain(domain) {
  return String(domain || '')
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_]/g, '_');
}

// 校验清洗后的表名片段仅含合法字符（兜底，防止外部拼表名绕过）
export function isValidTableToken(token) {
  return /^[a-zA-Z0-9_]+$/.test(token);
}

// 计算去重哈希：sha256(selector|type|detail前200字符)，契约 §2.2 behaviors.text_hash
export function dedupHash(selector, type, detail) {
  const detailPrefix = truncateJson(detail, 200);
  const raw = `${selector || ''}|${type}|${detailPrefix}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

// 安全解析 JSON 字符串：失败返回 null（不抛异常）
export function safeJsonParse(str) {
  if (str == null) return null;
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// 文本截断
export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// 将 detail 对象序列化为截断后的纯文本（供 FTS detail_text 使用）
export function detailToText(detail) {
  if (detail == null) return '';
  let json;
  try {
    json = typeof detail === 'string' ? detail : JSON.stringify(detail);
  } catch {
    return '';
  }
  // 去掉 JSON 引号与括号，保留可检索的关键词文本
  return json.replace(/[{"",\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

// detail 前 200 字符（用于去重哈希）
function truncateJson(detail, max) {
  let json;
  try {
    json = typeof detail === 'string' ? detail : JSON.stringify(detail ?? {});
  } catch {
    return '';
  }
  return json.length > max ? json.slice(0, max) : json;
}

// 归一化事件域名：小写、去端口、去 www（契约 §1.2）
export function normalizeDomain(rawUrl, fallbackDomain) {
  let host = String(fallbackDomain || '').toLowerCase();
  if (!host && rawUrl) {
    try {
      host = new URL(rawUrl).hostname.toLowerCase();
    } catch {
      host = '';
    }
  }
  host = host.replace(/^www\./, '');
  return host;
}

// FTS5 MATCH 查询词转义：把空格分隔的关键词逐词加双引号并以 AND 连接，
// 避免用户输入包含 FTS 特殊语法（*、"、- 等）导致语句报错。
export function buildMatchQuery(q) {
  const tokens = String(q || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '')}"`);
  if (tokens.length === 0) return null;
  return tokens.join(' AND ');
}
