# 浏览器行为采集守护进程（模块 B · daemon）

本地守护进程：接收浏览器扩展上报的行为事件，写入本机 SQLite（WAL 模式），对外提供
HTTP 查询 API、Chrome Native Messaging 入口与命令行管理工具。接口、Schema、协议一律以
项目根目录 `docs/CONTRACTS.md` 为唯一事实源（§1 协议、§2 Schema、§3 API、§8 验收、§9 硬约束）。

- 运行时：Node.js ≥ 20（实测 v22.23.2），依赖 `better-sqlite3@^13`（实测安装 13.0.3，预编译二进制直接可用，无需退回 12.x）
- 模块类型：ESM（`package.json` 中 `"type": "module"`）
- 监听地址：`127.0.0.1:8756`，HTTP 前缀 `/api`（除 `/health` 外）
- 日志：全部走 **stderr**；Native Messaging host 的 **stdout 只允许输出协议帧**，不写任何日志文本

---

## 1. 目录结构

```
daemon/
├── package.json                 # ESM 声明、依赖与 npm scripts
├── bin/
│   ├── daemon.js                # server 模式入口：HTTP API + 定期维护 + 优雅退出
│   ├── host.js                  # Native Messaging host 入口：4 字节小端帧协议
│   └── cli.js                   # 中文管理 CLI：查询 / 导入 / 关闭会话 / 整理库
├── src/
│   ├── config.js                # 环境变量配置（PORT / DB_PATH / IDLE_TIMEOUT_MS / MAINTENANCE_INTERVAL_MS）
│   ├── store.js                 # 存储层核心：全局 Schema、按域名分表、事务入库、FTS5、查询、维护
│   ├── httpServer.js            # §3 全部 HTTP 端点路由、1MB 请求体上限、统一中文错误 JSON
│   └── util.js                  # 域名清洗、去重哈希、JSON 安全解析、FTS 查询词转义
├── deploy/
│   └── browser-behavior-daemon.service   # systemd 用户单元（中文注释，绝对路径，Restart=on-failure）
└── data/
    ├── behavior.db              # 默认数据库（首次启动自动创建；已被 .gitignore 忽略）
    └── selfcheck/               # 模块 B 自检脚本与原始响应存档（详见第 9 节）
```

server 模式与 host 模式复用同一个 `Store` 类（`src/store.js`），入库、去重、FTS、会话统计逻辑完全一致。

---

## 2. 安装与启动

### 2.1 安装依赖

```bash
cd daemon
npm install
```

### 2.2 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8756` | HTTP API 监听端口（仅 server 模式使用） |
| `DB_PATH` | `daemon/data/behavior.db` | SQLite 数据库文件路径（目录自动创建） |
| `IDLE_TIMEOUT_MS` | `1800000`（30 分钟） | 会话空闲超时：超过该时长无事件自动关闭会话 |
| `MAINTENANCE_INTERVAL_MS` | `1800000`（30 分钟） | 定期整理间隔：关闭超时会话、清理空会话、`wal_checkpoint(TRUNCATE)` |

### 2.3 server 模式（HTTP 调试 / 常驻服务）

```bash
# 默认：127.0.0.1:8756，数据库 daemon/data/behavior.db
node bin/daemon.js

# 自定义端口与数据库路径（开发/自检常用）
PORT=8757 DB_PATH=/tmp/behavior-daemon/behavior.db node bin/daemon.js
```

启动后日志（stderr）示例：

```
[behavior-daemon 2026-10-31T15:00:00.000Z] HTTP API 已启动：http://127.0.0.1:8756/api
[behavior-daemon 2026-10-31T15:00:00.001Z] 数据库路径：/home/.../daemon/data/behavior.db
[behavior-daemon 2026-10-31T15:00:00.002Z] 会话空闲超时：1800000ms；定期整理间隔：1800000ms
```

端口被占用时打印中文原因并退出（`EADDRINUSE`），不会空转。收到 `SIGINT` / `SIGTERM` 时先执行
`compact()`（checkpoint + FTS optimize）再关闭数据库与 HTTP 服务。

### 2.4 host 模式（Chrome Native Messaging，由浏览器拉起）

```bash
node bin/host.js
```

