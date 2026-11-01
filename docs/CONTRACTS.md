# 共享契约 CONTRACTS.md（唯一事实源）

> 本文件是「浏览器行为采集端 + 本地存储 + MCP 服务 + 技能蒸馏/回放」各模块之间**唯一**的接口事实源。所有模块按本契约开发；修改任何接口必须先改本文件并知会相关模块。
> 语言规范：代码注释、README、MCP 工具描述、CLI 帮助、报错文案**全部中文**；代码标识符用英文。

## 0. 目录布局与模块边界

```
browser-behavior-agent/
├── README.md                # 主索引
├── docs/CONTRACTS.md        # 本文件
├── extension/               # 模块A：Chrome MV3 扩展（WXT + TS）
├── daemon/                  # 模块B：本地守护进程（Node + better-sqlite3）
│   ├── bin/daemon.js        #   守护进程入口（server 模式）
│   ├── bin/host.js          #   Native Messaging host 入口（host 模式，内部启动完整 daemon）
│   ├── bin/cli.js           #   命令行管理工具（查询/导入 mock/关闭会话）
│   ├── src/                 #   存储、去重、FTS、HTTP API、session 管理
│   └── deploy/browser-behavior-daemon.service  # systemd user unit
├── mcp/                     # 模块C：MCP Server（stdio + Streamable HTTP 双传输）
├── replay/
│   ├── distill/             # 模块D：技能蒸馏（Browser-BC 思路）
│   ├── runner/              # 模块E：确定性回放（Paragent 思路，CDP/Playwright）
│   ├── skills/              # 技能 JSON 文件目录（D 写入；E 只读；MCP 只读）
│   └── README.md            # replay 层说明
├── scripts/
│   ├── install-native-host.sh   # 模块B 写：注册 Native Messaging host + systemd（Linux）
│   ├── install-native-host.ps1  # Windows 版
│   ├── mock-events.js           # 组织者写：模拟扩展批量事件
│   └── verify-chain.sh          # 组织者写：端到端最小链路验证
├── package.json             # 根：便捷脚本（非 workspace，各模块独立 package.json）
└── .gitignore
```

端口约定：daemon HTTP API = **127.0.0.1:8756**；MCP Streamable HTTP = **127.0.0.1:8765**。
Native Messaging host 名称：**`com.browser.behavior.collector`**。
数据库路径默认：`daemon/data/behavior.db`（WAL 模式）。

---

## 1. 事件协议（扩展 → 守护进程）

### 1.1 传输：Native Messaging（主） + HTTP 调试（次）

- 扩展通过 `chrome.runtime.connectNative('com.browser.behavior.collector')` 建立**长连接**。
- 帧格式：**4 字节小端长度前缀 + UTF-8 JSON**（Chrome 原生协议）。
- 扩展侧**批量发送**：每 500ms 或攒满 50 条事件（先到先发）打包为一个消息；单条消息 ≤ 1MB（超限拆包）。
- 批量消息信封：`{ "type": "batch", "seq": 42, "events": [ ... ] }`
- 守护进程必须对每条消息回 `{"ok":true,"received":<条数>}`；收到 `{"type":"ping"}` 回 `{"ok":true,"pong":true}`。
- 断线处理：host 进程被 Chrome 拉起/杀死是常态，守护进程写库必须**每次消息独立事务**（WAL + busy_timeout≥5000），支持多 host 实例并发写。
- 调试/验证通道：daemon 同时提供 `POST /api/events`（信封格式与 batch 完全一致），供 mock 脚本与手工调试使用。

### 1.2 事件公共字段（每条事件必须携带）

```json
{
  "type": "click|dblclick|mousemove|mouseenter|contextmenu|input|keydown|scroll|focus|blur|navigation|tabswitch|page_load|page_hide|request|session_start|session_end|heartbeat",
  "ts": 1730000000000,
  "sessionId": "s_<uuid>",
  "tabId": 123,
  "url": "https://example.com/a/b",
  "title": "页面标题",
  "domain": "example.com"
}
```

- `domain`：小写，去端口去 www（hostname 本身，如 `example.com`、`sub.example.com`）。
- `sessionId`：扩展生成，**tab 级**（一个 tab 一个会话，跨导航保持；tab 关闭或空闲 30min 结束）。
- 所有事件必须校验通过才入库；daemon 对未知 type 记 `type=unknown` 仍入库（detail 原样），不丢弃。

### 1.3 各类型 detail 字段（JSON 对象）

