#!/usr/bin/env node
// 模块D 自检工具：按契约 §2 构造含 2~3 条相似会话轨迹的临时 daemon 数据库
// 场景：同一站点重复执行「打开商品页 → 点击商品卡片 → 点击加入购物车 → 输入数量 → 点击提交订单 → 跳转确认页」
// 用法：node replay/distill/seed-mock-db.js [--db-path <路径>]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { resolveDbPath, sanitizeDomain } from './src/paths.js';

/** 造数使用的站点域名 */
const MOCK_DOMAIN = 'example.com';

/** 生成行为记录去重 text_hash：sha256(selector|type|detail 前 200 字符)（契约 §2.2） */
function textHash(selector, type, detail) {
  const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
  return crypto
    .createHash('sha256')
    .update(`${selector || ''}|${type}|${detailText.slice(0, 200)}`)
    .digest('hex');
}

/**
 * 构造一个会话的事件列表（含重复主流程 + 噪声事件）
 * @param {string} sessionId
 * @param {number} baseTs 起始时间戳
 * @param {{qty?:string, extraFavorite?:boolean}} tweak 会话间细微差异
 * @returns {Array<{type:string, url:string, selector:string, element:object, detail:object}>}
 */
function buildSessionEvents(sessionId, baseTs, tweak = {}) {
  const qty = tweak.qty || '2';
  const url = 'https://example.com/item/1';
  const events = [];
  let ts = baseTs;
  const push = (type, detail = {}, extra = {}) => {
    events.push({
      type,
      ts: ts += 300,
      url: extra.url || url,
      selector: extra.selector || detail.selector || '',
      element: extra.element || {},
      detail,
    });
  };

  // 会话启动 / 页面加载（噪声，蒸馏阶段会丢弃）
  push('session_start', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    screenWidth: 1920,
    screenHeight: 1080,
    startUrl: url,
  });
  push('page_load', { referrer: 'https://example.com/', title: '经典T恤 - 商品详情' });

  // 主流程 1：进入商品详情页
  push('navigation', { url, title: '经典T恤 - 商品详情', transitionType: 'typed' });

  // 噪声：鼠标移动（蒸馏阶段丢弃）
  push('mousemove', { selector: '#item-card', clientX: 320, clientY: 210 });

  // 主流程 2：点击商品卡片
  push('click', {}, {
    selector: '#item-card',
    element: { tag: 'div', id: 'item-card', text: '经典T恤', href: '', role: '', ariaLabel: '', inputType: '', redacted: false },
  });

  // 噪声：同方向连续滚动（蒸馏阶段会合并）
  push('scroll', { scrollX: 0, scrollY: 240, scrollHeight: 1600, clientHeight: 800, direction: 'down' });
  push('scroll', { scrollX: 0, scrollY: 520, scrollHeight: 1600, clientHeight: 800, direction: 'down' });
  push('heartbeat', { active: true });

  // 会话3 额外噪声：点了一下收藏（不进入主链，用于验证支持度过滤）
  if (tweak.extraFavorite) {
    push('click', {}, {
      selector: 'button.favorite',
      element: { tag: 'button', text: '收藏', href: '', role: '', ariaLabel: '', inputType: '', redacted: false },
    });
  }

  // 主流程 3：点击加入购物车
  push('click', {}, {
    selector: 'button.add-cart',
    element: { tag: 'button', id: 'add-cart', class: 'btn primary', text: '加入购物车', href: '', role: '', ariaLabel: '', inputType: '', redacted: false },
  });

  // 噪声：聚焦输入框（蒸馏阶段丢弃）
  push('focus', { selector: 'input.qty', element: { tag: 'input', text: '' } });

  // 主流程 4：输入购买数量（非敏感值，参与链匹配）
  push('input', { selector: 'input.qty', inputType: 'number', value: qty });

  // 噪声：失焦（蒸馏阶段丢弃）
  push('blur', { selector: 'input.qty', element: { tag: 'input', text: '' } });

  // 主流程 5：点击提交订单
  push('click', {}, {
    selector: 'button.submit',
    element: { tag: 'button', id: 'submit-btn', class: 'btn primary', text: '提交订单', href: '', role: '', ariaLabel: '', inputType: '', redacted: false },
  });

  // 主流程 6：跳转到订单确认页（链尾 URL 变化，用于生成 url 断言）
  push('navigation', {
    url: 'https://example.com/order/confirm',
    title: '订单确认',
    transitionType: 'link',
  }, { url: 'https://example.com/order/confirm' });

  // 噪声：请求记录、tab 切换、页面隐藏（蒸馏阶段丢弃）
  push('request', { method: 'GET', requestUrl: 'https://example.com/api/order', status: 200, durationMs: 180, resourceType: 'xhr' }, { url: 'https://example.com/api/order' });
  push('tabswitch', { active: true });
  push('page_hide', {});

  return events;
}