- 从 **stdin** 按「4 字节小端长度前缀 + UTF-8 JSON」读帧；处理 `ping` / `batch`；
- 每条消息回一帧到 **stdout**；`stdin` EOF 后优雅退出（退出码 0）；
- host 进程被 Chrome 反复拉起 / 杀死是常态：每条消息独立事务落库，WAL + `busy_timeout=5000`
  支持多个 host 进程并发写，遇 `SQLITE_BUSY` 自动退避重试（最多 6 次）。

### 2.5 命令行管理工具（不依赖 HTTP 服务在线，直连本机 SQLite）

```bash
node bin/cli.js help
```

---

## 3. HTTP API（契约 §3）

基础地址：`http://127.0.0.1:8756`；除 `/health` 外路径均带 `/api` 前缀；错误统一返回
`{"error":"中文描述"}`；请求体上限 1MB。

| 方法 | 路径 | 必填参数 | 说明 |
|---|---|---|---|
| GET | `/health` | — | 健康检查：状态、数据库路径、运行时长、站点数、事件总数 |
| POST | `/api/events` | body `{ "events": [...] }` | 调试/批量事件通道，信封与 Native `batch` 一致 |
| GET | `/api/sites` | — | 已采集网站列表（域名、事件量、表名映射） |
| GET | `/api/sessions` | `domain` | 会话列表；可选 `from` `to` `limit` |
| GET | `/api/behaviors` | `domain` | 行为记录；可选 `sessionId` `type` `from` `to` `urlContains` `limit` `offset` |
| GET | `/api/requests` | `domain` | 网络请求记录（已脱敏）；可选 `method` `urlContains` `status` `from` `to` `limit` |
| GET | `/api/stats` | `domain` | 行为统计；`groupBy=type\|page\|hour`（默认 `type`），可选 `from` `to` |
| GET | `/api/search` | `q` | FTS5 全文检索（URL / 选择器 / 元素文本 / 详情）；可选 `domain` `limit` |
| GET | `/api/trajectory` | `domain` | 会话/时间段轨迹（行为 + 页面 + 请求合并，按时间升序）；可选 `sessionId` `from` `to` |
| GET | `/api/skills` | — | 技能索引列表；可选 `domain` |
| POST | `/api/skills` | body `skillId` `name` `domain` `path` | 注册 / 更新技能索引（重复注册版本号 +1） |
| POST | `/api/sessions/close` | body `sessionId` | 手动关闭指定会话（跨域名表扫描定位），返回 `{ok, closed}` |

### 3.1 curl 示例

```bash
# 健康检查
curl -s http://127.0.0.1:8756/health

# 批量灌入事件（信封与 Native batch 一致）
curl -s -X POST http://127.0.0.1:8756/api/events \
  -H 'content-type: application/json' \
  -d '{
    "events": [
      { "type": "session_start", "ts": 1793459204867, "sessionId": "s_001", "tabId": 1,
        "url": "https://example.com/", "title": "首页", "domain": "example.com",
        "detail": { "userAgent": "Mozilla/5.0 …", "screenWidth": 1920, "screenHeight": 1080 } },
      { "type": "click", "ts": 1793459211045, "sessionId": "s_001", "tabId": 1,
        "url": "https://example.com/", "title": "首页", "domain": "example.com",
        "detail": { "selector": "html > body > button.btn-view",
                    "element": { "tag": "BUTTON", "text": "查看商品" },
                    "button": 0, "clientX": 640, "clientY": 480 } }
    ]
  }'
# 返回：{"ok":true,"received":2,"inserted":2,"ignored":0}

# 站点列表
curl -s http://127.0.0.1:8756/api/sites

# 某域名会话列表
curl -s "http://127.0.0.1:8756/api/sessions?domain=example.com"

# 行为记录（按类型过滤）
curl -s "http://127.0.0.1:8756/api/behaviors?domain=example.com&type=click&limit=20"

# 网络请求记录
curl -s "http://127.0.0.1:8756/api/requests?domain=example.com&method=POST"

# 统计：按类型 / 页面 / 小时
curl -s "http://127.0.0.1:8756/api/stats?domain=example.com&groupBy=type"
curl -s "http://127.0.0.1:8756/api/stats?domain=example.com&groupBy=page"
curl -s "http://127.0.0.1:8756/api/stats?domain=example.com&groupBy=hour"

# 全文检索（关键词自动转义为 FTS5 双引号 AND 查询）
curl -s --get "http://127.0.0.1:8756/api/search" \
  --data-urlencode "q=提交订单" --data-urlencode "domain=example.com"

# 单会话轨迹（行为 + 页面 + 请求，按 ts 升序）
curl -s "http://127.0.0.1:8756/api/trajectory?domain=example.com&sessionId=s_001"

# 注册技能
curl -s -X POST http://127.0.0.1:8756/api/skills \
  -H 'content-type: application/json' \
  -d '{ "skillId": "skl_demo_001", "name": "下单流程", "domain": "example.com",
        "description": "示例技能", "path": "replay/skills/skl_demo_001.json" }'

# 技能列表
curl -s http://127.0.0.1:8756/api/skills

# 手动关闭会话
curl -s -X POST http://127.0.0.1:8756/api/sessions/close \
  -H 'content-type: application/json' -d '{ "sessionId": "s_001", "reason": "manual" }'
```