| type | detail 字段 | 说明 |
|---|---|---|
| `session_start` | `{userAgent, screenWidth, screenHeight, startUrl}` | 每 tab 首次 page_load 前发送 |
| `session_end` | `{reason: "tab_close"\|"idle"\|"replaced"}` | tab 关闭/替换/空闲超时 |
| `page_load` | `{referrer, title}` | 新文档加载完成 |
| `navigation` | `{url, title, transitionType}` | SPA pushState/hashchange 也发 |
| `page_hide` | `{}` | 页面隐藏/卸载 |
| `click` `dblclick` `contextmenu` | `{selector, element, button, clientX, clientY}` | button: 0/1/2 |
| `mousemove` | `{selector, clientX, clientY}` | 节流 ≥500ms/条/页 |
| `mouseenter` | `{selector, element}` | 节流 ≥1s/条/页 |
| `input` | `{selector, element, inputType, value}` | value ≤500 字符；敏感字段见 §1.4 |
| `keydown` | `{selector, key, code, ctrlKey, metaKey, altKey, shiftKey}` | 密码框 key 置 `"****"` |
| `scroll` | `{scrollX, scrollY, scrollHeight, clientHeight, direction}` | 节流 ≥200ms/条/页 |
| `focus` `blur` | `{selector, element}` | |
| `tabswitch` | `{active: true\|false}` | 来自 background |
| `request` | `{method, requestUrl, status, durationMs, resourceType, reqHeaders, respHeaders, postBodyPreview}` | 见 §1.5；`reqHeaders`/`respHeaders` 为已脱敏对象 |
| `heartbeat` | `{active: true}` | 空闲期保持会话 |

`element` 对象（选择器相关元信息，text ≤200 字符）：`{ "tag": "button", "id": "submit-btn", "class": "btn primary", "text": "提交", "href": "", "role": "", "ariaLabel": "", "inputType": "", "redacted": false }`

### 1.4 敏感字段硬丢弃规则（扩展采集层强制执行，不落盘原文）

1. 元素 `type=password` → `value`/`key` 一律 `"****"`，`element.redacted=true`。
2. 元素 `name/id/autocomplete/aria-label/placeholder` 匹配正则 `/(passw|pwd|token|secret|api[_-]?key|apikey|credit|card|cvv|cvc|pin|auth|session[_-]?id|ssn)/i` → 值脱敏同上。
3. `copy`/`paste` 不进事件流（不采集）；如需记录用 `input` 事件即可，只记长度不记内容。
4. 请求 URL 中 `token|access_token|signature|key|secret` 等查询参数值 → `"****"`。
5. 请求头剥离：`authorization, cookie, set-cookie, proxy-authorization, x-api-key, x-auth-token, x-csrf-token`。
6. 上述规则在扩展内做成可配置列表（options 页可开关/追加），默认全部开启。

### 1.5 请求记录（request 事件）

- 采集来源：background service worker 的 `chrome.webRequest.onCompleted/onErrorOccurred`。
- 权限：`webRequest` + `host_permissions: ["<all_urls>"]`。
- `postBodyPreview`：仅当 `requestBody.raw` 存在且是 JSON/表单时才截取 ≤1KB 前缀；含敏感字段名则整段置 `"****"`。

## 2. 数据库 Schema（better-sqlite3，WAL + FTS5，按域名自动分表）

### 2.1 全局表

```sql
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
```

### 2.2 按域名自动分表（核心机制）

- 域名 `D` 首次出现时，daemon 自动创建 4 张实体表：`sessions_<D>`、`pages_<D>`、`behaviors_<D>`、`requests_<D>`（表名对域名做清洗：非 `[a-zA-Z0-9_]` 字符替换为 `_`），并写入 `site_tables` 与 `sites`。
- 后续该域名事件全部路由到对应表；跨域名查询由 daemon API 按 `domain` 参数自动选表。
- 每张表创建时带配套索引。

```sql
CREATE TABLE IF NOT EXISTS sessions_<D> (
  session_id  TEXT PRIMARY KEY,
  site_id     INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  page_count  INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  user_agent  TEXT,
  screen      TEXT,
  closed      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pages_<D> (
  page_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  site_id   INTEGER NOT NULL,
  url       TEXT NOT NULL,
  title     TEXT,
  visit_ts  INTEGER NOT NULL,
  leave_ts  INTEGER
);
CREATE TABLE IF NOT EXISTS behaviors_<D> (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_bh_<D> ON behaviors_<D>(session_id, ts, type, COALESCE(selector,''), COALESCE(text_hash,''));
CREATE INDEX IF NOT EXISTS idx_bh_<D>_ts ON behaviors_<D>(ts);
CREATE INDEX IF NOT EXISTS idx_bh_<D>_session ON behaviors_<D>(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_bh_<D>_type ON behaviors_<D>(type);
CREATE INDEX IF NOT EXISTS idx_bh_<D>_url ON behaviors_<D>(url);
CREATE TABLE IF NOT EXISTS requests_<D> (
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
CREATE INDEX IF NOT EXISTS idx_rq_<D>_ts ON requests_<D>(ts);
CREATE INDEX IF NOT EXISTS idx_rq_<D>_url ON requests_<D>(url);
```