/**
 * 按契约 §2 在指定路径构造 mock 数据库并写入 3 条相似会话轨迹
 * @param {string} [dbPathOpt] 数据库路径；缺省读 DB_PATH / 项目默认路径
 * @returns {{ dbPath: string, sessionCount: number, behaviorCount: number, domain: string }}
 */
export function seedMockDb(dbPathOpt) {
  const dbPath = resolveDbPath(dbPathOpt);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // 库文件已存在则先删除，保证自检数据干净可复现
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout=5000');

  const suffix = sanitizeDomain(MOCK_DOMAIN);
  const sessionsTable = `sessions_${suffix}`;
  const behaviorsTable = `behaviors_${suffix}`;

  // 全局表（契约 §2.1）
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      site_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      domain       TEXT NOT NULL UNIQUE,
      first_seen   INTEGER NOT NULL,
      last_seen    INTEGER NOT NULL,
      event_count  INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS site_tables (
      domain         TEXT PRIMARY KEY,
      sessions_table TEXT NOT NULL,
      pages_table    TEXT NOT NULL,
      behaviors_table TEXT NOT NULL,
      requests_table TEXT NOT NULL,
      created_at     INTEGER NOT NULL
    );
  `);

  // 域名实体表（契约 §2.2）
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${sessionsTable} (
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
    CREATE TABLE IF NOT EXISTS ${behaviorsTable} (
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
    -- 去重唯一约束：SQLite 不允许表内联 UNIQUE 使用 COALESCE 表达式，改为唯一索引实现（契约 §2.2 等价语义）
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bh_${suffix}
      ON ${behaviorsTable}(session_id, ts, type, COALESCE(selector,''), COALESCE(text_hash,''));
    CREATE INDEX IF NOT EXISTS idx_bh_${suffix}_ts      ON ${behaviorsTable}(ts);
    CREATE INDEX IF NOT EXISTS idx_bh_${suffix}_session ON ${behaviorsTable}(session_id, ts);
  `);

  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO sites(domain, first_seen, last_seen, event_count, status) VALUES (?, ?, ?, ?, ?)')
    .run(MOCK_DOMAIN, now, now, 0, 'active');
  const siteRow = db.prepare('SELECT site_id FROM sites WHERE domain = ?').get(MOCK_DOMAIN);
  const siteId = siteRow.site_id;

  db.prepare('INSERT OR IGNORE INTO site_tables(domain, sessions_table, pages_table, behaviors_table, requests_table, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(MOCK_DOMAIN, sessionsTable, `pages_${suffix}`, behaviorsTable, `requests_${suffix}`, now);

  // 三条会话：前两条高度一致，第三条多一次「收藏」点击、数量值略有差异（主链仍重复）
  const sessionSpecs = [
    { sessionId: 's_mock_001', baseTs: now - 3600_000, tweak: {} },
    { sessionId: 's_mock_002', baseTs: now - 1800_000, tweak: {} },
    { sessionId: 's_mock_003', baseTs: now - 600_000, tweak: { qty: '3', extraFavorite: true } },
  ];

  const insertSession = db.prepare(
    `INSERT INTO ${sessionsTable}(session_id, site_id, started_at, ended_at, page_count, event_count, user_agent, screen, last_activity, closed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertBehavior = db.prepare(
    `INSERT OR IGNORE INTO ${behaviorsTable}(session_id, page_id, site_id, ts, type, url, selector, element_info, detail, text_hash, redacted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  );

  let behaviorCount = 0;
  for (const spec of sessionSpecs) {
    const events = buildSessionEvents(spec.sessionId, spec.baseTs, spec.tweak);
    insertSession.run(
      spec.sessionId,
      siteId,
      spec.baseTs,
      spec.baseTs + events.length * 300,
      2,
      events.length,
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      '1920x1080',
      spec.baseTs + events.length * 300,
      1
    );
    for (const event of events) {
      const detailText = JSON.stringify(event.detail || {});
      insertBehavior.run(
        spec.sessionId,
        null,
        siteId,
        event.ts,
        event.type,
        event.url,
        event.selector || null,
        JSON.stringify(event.element || {}),
        detailText,
        textHash(event.selector, event.type, detailText)
      );
      behaviorCount += 1;
    }
  }

  const countRow = db.prepare(`SELECT count(*) c FROM ${behaviorsTable}`).get();
  behaviorCount = countRow.c;
  db.close();

  return { dbPath, sessionCount: sessionSpecs.length, behaviorCount, domain: MOCK_DOMAIN };
}

/** CLI 入口 */
function main() {
  const args = process.argv.slice(2);
  let dbPath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db-path') dbPath = args[++i];
  }
  const result = seedMockDb(dbPath);
  console.log('==================== Mock 数据生成完成 ====================');
  console.log(`域名：${result.domain}`);
  console.log(`数据库：${result.dbPath}`);
  console.log(`写入会话：${result.sessionCount} 条；行为记录：${result.behaviorCount} 条`);
  console.log('场景：打开商品页 → 点击商品卡片 → 加入购物车 → 输入数量 → 提交订单 → 跳转确认页');
}

import { pathToFileURL } from 'node:url';
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