错误示例：

```bash
curl -s -w " [HTTP %{http_code}]" "http://127.0.0.1:8756/api/behaviors"
# {"error":"缺少必填参数 domain"} [HTTP 400]

curl -s -w " [HTTP %{http_code}]" "http://127.0.0.1:8756/api/nope"
# {"error":"接口不存在：GET /api/nope"} [HTTP 404]
```

---

## 4. Native Messaging 协议（契约 §1.1）

### 4.1 帧格式

```
[4 字节小端无符号整数 N][N 字节 UTF-8 JSON]
```

### 4.2 消息类型

**ping（心跳）**

```json
// 发送
{ "type": "ping" }
// 回复
{ "ok": true, "pong": true }
```

**batch（批量事件）**

```json
// 发送
{ "type": "batch", "seq": 1, "events": [ /* 事件数组，结构同 §1.2 */ ] }
// 回复
{ "ok": true, "received": 73, "inserted": 29, "ignored": 0 }
```

- `received`：收到事件条数；`inserted`：真实新插入条数；`ignored`：去重 / 非法事件条数。
- 单条消息入库失败时回复 `{ "ok": false, "error": "入库失败：…" }`，host 进程保持存活等待后续消息。
- 未知消息类型回复 `{ "ok": false, "error": "未知消息类型：…" }`。

### 4.3 事件类型路由（契约 §1.2 / §1.3）

| 事件类型 | 落库位置 |
|---|---|
| `session_start` | `sessions_<D>` 插入 / 更新会话（UA、屏幕尺寸、`last_activity`） |
| `session_end` | 标记会话 `closed=1`、写 `ended_at` |
| `page_load` / `navigation` | `pages_<D>` 页面访问记录 |
| `request` | `requests_<D>` 网络请求记录（请求头 / 响应头 / body 预览已由采集层脱敏） |
| `heartbeat` | 仅刷新会话 `last_activity` |
| 其余已知类型（`click` `input` `keydown` `scroll` `focus` `blur` `mousemove` …） | `behaviors_<D>` 行为记录，事务提交后写入 FTS5 |
| 不在已知集合内的类型 | 记为 `unknown` 仍入库（契约 §1.2 末段） |

---

## 5. 命令行 CLI（契约 §3 末尾）

```bash
# 查看全部命令（中文帮助）
node bin/cli.js help
```

### 5.1 查询类

```bash
# 已采集网站
DB_PATH=/path/to/behavior.db node bin/cli.js query sites

# 某域名会话列表（--from/--to 毫秒时间戳，--limit 条数）
node bin/cli.js query sessions --domain example.com --limit 50

# 行为记录（--session 会话ID；--type 类型；--url URL 片段；--from/--to；--limit/--offset）
node bin/cli.js query behaviors --domain example.com --type click --limit 20
node bin/cli.js query behaviors --domain example.com --session s_001 --url checkout

# 网络请求记录（--method GET/POST；--url 片段；--status 状态码；--from/--to；--limit）
node bin/cli.js query requests --domain example.com --method POST --status 201

# 行为统计（--group type|page|hour，默认 type）
node bin/cli.js query stats --domain example.com --group type
node bin/cli.js query stats --domain example.com --group page
node bin/cli.js query stats --domain example.com --group hour

# 全文检索（--q 关键词；--domain 可选；--limit 默认 50）
node bin/cli.js query search --q "提交订单" --domain example.com

# 行为轨迹（--session 会话ID；--from/--to）
node bin/cli.js query trajectory --domain example.com --session s_001

# 技能索引（--domain 可选）
node bin/cli.js query skills
```