### 2.3 写入与整理

- 每次 Native/HTTP 消息 = 一个事务；`INSERT OR IGNORE` 去重（UNIQUE 约束）。
- 事务内更新 `sites.event_count/last_seen`、`sessions_<D>.event_count/page_count`、`pages_<D>` 的 visit/leave。
- FTS：事务提交后，对实际新插入的 behaviors 行执行 `INSERT INTO behaviors_fts(...)`。
- 定期整理（默认每 30min）：关闭超时（默认 30min）无事件会话、清理空会话、`PRAGMA wal_checkpoint(TRUNCATE)`。
- 查询侧使用 `PRAGMA busy_timeout=5000`。

---

## 3. 守护进程 HTTP API（127.0.0.1:8756，前缀 /api）

> 除 /health 外均需可用的 JSON 响应；错误统一 `{"error": "中文描述"}`。`domain` 必填的接口缺失时返回 400。

| 方法/路径 | 参数 | 返回 |
|---|---|---|
| GET /health | - | `{status:"ok", db, uptimeSec, siteCount, eventCount}` |
| POST /api/events | body=`{"type":"batch","events":[...]}` | `{ok:true, received, inserted, ignored}` |
| GET /api/sites | - | `[{domain, firstSeen, lastSeen, eventCount, status, tableName}]` |
| GET /api/sessions | `domain, from, to, limit=100` | `[{sessionId, startedAt, endedAt, pageCount, eventCount, userAgent, screen}]` |
| GET /api/behaviors | `domain, sessionId?, type?, from?, to?, urlContains?, limit=200, offset=0` | `{total, items:[...]}` |
| GET /api/requests | `domain, method?, urlContains?, status?, from?, to?, limit=200` | `{total, items:[...]}` |
| GET /api/stats | `domain, from?, to?, groupBy=type\|page\|hour` | `[{key, count}]` |
| GET /api/search | `q, domain?, limit=50` | FTS5 命中 |
| GET /api/trajectory | `domain, sessionId?, from?, to?` | `{sessionId, domain, events:[...]}` |
| GET /api/skills | `domain?` | `[{skillId, name, domain, description, path, version, createdAt, updatedAt}]` |
| POST /api/skills | `{skillId,name,domain,description,path}` | 注册/更新技能索引 → `{ok:true}` |
| POST /api/sessions/close | `{sessionId, reason}` | `{ok:true}` |

- daemon 提供 `daemon/bin/cli.js`（中文 help）。
- 环境变量：`PORT`(8756)、`DB_PATH`、`IDLE_TIMEOUT_MS`(30min)、`MAINTENANCE_INTERVAL_MS`(30min)。

## 4. MCP Server 工具清单（中文描述，英文名）

传输：**stdio**（默认）+ **Streamable HTTP**（`--http --port 8765`）。
配置项环境变量：`DAEMON_URL`、`REPLAY_DIR`、`DB_PATH`。

| 工具名 | 入参（加粗为必填） | 中文描述 |
|---|---|---|
| `list_sites` | - | 列出已采集的网站（域名）及事件量 |
| `query_behaviors` | **domain**, sessionId?, type?, from?, to?, urlContains?, limit?, offset? | 按网站查询行为记录 |
| `query_sessions` | **domain**, from?, to?, limit? | 查询某网站的浏览会话列表 |
| `query_requests` | **domain**, method?, urlContains?, status?, from?, to?, limit? | 查询采集到的网络请求（已脱敏） |
| `behavior_stats` | **domain**, from?, to?, groupBy? | 行为链路统计 |
| `fulltext_search` | **query**, domain?, limit? | 全文检索行为记录 |
| `export_trajectory` | **domain**, sessionId?, from?, to?, format? | 导出行为轨迹（json/markdown） |
| `distill_skill` | **domain**, name?, sessionIds?, minOccurrences?, maxSteps? | 从重复轨迹蒸馏技能 |
| `list_skills` | domain? | 列出已蒸馏的技能 |
| `trigger_replay` | **skillId**, mode?, headless?, targetUrl? | 按技能执行确定性回放 |

实现要求：所有工具返回 JSON 字符串，中文错误信息；`distill_skill`/`trigger_replay` 通过动态 `import()` 调用 `replay/distill`、`replay/runner` 导出函数。

---

## 5. 技能 JSON 格式（replay/skills/<skillId>.json）

