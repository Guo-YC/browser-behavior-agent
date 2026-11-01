// store.js —— 存储层核心：SQLite 连接、全局 Schema、按域名自动分表、批量事务入库、
// FTS5 全文索引、会话生命周期管理与定期整理。对应契约 §2 数据库 Schema、§1 事件协议。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanDomain,
  isValidTableToken,
  dedupHash,
  safeJsonParse,
  detailToText,
  truncate,
  normalizeDomain,
  buildMatchQuery,
} from './util.js';

// 契约 §1.2 已知事件类型集合；不在集合内的 type 记为 unknown 仍入库（契约 §1.2 末段）
const KNOWN_TYPES = new Set([
  'click', 'dblclick', 'mousemove', 'mouseenter', 'contextmenu',
  'input', 'keydown', 'scroll', 'focus', 'blur',
  'navigation', 'tabswitch', 'page_load', 'page_hide',
  'request', 'session_start', 'session_end', 'heartbeat',
]);

// 同步等待（退避重试用，避免阻塞事件循环太久）
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 路由到 pages 表的事件类型
const PAGE_TYPES = new Set(['page_load', 'navigation']);
// 直接入库 behaviors 表之外的特殊类型
const SPECIAL_TYPES = new Set([
  'session_start', 'session_end', 'page_load', 'navigation',
  'page_hide', 'request', 'heartbeat',
]);