### 5.2 维护类

```bash
# 从 JSON 文件批量导入事件（文件为 {"type":"batch","events":[...]} 或直接事件数组）
node bin/cli.js ingest ./events-backup.json

# 手动关闭指定会话（--reason 可选，默认 manual）
node bin/cli.js close-session s_001 --reason manual

# 整理数据库：wal_checkpoint(TRUNCATE) + FTS optimize + PRAGMA optimize
node bin/cli.js compact
```

CLI 缺参数 / 未知命令时向 stderr 输出中文错误并以退出码 1 结束。

---

## 6. 数据库与 Schema（契约 §2，含 v1.1 / v1.2 修订）

### 6.1 全局表

- `sites`：站点注册表（`domain` 唯一，`first_seen` / `last_seen` / `event_count` / `status`）；
- `site_tables`：域名 → 四张分表名映射；
- `skills`：技能索引（`skill_id` 主键，重复注册 `version+1`）；
- `behaviors_fts`：FTS5 虚拟表（`url` `selector` `element_text` `detail_text` 可检索；
  `domain` `behavior_id` `session_id` `ts` 为 UNINDEXED 附属列）。

### 6.2 按域名自动分表

域名归一化规则（`src/util.js`）：小写、去 `www.`、去端口；表名片段清洗规则：非
`[a-zA-Z0-9_]` 字符一律替换为 `_`，清洗结果只允许字母 / 数字 / 下划线，可直接拼入 SQL 表名
（杜绝标识符注入）。域名首次出现时自动创建：

```
sessions_<D>    会话表（含 v1.1 新增 last_activity 列，用于空闲超时判定）
pages_<D>       页面访问表（索引 idx_pg_<D>_session）
behaviors_<D>   行为表（索引 idx_bh_<D>_ts/_session/_type/_url）
requests_<D>    请求表（索引 idx_rq_<D>_ts/_url）
```

### 6.3 去重约束（v1.2 修订）

SQLite 不允许表内联 `UNIQUE(...)` 约束中使用 `COALESCE(...)` 表达式，因此行为去重使用
**独立唯一索引**（建表语句本身不含内联 UNIQUE）：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_bh_<D>
  ON behaviors_<D>(session_id, ts, type, COALESCE(selector,''), COALESCE(text_hash,''));
```

- `text_hash = sha256(selector | type | detail 前 200 字符)`；
- 入库使用 `INSERT OR IGNORE`；以 `run().changes === 0` 判断命中去重（并发下比 `RETURNING` 更可靠），
  被去重的行为计入响应 `ignored`；真实新插入行的 `behavior_id` 取自 `lastInsertRowid`，事务提交后写 FTS。

### 6.4 会话生命周期

- 每个批次结束后重算受影响会话的 `event_count`（behaviors 行数）与 `page_count`（pages 去重 URL 数）；
- 定期维护任务：关闭 `closed=0 AND last_activity < now - IDLE_TIMEOUT_MS` 的会话；删除已关闭且
  `page_count=0 AND event_count=0` 的空会话；执行 `wal_checkpoint(TRUNCATE)`；
- 站点计数：首次记录事件时间，冲突时 `last_seen = MAX(旧值, 新事件时间)`，`event_count` 累加。

### 6.5 数据库存放位置建议

SQLite WAL 模式依赖本地 POSIX 文件系统的 `-wal` / `-shm` 辅助文件可见性。**请将 `DB_PATH` 指向
本地磁盘目录**（如 `~/.local/share/browser-behavior/behavior.db` 或 `/var/lib/…`）；在部分网络挂载 /
FUSE 文件系统上，重开连接后 WAL 内已提交内容可能不可见。默认 `daemon/data/behavior.db` 仅用于
开发与本机自检。

---

## 7. 注册 Native Messaging Host（一键脚本）

脚本路径：项目根目录 `scripts/install-native-host.sh`（模块 B 提供，可执行）。

### 7.1 用法

```bash
# 1) 扩展已构建（manifest.json 含 key 字段）：自动计算 Chrome 扩展 ID 并注册
bash scripts/install-native-host.sh