```json
{
  "skillId": "skl_<sha256前16位>",
  "name": "下单流程",
  "domain": "example.com",
  "description": "从商品页点击加入购物车并提交订单",
  "targetUrlPattern": "^https://example\\.com/.*",
  "createdAt": 1730000000000,
  "version": 1,
  "sourceSessions": ["s_xxx", "s_yyy"],
  "evidence": { "trajectoryCount": 3, "matchRate": 0.92 },
  "actions": [
    {
      "step": 1,
      "type": "navigate|click|dblclick|input|scroll|hover|wait|assert",
      "selector": "html > body > div#app > button.btn-primary",
      "value": "示例输入内容",
      "waitMs": 300,
      "optional": false,
      "assertions": [
        { "kind": "url_contains|text_present|element_present|url_change", "target": "https://example.com/cart", "timeoutMs": 5000 }
      ]
    }
  ]
}
```

- 动作只保留可执行/可断言类型，丢弃 mousemove/mouseenter 等噪声。
- `evidence.matchRate`：该动作链在源轨迹中的平均出现率。
- 蒸馏结果必须同时写入 `replay/skills/<skillId>.json` 并调用 daemon `POST /api/skills` 注册索引。

---

## 6. 回放执行器（Paragent 思路）

| 模式 | 行为 |
|---|---|
| `dry_run` | 不连浏览器：逐动作校验，输出执行计划 + 断言预检 |
| `cdp` | 通过 `chrome-remote-interface` 连 `127.0.0.1:9222`，真实点击/输入/导航 |
| `playwright` | 用 `playwright-core`：优先 connectOverCDP，无则 launch channel:chrome |

- 每步执行后运行该步 assertions，记录 `{step, action, status: PASS|FAIL|SKIP, detail}`。
- 失败策略：`optional:true` → SKIP；`optional:false` → 中止返回失败步。
- CLI：`node replay/runner/index.js --skill <skillId> --mode ...`；ESM 导出 `runSkill(skill, opts)` 供 MCP 调用。

---

## 7. 技能蒸馏算法（Browser-BC 思路，模块D）

1. 从 daemon 取指定 domain 的全部轨迹（按 session 分组、按 ts 排序）。
2. 轨迹清洗：丢弃 mousemove/mouseenter/heartbeat/focus/blur/tabswitch；scroll 降采样。
3. 动作序列化：`type|selector|value`。
4. 用 LCS/前缀树在 ≥minOccurrences 条轨迹中挖掘重复动作链。
5. 对每条候选链评分，取 Top-N 生成技能。
6. 断言生成：链尾 URL 变化 → url_change；click 目标文本非空 → text_present；input 后元素存在 → element_present。
7. 输出：技能 JSON + 中文报告 + 注册索引。

---

## 8. 各模块验收标准（自检必须逐条通过）

| 模块 | 自检命令 | 必须通过 |
|---|---|---|
| A extension | `cd extension && pnpm install && pnpm build` | 产出 `.output/chrome-mv3/`；构建零报错 |
| B daemon | `node daemon/bin/daemon.js` + 灌 mock | /health 正常；sites 出现域名；search 命中；重启数据仍在 |
| C mcp | `node mcp/index.js --list` | 10 工具齐全；HTTP 能启动；list_sites 返回真实数据 |
| D distill | `node replay/distill/index.js --domain example.com --min-occurrences 2` | 产出技能 JSON + 中文报告 + 注册索引 |
| E runner | `node replay/runner/index.js --skill <skillId> --mode dry_run` | 输出逐动作 PASS/FAIL 中文报告 |

## 9. 硬约束

1. 所有代码中文注释；所有对外文案中文。
2. 扩展在**采集层**必须执行 §1.4 敏感字段规则。
3. daemon 写库必须支持并发 host 进程（WAL + busy_timeout）。
4. 各模块不得越过契约自行改接口；契约有缺陷先在 `docs/CONTRACTS.md` 追加修订记录。
5. 依赖用 npm 安装，版本：`@medv/finder@^4`、`better-sqlite3@^13`、`@modelcontextprotocol/sdk@^1`、`wxt` 稳定版、`playwright-core`、`chrome-remote-interface@^0.33`。
6. 涉及浏览器/系统级无法在本环境完整验证的部分，明确标注「已实现 + 待真机验证 + 验证步骤」。

## 10. 修订记录

| 版本 | 日期 | 修改 |
|---|---|---|
| v1.0 | 2026-10-31 | 初始契约 |
| v1.1 | 2026-10-31 | `sessions_<D>` 新增 `last_activity` 列，用于空闲超时判定 |
| v1.2 | 2026-10-31 | SQLite 不允许内联 UNIQUE 用 COALESCE，改独立唯一索引 `uq_bh_<D>` |
