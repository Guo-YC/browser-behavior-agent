#!/usr/bin/env node
// cli.js —— 命令行管理工具（契约 §3 末尾）：查询 / 导入 mock / 关闭会话 / 整理数据库。
// CLI 直接打开本机 SQLite（不依赖 HTTP 服务在线），便于离线排障与数据核对。
// 用法：node bin/cli.js <命令> [参数]，全部文案中文。

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';

// ---- 命令行参数解析 ----
// 将 --key value / --flag 形式解析为对象
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

// 打印 JSON 到 stdout（美化输出）
function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

const HELP = `浏览器行为采集守护进程 · 管理命令行（模块B）

【查询类】node bin/cli.js query <子命令> [过滤参数]
  query sites                          列出已采集网站（域名、事件量、表名）
  query sessions --domain <域名>        查询某网站会话列表
        [--from <毫秒时间戳>] [--to <毫秒时间戳>] [--limit <条数>]
  query behaviors --domain <域名>      查询行为记录
        [--session <会话ID>] [--type <类型>] [--from <时间戳>] [--to <时间戳>]
        [--url <URL片段>] [--limit <条数，默认200>] [--offset <偏移，默认0>]
  query requests --domain <域名>       查询网络请求记录（已脱敏）
        [--method <GET/POST...>] [--url <URL片段>] [--status <状态码>]
        [--from <时间戳>] [--to <时间戳>] [--limit <条数，默认200>]
  query stats --domain <域名>          行为统计
        [--group type|page|hour，默认 type] [--from <时间戳>] [--to <时间戳>]
  query search --q <关键词>            全文检索（URL / 选择器 / 元素文本 / 详情）
        [--domain <域名>] [--limit <条数，默认50>]
  query trajectory --domain <域名>     行为轨迹（行为 + 页面 + 请求，按时间升序）
        [--session <会话ID>] [--from <时间戳>] [--to <时间戳>]
  query skills [--domain <域名>]       列出已注册技能索引

【维护类】
  ingest <json文件>                    从 JSON 文件批量导入事件
                                       文件为 {"type":"batch","events":[...]} 或直接事件数组
  close-session <会话ID> [--reason <原因>]  手动关闭指定会话
  compact                              整理数据库：WAL checkpoint(TRUNCATE)、FTS optimize、PRAGMA optimize
  help                                 显示本帮助

【环境变量】
  PORT                     HTTP 端口，默认 8756（CLI 不监听端口，仅说明）
  DB_PATH                  数据库路径，默认 daemon/data/behavior.db
  IDLE_TIMEOUT_MS          会话空闲超时，默认 1800000（30 分钟）
  MAINTENANCE_INTERVAL_MS  定期整理间隔，默认 1800000（30 分钟）
`;

function requireDomain(domain) {
  if (!domain) throw new Error('缺少必填参数 --domain <域名>');
}

function main() {
  const [, , cmd, sub, ...rest] = process.argv;
  const flags = parseFlags(rest);

  // 未给命令或 help → 打印帮助
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const store = new Store(config.dbPath);
  store.init();
  store.setIdleTimeout(config.idleTimeoutMs);

  let result;
  try {
    // ---------------- 查询类 ----------------
    if (cmd === 'query') {
      switch (sub) {
        case 'sites':
          result = store.querySites();
          break;
        case 'sessions':
          requireDomain(flags.domain);
          result = store.querySessions({
            domain: flags.domain, from: flags.from, to: flags.to, limit: flags.limit ?? 100,
          });
          break;
        case 'behaviors':
          requireDomain(flags.domain);
          result = store.queryBehaviors({
            domain: flags.domain, sessionId: flags.session, type: flags.type,
            from: flags.from, to: flags.to, urlContains: flags.url,
            limit: flags.limit ?? 200, offset: flags.offset ?? 0,
          });
          break;
        case 'requests':
          requireDomain(flags.domain);
          result = store.queryRequests({
            domain: flags.domain, method: flags.method, urlContains: flags.url,
            status: flags.status, from: flags.from, to: flags.to, limit: flags.limit ?? 200,
          });
          break;
        case 'stats':
          requireDomain(flags.domain);
          result = store.queryStats({
            domain: flags.domain, from: flags.from, to: flags.to,
            groupBy: flags.group ?? 'type',
          });
          break;
        case 'search':
          if (!flags.q) throw new Error('缺少必填参数 --q <关键词>');
          result = store.search(flags.q, flags.domain, flags.limit ?? 50);
          break;
        case 'trajectory':
          requireDomain(flags.domain);
          result = store.trajectory({
            domain: flags.domain, sessionId: flags.session, from: flags.from, to: flags.to,
          });
          break;
        case 'skills':
          result = store.listSkills(flags.domain);
          break;
        default:
          throw new Error(`未知查询子命令：${sub}（可选 sites/sessions/behaviors/requests/stats/search/trajectory/skills）`);
      }
    } else if (cmd === 'ingest') {
      // ---------------- 导入类 ----------------
      const file = sub;
      if (!file) throw new Error('缺少 JSON 文件路径：node bin/cli.js ingest <json文件>');
      const abs = path.resolve(process.cwd(), file);
      if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`);
      const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
      const events = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.events) ? parsed.events : []);
      const ingestResult = store.ingestBatch(events);
      result = { ok: true, file: abs, ...ingestResult };
    } else if (cmd === 'close-session') {
      // ---------------- 关闭会话 ----------------
      if (!sub) throw new Error('缺少会话 ID：node bin/cli.js close-session <会话ID> [--reason <原因>]');
      const closeResult = store.closeSession(sub);
      result = { ok: true, sessionId: sub, reason: flags.reason || 'manual', closed: closeResult.closed };
    } else if (cmd === 'compact') {
      // ---------------- 整理数据库 ----------------
      result = { ok: true, ...store.compact() };
    } else {
      throw new Error(`未知命令：${cmd}（输入 node bin/cli.js help 查看用法）`);
    }
  } finally {
    try { store.close(); } catch { /* 忽略关闭异常 */ }
  }

  printJson(result);
}

try {
  main();
} catch (err) {
  process.stderr.write(`错误：${err.message}\n`);
  process.exit(1);
}