# 2) 扩展尚未构建：手动指定已加载扩展的 32 位 ID
bash scripts/install-native-host.sh --extension-id abcdefghijklmnopabcdefghijklmnop

# 3) 指定扩展 manifest.json 路径
bash scripts/install-native-host.sh --manifest /path/to/manifest.json

# 4) 同时注册并启用 systemd 用户单元
bash scripts/install-native-host.sh --install-systemd

# 查看帮助
bash scripts/install-native-host.sh --help
```

### 7.2 扩展 ID 计算规则（Chrome 官方算法）

`manifest.key`（Base64 编码的 DER 公钥）→ SHA-256 → 取前 32 个十六进制字符 → 每位数值 `0–15`
映射为字母 `a–p`，得到 32 位扩展 ID。

### 7.3 写入清单

脚本向以下四个浏览器变体的 `NativeMessagingHosts` 目录写入
`com.browser.behavior.collector.json`（`type=stdio`，`path` 指向 `daemon/bin/host.js` 绝对路径，
`allowed_origins` 限定本扩展）：

- `~/.config/google-chrome/NativeMessagingHosts/`
- `~/.config/chromium/NativeMessagingHosts/`
- `~/.config/google-chrome-beta/NativeMessagingHosts/`
- `~/.config/google-chrome-unstable/NativeMessagingHosts/`

清单内容示例：

```json
{
  "name": "com.browser.behavior.collector",
  "description": "浏览器行为采集本地守护进程 Native Messaging Host（模块B）",
  "path": "/home/.../browser-behavior-agent/daemon/bin/host.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://<扩展ID>/"
  ]
}
```

扩展侧通过 `chrome.runtime.connectNative('com.browser.behavior.collector')` 建立长连接。

---

## 8. systemd 用户单元

单元文件：`daemon/deploy/browser-behavior-daemon.service`（中文注释，`Restart=on-failure`，
`RestartSec=3`，日志接入用户级 journald）。

### 8.1 安装方式

```bash
# 方式一：一键脚本（注册 host 清单的同时安装单元）
bash scripts/install-native-host.sh --install-systemd

