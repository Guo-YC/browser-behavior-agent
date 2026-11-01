// 模块D：daemon 数据库只读直读（契约 §2、§7 第1步）
// 说明：使用 better-sqlite3 的 readonly 模式直连 daemon 的 WAL 库，不启动 HTTP 也能读取；
// 只读连接不会写库、不与 daemon 抢写锁，支持并发只读（契约 §2.3）。
import Database from 'better-sqlite3';
import { behaviorsTable, resolveDbPath } from './paths.js';

/**
 * 以只读模式打开 daemon 数据库
 * @param {string} [dbPathOpt] 显式指定库路径（缺省读环境变量 DB_PATH，再缺省用项目默认路径）
 * @returns {Database} better-sqlite3 只读连接
 */
export function openReadOnlyDb(dbPathOpt) {
  const dbPath = resolveDbPath(dbPathOpt);
  let db;
  try {
    // fileMustExist: 库不存在时直接抛错，便于给出中文提示
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(
      `无法打开数据库（只读模式）：${dbPath}\n` +
      `原因：${err.message}\n` +
      `处理建议：请先启动模块B daemon 完成事件采集，或通过环境变量 DB_PATH 指定正确的数据库文件路径。`
    );
  }
  // 读多写少场景沿用契约建议：忙等待 5 秒
  db.pragma('busy_timeout=5000');
  return db;
}

/** 安全解析 JSON 字符串，失败时回退为空对象，避免单条脏数据中断整次蒸馏 */
function parseJsonSafe(text) {
  if (!text) return {};
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * 按域名（及可选会话列表）读取行为轨迹，按 session 分组、ts 升序
 * @param {Database} db 只读连接
 * @param {object} opts
 * @param {string} opts.domain 域名（小写 hostname）
 * @param {string[]} [opts.sessionIds] 指定会话 id 列表；不传则取该站点全部会话
 * @returns {{ tableName: string, sessions: Map<string, object[]>, eventCount: number }}
 */
export function loadTrajectories(db, { domain, sessionIds } = {}) {
  const tableName = behaviorsTable(domain);

  // 先确认实体表存在；不存在说明该站点尚未采集过数据
  const existsRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName);
  if (!existsRow) {
    throw new Error(
      `数据库中未找到表 behaviors_<D>：${tableName}\n` +
      `说明：域名 ${domain} 当前没有采集到行为记录，请先在浏览器中完成操作后重试。`
    );
  }

  let sql =
    `SELECT session_id AS sessionId, ts, type, url, selector, element_info AS elementInfo, detail ` +
    `FROM ${tableName} WHERE 1=1`;
  const params = [];

  // 会话过滤：--session-ids a,b
  if (Array.isArray(sessionIds) && sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(',');
    sql += ` AND session_id IN (${placeholders})`;
    params.push(...sessionIds);
  }

  // 按会话分组后组内按时间升序（契约 §7 第1步）
  sql += ' ORDER BY session_id ASC, ts ASC, behavior_id ASC';

  const rows = db.prepare(sql).all(...params);
  if (rows.length === 0) {
    throw new Error(
      `表 ${tableName} 中没有可读行为记录（会话过滤：${sessionIds?.length ? sessionIds.join(', ') : '全部'}），` +
      `无法进行技能蒸馏。`
    );
  }

  const sessions = new Map();
  for (const row of rows) {
    const element = parseJsonSafe(row.elementInfo);
    const detail = parseJsonSafe(row.detail);
    const event = {
      sessionId: row.sessionId,
      ts: row.ts,
      type: row.type,
      url: row.url,
      selector: row.selector,
      element,
      detail,
    };
    if (!sessions.has(row.sessionId)) sessions.set(row.sessionId, []);
    sessions.get(row.sessionId).push(event);
  }

  return { tableName, sessions, eventCount: rows.length };
}