export class Store {
  /**
   * @param {string} dbPath 数据库文件绝对路径
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    // WAL 模式 + 忙等待 5000ms，支持多 host 进程并发写（契约 §1.1、§2.3、§9.3）
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.startTime = Date.now();
    this.idleTimeoutMs = 30 * 60 * 1000;
    this.tableCache = new Map(); // domain -> { siteId, sessionsTable, pagesTable, behaviorsTable, requestsTable }
  }

  // 打开数据库后初始化全局 Schema
  init() {
    this.createGlobalSchema();
  }

  // 契约 §2.1 全局表：sites / site_tables / skills / behaviors_fts(FTS5)
  createGlobalSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sites (
        site_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        domain       TEXT NOT NULL UNIQUE,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        event_count  INTEGER NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS site_tables (
        domain          TEXT PRIMARY KEY,
        sessions_table  TEXT NOT NULL,
        pages_table     TEXT NOT NULL,
        behaviors_table TEXT NOT NULL,
        requests_table  TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        skill_id    TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        domain      TEXT NOT NULL,
        description TEXT,
        path        TEXT NOT NULL,
        version     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS behaviors_fts USING fts5(
        url, selector, element_text, detail_text,
        domain UNINDEXED, behavior_id UNINDEXED, session_id UNINDEXED, ts UNINDEXED
      );
    `);
  }

  // 为清洗后的域名片段 D 创建 4 张实体表与配套索引（契约 §2.2）
  execPerDomainDdl(s) {
    const sessions = `sessions_${s}`;
    const pages = `pages_${s}`;
    const behaviors = `behaviors_${s}`;
    const requests = `requests_${s}`;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${sessions} (
        session_id  TEXT PRIMARY KEY,
        site_id     INTEGER NOT NULL,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        page_count  INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        user_agent  TEXT,
        screen      TEXT,
        last_activity INTEGER NOT NULL DEFAULT 0,
        closed      INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS ${pages} (
        page_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        site_id   INTEGER NOT NULL,
        url       TEXT NOT NULL,
        title     TEXT,
        visit_ts  INTEGER NOT NULL,
        leave_ts  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pg_${s}_session ON ${pages}(session_id, visit_ts);

      CREATE TABLE IF NOT EXISTS ${behaviors} (
        behavior_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        page_id     INTEGER,
        site_id     INTEGER NOT NULL,
        ts          INTEGER NOT NULL,
        type        TEXT NOT NULL,
        url         TEXT NOT NULL,
        selector    TEXT,
        element_info TEXT,
        detail      TEXT,
        text_hash   TEXT,
        redacted    INTEGER NOT NULL DEFAULT 0
      );
      -- v1.2 修订：去重约束使用独立唯一索引（SQLite 不允许表内联 UNIQUE 中使用 COALESCE 表达式）
      CREATE UNIQUE INDEX IF NOT EXISTS uq_bh_${s}
        ON ${behaviors}(session_id, ts, type, COALESCE(selector,''), COALESCE(text_hash,''));
      CREATE INDEX IF NOT EXISTS idx_bh_${s}_ts      ON ${behaviors}(ts);
      CREATE INDEX IF NOT EXISTS idx_bh_${s}_session ON ${behaviors}(session_id, ts);
      CREATE INDEX IF NOT EXISTS idx_bh_${s}_type    ON ${behaviors}(type);
      CREATE INDEX IF NOT EXISTS idx_bh_${s}_url     ON ${behaviors}(url);

      CREATE TABLE IF NOT EXISTS ${requests} (
        request_id  INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        page_id     INTEGER,
        site_id     INTEGER NOT NULL,
        ts          INTEGER NOT NULL,
        method      TEXT NOT NULL,
        url         TEXT NOT NULL,
        status      INTEGER,
        duration_ms INTEGER,
        resource_type TEXT,
        req_headers TEXT,
        resp_headers TEXT,
        body_preview TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rq_${s}_ts   ON ${requests}(ts);
      CREATE INDEX IF NOT EXISTS idx_rq_${s}_url  ON ${requests}(url);
    `);
  }

  // 确保域名对应表已存在，返回 siteId 与表名映射；同名命中进程内缓存
  ensureDomain(domain) {
    let meta = this.tableCache.get(domain);
    if (meta) return meta;

    const s = cleanDomain(domain);
    if (!isValidTableToken(s)) {
      throw new Error(`域名清洗后生成非法表名片段：${domain}`);
    }

    const cached = this.db.prepare('SELECT * FROM site_tables WHERE domain = ?').get(domain);
    if (cached) {
      meta = this.mapSiteTables(cached);
      // 补填 site_id（缓存分支不能复用建表事务里已赋值的 meta.siteId）
      meta.siteId = this.db.prepare('SELECT site_id FROM sites WHERE domain = ?').get(domain)?.site_id;
      this.tableCache.set(domain, meta);
      return meta;
    }

    this.db.transaction(() => {
      const now = Date.now();
      this.db
        .prepare(
          'INSERT OR IGNORE INTO sites(domain, first_seen, last_seen, event_count) VALUES(?,?,?,0)'
        )
        .run(domain, now, now);
      const siteId = this.db.prepare('SELECT site_id FROM sites WHERE domain = ?').get(domain)
        .site_id;

      this.execPerDomainDdl(s);

      this.db
        .prepare(
          `INSERT OR IGNORE INTO site_tables(domain, sessions_table, pages_table, behaviors_table, requests_table, created_at)
           VALUES(?,?,?,?,?,?)`
        )
        .run(domain, `sessions_${s}`, `pages_${s}`, `behaviors_${s}`, `requests_${s}`, now);

      meta = this.mapSiteTables(this.db.prepare('SELECT * FROM site_tables WHERE domain = ?').get(domain));
      meta.siteId = siteId;
    })();

    this.tableCache.set(domain, meta);
    return meta;
  }

  mapSiteTables(row) {
    return {
      siteId: null,
      sessionsTable: row.sessions_table,
      pagesTable: row.pages_table,
      behaviorsTable: row.behaviors_table,
      requestsTable: row.requests_table,
    };
  }

  // 取域名表映射；不存在时返回 null（查询接口据此返回空结果，不抛错）
  getMetaOrNull(domain) {
    if (!domain) return null;
    const row = this.db.prepare('SELECT * FROM site_tables WHERE domain = ?').get(domain);
    if (!row) return null;
    const meta = this.mapSiteTables(row);
    meta.siteId = this.db.prepare('SELECT site_id FROM sites WHERE domain = ?').get(domain)?.site_id;
    return meta;
  }

  // 事件基础校验：缺 sessionId / url / ts 视为不合法，计入 ignored（契约 §1.2 入库前校验）
  isValid(ev) {
    if (!ev || typeof ev !== 'object') return false;
    if (typeof ev.sessionId !== 'string' || !ev.sessionId) return false;
    if (typeof ev.url !== 'string' || !ev.url) return false;
    if (!Number.isFinite(Number(ev.ts))) return false;
    return true;
  }

  /**
   * 批量入库：一条消息 = 一个事务（契约 §2.3）。
   * 流程：先在数据事务之外完成域名分表（DDL 独立事务提交），再进入数据写入事务；
   * 遇 SQLITE_BUSY 按退避重试，保证多 host 进程并发写不丢消息。
   * @param {Array} events 事件数组
   * @returns {{received:number, inserted:number, ignored:number}}
   */
  ingestBatch(events) {
    const list = Array.isArray(events) ? events : [];
    let inserted = 0;
    let ignored = 0;
    const ftsQueue = [];
    const touched = new Map(); // domain -> { siteId, meta, domain, sessions:Set<string> }
    const validEvents = [];
    const db = this.db;

    // 第一遍：校验事件、解析域名、确保分表存在（DDL 在独立事务中提交，不嵌套进数据事务）
    for (const ev of list) {
      if (!this.isValid(ev)) {
        ignored++;
        continue;
      }
      const domain = normalizeDomain(ev.url, ev.domain);
      if (!domain) {
        ignored++;
        continue;
      }
      const meta = this.ensureDomainWithRetry(domain);

      let group = touched.get(domain);
      if (!group) {
        group = { siteId: meta.siteId, meta, domain, sessions: new Set() };
        touched.set(domain, group);
      }
      group.sessions.add(ev.sessionId);
      validEvents.push({ ev, domain, group });
    }

    // 第二遍：数据写入，独立事务；SQLITE_BUSY 时退避重试
    const writeTx = db.transaction(() => {
      for (const { ev, domain, group } of validEvents) {
        const detail = (ev.detail && typeof ev.detail === 'object' ? ev.detail : safeJsonParse(ev.detail)) || {};
        const type = KNOWN_TYPES.has(ev.type) ? ev.type : 'unknown';
        const ts = Number(ev.ts);

        switch (type) {
          case 'session_start':
            this.upsertSessionStart(group, ev, detail, ts);
            break;
          case 'session_end':
            this.closeSessionEvent(group, ev, ts);
            break;
          case 'page_load':
          case 'navigation':
            this.insertPage(group, ev, detail, ts, type);
            break;
          case 'request':
            this.insertRequest(group, ev, detail, ts);
            break;
          case 'heartbeat':
            this.touchSession(group, ev.sessionId, ts);
            break;
          default:
            if (this.insertBehavior(group, ev, detail, type, ts, ftsQueue)) inserted++;
            else ignored++; // 命中唯一索引去重（契约 §2.3 INSERT OR IGNORE）
            break;
        }

        // 会话最近活跃时间刷新（除 session_end 外的所有事件）
        if (type !== 'session_end') this.touchSession(group, ev.sessionId, ts);

        // 事务内更新站点计数与最近时间（契约 §2.3）：首次记录事件时间，后续 last_seen 取最大时间
        db.prepare(
          `INSERT INTO sites(domain, first_seen, last_seen, event_count) VALUES(?,?,?,1)
           ON CONFLICT(domain) DO UPDATE SET
             last_seen=MAX(sites.last_seen, excluded.last_seen),
             event_count=event_count+1`
        ).run(domain, ts, ts);
      }

      // 批次结束后重算每个受影响会话的 page_count / event_count
      for (const [, group] of touched) {
        for (const sid of group.sessions) this.recomputeSessionCount(group, sid);
      }
    });

    this.withBusyRetry(writeTx);

    // 事务提交后，对实际新插入的行为行写 FTS（契约 §2.3：INSERT OR IGNORE 需借助 RETURNING 取真实新行）
    for (const row of ftsQueue) this.insertFts(row);

    return { received: list.length, inserted, ignored };
  }