# 方式二：手动安装
mkdir -p ~/.config/systemd/user
cp daemon/deploy/browser-behavior-daemon.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now browser-behavior-daemon.service
```

### 8.2 常用命令

```bash
systemctl --user status browser-behavior-daemon.service   # 查看状态
journalctl --user -u browser-behavior-daemon.service -f    # 跟踪日志
systemctl --user restart browser-behavior-daemon.service    # 重启
systemctl --user stop browser-behavior-daemon.service       # 停止
```

> 单元内 `ExecStart` 与 `WorkingDirectory` 使用本机绝对路径（node 可执行文件与项目目录）；
> 更换机器时请按实际 node 路径与项目目录修改（`daemon/deploy/` 下单元文件使用占位符说明）。

### 8.3 待真机验证项（契约 §9.6：已实现 + 待真机验证 + 验证步骤）

| 事项 | 状态 | 真机验证步骤 |
|---|---|---|
| 真实 Chrome 扩展与 host 长连接 | 代码已实现，待真机验证 | 构建扩展 → 加载未打包扩展 → 记录扩展 ID → 执行 `install-native-host.sh --extension-id <ID>` → 重启 Chrome → 扩展连接后执行页面操作，`node bin/cli.js query sites` 应出现真实域名 |
| systemd 用户单元开机自启 | 单元与安装脚本已实现，待真机验证 | 在有 systemd 用户会话的桌面环境执行 `systemctl --user enable --now browser-behavior-daemon.service`，重启系统后 `status` 应为 active，`/health` 可访问 |
| 多 host 进程并发写 | 本机进程级并发已验证（双 host 30 事件零丢失、无 BUSY） | 真机多窗口 / 多配置文件同时上报时复查 `SQLITE_BUSY` 与事件计数一致性 |

---

## 9. 自检记录（契约 §8 · 模块 B）

自检脚本与原始响应存档位于 `daemon/data/selfcheck/`：

- `api-checks.sh`：16 步 HTTP 端点自检脚本（可重复执行，`DAEMON_URL` 可覆盖默认地址）；
- `health.json` `sites.json` `sessions.json` `behaviors.json` `behaviors-click.json` `requests.json`
  `stats-type.json` `stats-page.json` `stats-hour.json` `search.json` `trajectory.json`
  `skills-post.json` `skills.json` `session-close.json`：各端点原始响应；
- `cli-*.json` `cli-*.txt`：CLI 查询 / 导入 / 关闭会话 / 整理 / 帮助存档；
- `host-test.mjs`：Native Messaging 帧协议自检（ping/pong、batch 入库、EOF 退出码）；
- `concurrency-test.mjs`：双 host 进程并发写自检（30 事件零丢失、无 BUSY）；
- `maintenance-test.mjs`：空闲超时关闭、空会话清理、新会话保留自检；
- `schema.txt`：最终数据库 Schema 快照（全局表 + 分表 + 唯一索引 + FTS5）；
- `SELFCHECK-REPORT.md`：本模块完整自检报告（命令、输出摘要、重启持久化对比、待真机验证项）。

复跑方式：

```bash
# 1) 启动 daemon（自检库放在本地 /tmp，避免网络文件系统 WAL 可见性问题）
PORT=8757 DB_PATH=/tmp/behavior-daemon/behavior.db node bin/daemon.js

# 2) 灌入 mock 事件（组织者脚本，--url=端口；或直接 POST /api/events）
node scripts/mock-events.js --url=http://127.0.0.1:8757

# 3) 执行端点自检（自检端口非 8756 时用 DAEMON_URL 覆盖）
DAEMON_URL=http://127.0.0.1:8757 bash daemon/data/selfcheck/api-checks.sh

# 4) host 协议、并发写与维护任务自检
node daemon/data/selfcheck/host-test.mjs
node daemon/data/selfcheck/concurrency-test.mjs
node daemon/data/selfcheck/maintenance-test.mjs

# 5) 停止 daemon 后以同一 DB_PATH 重启，核对 /health、/api/sites、/api/behaviors、
#    /api/search、/api/skills 结果与重启前一致（契约 §8：重启后数据仍在）
```

### 已通过的自检结论（本机 Node v22.23.2 / better-sqlite3 13.0.3）

- `/health` 正常返回站点数与事件总数；`/api/sites` 出现已采集域名并带表名映射；
- `behaviors_<D>` 有行，`/api/behaviors` 总数与类型过滤正确；`/api/search` FTS 命中且带 `<b>关键词</b>` 高亮；
- 重复事件第二次入库 `inserted=0 / ignored=1`；未知事件类型记为 `unknown` 仍入库；
- 双 host 进程并发 30 事件全部落库、零丢失、无 `SQLITE_BUSY`；
- 空闲超时会话自动关闭、空会话清理、新会话保留；`wal_checkpoint(TRUNCATE)` 正常执行；
- 重启 daemon 后站点数、事件总数、行为总数、检索命中、技能索引与重启前一致；
- systemd 单元文件存在且含中文注释；`install-native-host.sh` 支持手动 ID、manifest 自动计算、
  `--install-systemd` 容错安装。

---

## 10. 实现备注

- 敏感字段（Cookie、令牌、完整输入值等）由扩展采集层按契约 §1.4 规则脱敏后再上报，daemon 只落已脱敏数据，不做事后二次脱敏。
- HTTP 请求体上限 1MB，超限由扩展拆包（契约 §1.1）。
- 除 `/health` 外所有查询端点在域名尚未采集到时返回空集合 / `total: 0`，不抛错、不建表。
- 本模块不自行变更契约接口；Schema / 协议缺陷按契约 §10 流程先追加修订记录（v1.1、v1.2 已落实到本实现）。