  // SQLITE_BUSY 退避重试包装（多 host 并发写时等待锁释放）
  withBusyRetry(fn) {
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return fn();
      } catch (err) {
        lastErr = err;
        if (err.code === 'SQLITE_BUSY' && attempt < 5) {
          sleep(120 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // 建表操作同样带 BUSY 重试（两个 host 同时首次见到同一域名时串行等待）
  ensureDomainWithRetry(domain) {
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return this.ensureDomain(domain);
      } catch (err) {
        lastErr = err;
        if (err.code === 'SQLITE_BUSY' && attempt < 5) {
          sleep(120 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // session_start：会话首次建立（契约 §1.3 detail: userAgent, screenWidth, screenHeight, startUrl）
  upsertSessionStart(group, ev, detail, ts) {
    const { meta, siteId } = group;
    const screen = detail.screenWidth && detail.screenHeight ? `${detail.screenWidth}x${detail.screenHeight}` : null;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ${meta.sessionsTable}
           (session_id, site_id, started_at, page_count, event_count, user_agent, screen, last_activity, closed)
         VALUES(?,?,?,0,0,?,?,?,0)`
      )
      .run(ev.sessionId, siteId, ts, detail.userAgent || null, screen, ts);
    this.db
      .prepare(
        `UPDATE ${meta.sessionsTable}
         SET user_agent=COALESCE(?,user_agent), screen=COALESCE(?,screen), last_activity=?
         WHERE session_id=?`
      )
      .run(detail.userAgent || null, screen, ts, ev.sessionId);
  }

  // session_end：标记会话关闭（契约 §1.3 detail.reason: tab_close|idle|replaced）
  closeSessionEvent(group, ev, ts) {
    this.db
      .prepare(
        `UPDATE ${group.meta.sessionsTable}
         SET ended_at=COALESCE(ended_at,?), closed=1, last_activity=?
         WHERE session_id=? AND closed=0`
      )
      .run(ts, ts, ev.sessionId);
  }

  // page_load / navigation：写入页面访问记录
  insertPage(group, ev, detail, ts, type) {
    const { meta, siteId } = group;
    const url = detail.url || ev.url;
    const title = detail.title || ev.title || null;
    this.db
      .prepare(
        `INSERT INTO ${meta.pagesTable}(session_id, site_id, url, title, visit_ts)
         VALUES(?,?,?,?,?)`
      )
      .run(ev.sessionId, siteId, url, title, ts);
  }

  // request：写入网络请求记录（契约 §1.5，请求头已由采集层脱敏）
  insertRequest(group, ev, detail, ts) {
    const { meta, siteId } = group;
    const page = this.db
      .prepare(`SELECT page_id FROM ${meta.pagesTable} WHERE session_id=? ORDER BY visit_ts DESC LIMIT 1`)
      .get(ev.sessionId);
    this.db
      .prepare(
        `INSERT INTO ${meta.requestsTable}
           (session_id, page_id, site_id, ts, method, url, status, duration_ms, resource_type, req_headers, resp_headers, body_preview)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        ev.sessionId,
        page?.page_id ?? null,
        siteId,
        ts,
        detail.method || 'GET',
        detail.requestUrl || ev.url,
        detail.status ?? null,
        detail.durationMs ?? null,
        detail.resourceType || null,
        detail.reqHeaders ? JSON.stringify(detail.reqHeaders) : null,
        detail.respHeaders ? JSON.stringify(detail.respHeaders) : null,
        detail.postBodyPreview ?? null
      );
  }

  // 刷新会话最近活跃时间
  touchSession(group, sessionId, ts) {
    this.db
      .prepare(`UPDATE ${group.meta.sessionsTable} SET last_activity=? WHERE session_id=?`)
      .run(ts, sessionId);
  }

  // 行为事件写入 behaviors 表；返回是否真实插入（受 UNIQUE 约束去重，契约 §2.2）
  insertBehavior(group, ev, detail, type, ts, ftsQueue) {
    const { meta, siteId } = group;
    const page = this.db
      .prepare(`SELECT page_id FROM ${meta.pagesTable} WHERE session_id=? ORDER BY visit_ts DESC LIMIT 1`)
      .get(ev.sessionId);
    const selector = detail.selector || '';
    const element = detail.element || null;
    const redacted = element && element.redacted ? 1 : 0;
    const textHash = dedupHash(selector, type, detail);

    // 以 changes 判断是否真实插入；命中唯一索引去重时 changes=0；lastInsertRowid 即 behavior_id
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO ${meta.behaviorsTable}
           (session_id, page_id, site_id, ts, type, url, selector, element_info, detail, text_hash, redacted)
         VALUES(@session_id,@page_id,@site_id,@ts,@type,@url,@selector,@element_info,@detail,@text_hash,@redacted)`
      )
      .run({
        session_id: ev.sessionId,
        page_id: page?.page_id ?? null,
        site_id: siteId,
        ts,
        type,
        url: ev.url,
        selector: selector || null,
        element_info: element ? JSON.stringify(element) : null,
        detail: detail ? JSON.stringify(detail) : null,
        text_hash: textHash,
        redacted,
      });

    if (info.changes === 0) return false; // 命中唯一索引被忽略（去重）

    ftsQueue.push({
      url: ev.url,
      selector,
      elementText: element?.text || '',
      detailText: truncate(detailToText(detail), 500),
      domain: group.domain,
      behaviorId: Number(info.lastInsertRowid),
      sessionId: ev.sessionId,
      ts,
    });
    return true;
  }

  // 重算会话统计：event_count = behaviors 行数；page_count = pages 去重 url 数（契约 §2.3）
  recomputeSessionCount(group, sessionId) {
    const { meta } = group;
    this.db
      .prepare(
        `UPDATE ${meta.sessionsTable} SET
           event_count=(SELECT COUNT(*) FROM ${meta.behaviorsTable} WHERE session_id=?),
           page_count=(SELECT COUNT(DISTINCT url) FROM ${meta.pagesTable} WHERE session_id=?)
         WHERE session_id=?`
      )
      .run(sessionId, sessionId, sessionId);
  }

  // 事务提交后写入 FTS5 行
  insertFts(row) {
    this.db
      .prepare(
        `INSERT INTO behaviors_fts(url, selector, element_text, detail_text, domain, behavior_id, session_id, ts)
         VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        row.url, row.selector, row.elementText, row.detailText,
        row.domain, row.behaviorId, row.sessionId, row.ts
      );
  }

  // ------------------------------------------------------------------
  // 查询接口（对应契约 §3 HTTP API；CLI 直连数据库复用同一组方法）
  // ------------------------------------------------------------------

  // GET /api/sites
  querySites() {
    return this.db
      .prepare(
        `SELECT s.domain, s.first_seen AS firstSeen, s.last_seen AS lastSeen,
                s.event_count AS eventCount, s.status, t.sessions_table AS tableName
         FROM sites s LEFT JOIN site_tables t ON s.domain = t.domain
         ORDER BY s.last_seen DESC`
      )
      .all();
  }

  // GET /api/sessions
  querySessions({ domain, from, to, limit = 100 }) {
    const meta = this.getMetaOrNull(domain);
    if (!meta) return [];
    const where = [];
    const params = [];
    if (from) { where.push('started_at >= ?'); params.push(Number(from)); }
    if (to) { where.push('started_at <= ?'); params.push(Number(to)); }
    const sql = `SELECT session_id AS sessionId, started_at AS startedAt, ended_at AS endedAt,
                   page_count AS pageCount, event_count AS eventCount, user_agent AS userAgent, screen
                 FROM ${meta.sessionsTable} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY started_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, Number(limit) || 100);
  }

  // GET /api/behaviors
  queryBehaviors({ domain, sessionId, type, from, to, urlContains, limit = 200, offset = 0 }) {
    const meta = this.getMetaOrNull(domain);
    if (!meta) return { total: 0, items: [] };
    const where = [];
    const params = [];
    if (sessionId) { where.push('session_id = ?'); params.push(sessionId); }
    if (type) { where.push('type = ?'); params.push(type); }
    if (from) { where.push('ts >= ?'); params.push(Number(from)); }
    if (to) { where.push('ts <= ?'); params.push(Number(to)); }
    if (urlContains) { where.push('url LIKE ?'); params.push(`%${urlContains}%`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = this.db
      .prepare(`SELECT COUNT(*) AS c FROM ${meta.behaviorsTable} ${whereSql}`)
      .get(...params).c;

    const rows = this.db
      .prepare(
        `SELECT behavior_id AS behaviorId, session_id AS sessionId, ts, type, url, selector,
                element_info AS elementInfo, detail, redacted
         FROM ${meta.behaviorsTable} ${whereSql}
         ORDER BY ts DESC LIMIT ? OFFSET ?`
      )
      .all(...params, Number(limit) || 200, Number(offset) || 0);

    const items = rows.map((r) => ({
      behaviorId: r.behaviorId,
      sessionId: r.sessionId,
      ts: r.ts,
      type: r.type,
      url: r.url,
      selector: r.selector,
      element: safeJsonParse(r.elementInfo),
      detail: safeJsonParse(r.detail),
      redacted: !!r.redacted,
    }));
    return { total, items };
  }

  // GET /api/requests
  queryRequests({ domain, method, urlContains, status, from, to, limit = 200 }) {
    const meta = this.getMetaOrNull(domain);
    if (!meta) return { total: 0, items: [] };
    const where = [];
    const params = [];
    if (method) { where.push('method = ?'); params.push(method.toUpperCase()); }
    if (urlContains) { where.push('url LIKE ?'); params.push(`%${urlContains}%`); }
    if (status != null) { where.push('status = ?'); params.push(Number(status)); }
    if (from) { where.push('ts >= ?'); params.push(Number(from)); }
    if (to) { where.push('ts <= ?'); params.push(Number(to)); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = this.db
      .prepare(`SELECT COUNT(*) AS c FROM ${meta.requestsTable} ${whereSql}`)
      .get(...params).c;

    const rows = this.db
      .prepare(
        `SELECT request_id AS requestId, session_id AS sessionId, ts, method, url, status,
                duration_ms AS durationMs, resource_type AS resourceType,
                req_headers AS reqHeaders, resp_headers AS respHeaders, body_preview AS bodyPreview
         FROM ${meta.requestsTable} ${whereSql}
         ORDER BY ts DESC LIMIT ?`
      )
      .all(...params, Number(limit) || 200);

    const items = rows.map((r) => ({
      requestId: r.requestId,
      sessionId: r.sessionId,
      ts: r.ts,
      method: r.method,
      url: r.url,
      status: r.status,
      durationMs: r.durationMs,
      resourceType: r.resourceType,
      reqHeaders: safeJsonParse(r.reqHeaders),
      respHeaders: safeJsonParse(r.respHeaders),
      bodyPreview: r.bodyPreview,
    }));
    return { total, items };
  }

  // GET /api/stats：groupBy = type | page | hour
  queryStats({ domain, from, to, groupBy = 'type' }) {
    const meta = this.getMetaOrNull(domain);
    if (!meta) return [];
    const where = [];
    const params = [];
    if (from) { where.push('ts >= ?'); params.push(Number(from)); }
    if (to) { where.push('ts <= ?'); params.push(Number(to)); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    let sql;
    if (groupBy === 'page') {
      sql = `SELECT url AS key, COUNT(*) AS count FROM ${meta.behaviorsTable} ${whereSql}
             GROUP BY url ORDER BY count DESC LIMIT 50`;
    } else if (groupBy === 'hour') {
      sql = `SELECT strftime('%Y-%m-%d %H:00', ts/1000, 'unixepoch') AS key, COUNT(*) AS count
             FROM ${meta.behaviorsTable} ${whereSql} GROUP BY key ORDER BY key ASC`;
    } else {
      sql = `SELECT type AS key, COUNT(*) AS count FROM ${meta.behaviorsTable} ${whereSql}
             GROUP BY type ORDER BY count DESC`;
    }
    return this.db.prepare(sql).all(...params);
  }

  // GET /api/search：FTS5 全文检索（url / selector / 元素文本 / 详情文本）
  search(q, domain, limit = 50) {
    const match = buildMatchQuery(q);
    if (!match) return [];
    const params = [match];
    let domainFilter = '';
    if (domain) { domainFilter = 'AND behaviors_fts.domain = ?'; params.push(domain); }
    params.push(Number(limit) || 50);

    const rows = this.db
      .prepare(
        `SELECT behavior_id AS behaviorId, session_id AS sessionId, ts, domain, url, selector,
                snippet(behaviors_fts, -1, '<b>', '</b>', '…', 12) AS snippet
         FROM behaviors_fts WHERE behaviors_fts MATCH ? ${domainFilter}
         ORDER BY rank LIMIT ?`
      )
      .all(...params);

    // type 未存于 FTS，按域名分组回查 behaviors 表补齐
    const byDomain = new Map();
    for (const r of rows) {
      const list = byDomain.get(r.domain) || [];
      list.push(r);
      byDomain.set(r.domain, list);
    }
    for (const [d, list] of byDomain) {
      const meta = this.getMetaOrNull(d);
      if (!meta || list.length === 0) continue;
      const ids = list.map((r) => r.behaviorId);
      const placeholders = ids.map(() => '?').join(',');
      const typeRows = this.db
        .prepare(
          `SELECT behavior_id AS behaviorId, type FROM ${meta.behaviorsTable} WHERE behavior_id IN (${placeholders})`
        )
        .all(...ids);
      const typeMap = new Map(typeRows.map((r) => [r.behaviorId, r.type]));
      for (const r of list) r.type = typeMap.get(r.behaviorId) || 'unknown';
    }
    return rows.map(({ domain: _d, ...rest }) => rest);
  }

  // GET /api/trajectory：会话/时间段行为轨迹，按 ts 升序（行为 + 页面 + 请求合并）
  trajectory({ domain, sessionId, from, to }) {
    const meta = this.getMetaOrNull(domain);
    if (!meta) return { sessionId: sessionId || null, domain: domain || '', events: [] };

    const events = [];
    const rangeWhere = [];
    const rangeParams = [];
    if (sessionId) { rangeWhere.push('session_id = ?'); rangeParams.push(sessionId); }
    if (from) { rangeWhere.push('ts >= ?'); rangeParams.push(Number(from)); }
    if (to) { rangeWhere.push('ts <= ?'); rangeParams.push(Number(to)); }

    // 行为
    const bhRows = this.db
      .prepare(
        `SELECT behavior_id AS behaviorId, session_id AS sessionId, ts, type, url, selector,
                element_info AS elementInfo, detail
         FROM ${meta.behaviorsTable} ${rangeWhere.length ? 'WHERE ' + rangeWhere.join(' AND ') : ''}
         ORDER BY ts ASC`
      )
      .all(...rangeParams);
    for (const r of bhRows) {
      events.push({
        kind: 'behavior',
        behaviorId: r.behaviorId,
        sessionId: r.sessionId,
        ts: r.ts,
        type: r.type,
        url: r.url,
        selector: r.selector,
        element: safeJsonParse(r.elementInfo),
        detail: safeJsonParse(r.detail),
      });
    }

    // 页面访问（映射为 page_load 事件）
    const pageRows = this.db
      .prepare(
        `SELECT page_id AS pageId, session_id AS sessionId, url, title, visit_ts AS ts
         FROM ${meta.pagesTable} ${rangeWhere.length ? 'WHERE ' + rangeWhere.join(' AND ') : ''}
         ORDER BY ts ASC`
      )
      .all(...rangeParams);
    for (const r of pageRows) {
      events.push({
        kind: 'page',
        pageId: r.pageId,
        sessionId: r.sessionId,
        ts: r.ts,
        type: 'page_load',
        url: r.url,
        title: r.title,
      });
    }

    // 网络请求
    const rqRows = this.db
      .prepare(
        `SELECT request_id AS requestId, session_id AS sessionId, ts, method, url, status,
                duration_ms AS durationMs, resource_type AS resourceType, body_preview AS bodyPreview
         FROM ${meta.requestsTable} ${rangeWhere.length ? 'WHERE ' + rangeWhere.join(' AND ') : ''}
         ORDER BY ts ASC`
      )
      .all(...rangeParams);
    for (const r of rqRows) {
      events.push({
        kind: 'request',
        requestId: r.requestId,
        sessionId: r.sessionId,
        ts: r.ts,
        type: 'request',
        method: r.method,
        url: r.url,
        status: r.status,
        durationMs: r.durationMs,
        resourceType: r.resourceType,
        bodyPreview: r.bodyPreview,
      });
    }

    events.sort((a, b) => a.ts - b.ts);
    return { sessionId: sessionId || null, domain, events };
  }

  // GET /api/skills
  listSkills(domain) {
    const sql = `SELECT skill_id AS skillId, name, domain, description, path, version,
                   created_at AS createdAt, updated_at AS updatedAt
                 FROM skills ${domain ? 'WHERE domain = ?' : ''} ORDER BY updated_at DESC`;
    return domain ? this.db.prepare(sql).all(domain) : this.db.prepare(sql).all();
  }

  // POST /api/skills：注册/更新技能索引
  upsertSkill({ skillId, name, domain, description, path }) {
    if (!skillId || !name || !domain || !path) {
      throw new Error('技能注册缺少必填字段：skillId、name、domain、path');
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO skills(skill_id, name, domain, description, path, version, created_at, updated_at)
         VALUES(?,?,?,?,?,1,?,?)
         ON CONFLICT(skill_id) DO UPDATE SET
           name=excluded.name, domain=excluded.domain, description=excluded.description,
           path=excluded.path, version=version+1, updated_at=excluded.updated_at`
      )
      .run(skillId, name, domain, description || null, path, now, now);
  }

  // POST /api/sessions/close：按会话 ID 关闭（跨域名表扫描定位）
  closeSession(sessionId) {
    if (!sessionId) throw new Error('缺少会话 ID');
    const rows = this.db.prepare('SELECT sessions_table AS t FROM site_tables').all();
    let closed = 0;
    for (const row of rows) {
      const info = this.db
        .prepare(
          `UPDATE ${row.t} SET ended_at=COALESCE(ended_at,last_activity), closed=1
           WHERE session_id=? AND closed=0`
        )
        .run(sessionId);
      closed += info.changes;
    }
    return { closed };
  }

  // 定期整理（契约 §2.3）：关闭超时无事件会话、清理空会话、wal_checkpoint(TRUNCATE)
  maintenance() {
    const now = Date.now();
    const threshold = now - this.idleTimeoutMs;
    const tables = this.db.prepare('SELECT sessions_table AS t FROM site_tables').all();
    for (const row of tables) {
      // 关闭空闲超时会话
      this.db
        .prepare(
          `UPDATE ${row.t} SET closed=1, ended_at=last_activity
           WHERE closed=0 AND last_activity < ?`
        )
        .run(threshold);
      // 清理 page_count=0 的空会话（已关闭且无行为/页面）
      this.db
        .prepare(
          `DELETE FROM ${row.t} WHERE closed=1 AND page_count=0 AND event_count=0`
        )
        .run();
    }
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  // compact：手动整理数据库（CLI compact 命令）
  compact() {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.exec("INSERT INTO behaviors_fts(behaviors_fts) VALUES('optimize')");
    this.db.pragma('optimize');
    const stat = this.db.prepare('PRAGMA database_list').all();
    const pageCount = this.db.prepare('PRAGMA page_count').get().page_count;
    const pageSize = this.db.prepare('PRAGMA page_size').get().page_size;
    return { file: this.dbPath, pages: pageCount, sizeBytes: pageCount * pageSize, database: stat };
  }

  // GET /health 汇总
  health(uptimeSec) {
    const siteCount = this.db.prepare('SELECT COUNT(*) AS c FROM sites').get().c;
    const eventCount = this.db.prepare('SELECT COALESCE(SUM(event_count),0) AS c FROM sites').get().c;
    return { status: 'ok', db: this.dbPath, uptimeSec, siteCount, eventCount };
  }

  setIdleTimeout(ms) {
    this.idleTimeoutMs = Number(ms);
  }

  close() {
    this.db.close();
  }
}
