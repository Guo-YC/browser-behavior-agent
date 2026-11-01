# 模块C：浏览器行为采集 MCP Server

本模块是「浏览器行为采集系统」的 MCP（Model Context Protocol）服务端，负责把本地守护进程（daemon）中的行为数据、技能蒸馏与确定性回放能力，以标准 MCP 工具形式暴露给 AI 客户端（DSH/豆包、OpenCode、Claude Desktop、Cursor 等）。

- 传输方式：**stdio**（默认）+ **Streamable HTTP**（`--http`，端点 `/mcp`）
- 实现语言：Node.js ESM，SDK 为 `@modelcontextprotocol/sdk@^1`（稳定版）
- 契约依据：`docs/CONTRACTS.md` §3（daemon HTTP API）、§4（工具清单）、§6（回放）、§7（蒸馏）、§8（验收）

---

## 1. 目录结构

```
mcp/
├── index.js              # 入口：参数解析 + stdio / Streamable HTTP 双传输 + --list
├── test-client.js        # 最小 stdio MCP 自检/演示客户端（SDK Client）
├── package.json
├── src/
│   ├── config.js         # 环境变量与路径解析（DAEMON_URL / REPLAY_DIR / DB_PATH）
│   ├── daemonClient.js   # daemon HTTP API 封装（拼参、超时、中文错误包装）
│   ├── replayBridge.js   # replay 蒸馏/回放模块动态 import() 桥接
│   └── tools.js          # 10 个工具的 schema、中文描述与处理函数注册
└── README.md             # 本文件
```

## 2. 前置条件

1. Node.js ≥ 20（推荐 22）。
2. 先启动本地守护进程（模块B）：

   ```bash
   node daemon/bin/daemon.js
   # 默认监听 http://127.0.0.1:8756
   ```

3. 查询类工具不依赖 replay 模块；`distill_skill` / `trigger_replay` 需要模块D（`replay/distill`）与模块E（`replay/runner`）已部署；未就绪时这两个工具会返回中文错误提示，不会崩溃。

## 3. 快速开始

> 下列命令均在项目根目录 `browser-behavior-agent/` 下执行；下文 `MCP_ABS_PATH` 表示本目录绝对路径（请替换为你实际放置项目的目录，例如 `/path/to/browser-behavior-agent/mcp`）。

### 3.1 安装依赖

```bash
cd mcp
npm install
```

### 3.2 stdio 模式（默认，供本地 MCP 客户端拉起）

```bash
node mcp/index.js
```

启动后等待客户端通过标准输入/输出建立 JSON-RPC 通道；启动提示只写入 stderr，不污染 stdio 通道。

### 3.3 Streamable HTTP 模式（远程接入 / 多客户端共享）

```bash
node mcp/index.js --http --port 8765
# 监听 http://127.0.0.1:8765/mcp
```

- 支持 MCP 规范的 `GET`（独立 SSE 发现流）、`POST`（初始化与工具调用）、`DELETE`（会话关闭）；
- 会话化部署：每个 `initialize` 请求分配独立会话 ID（响应头 `mcp-session-id`），会话空闲 30 分钟自动清理；
- 端口可用 `--port` 参数或 `PORT` 环境变量覆盖；监听地址用 `--host` 参数指定（默认 `127.0.0.1`）。

### 3.4 仅列出全部工具后退出（自检用）

```bash
node mcp/index.js --list
```

### 3.5 查看帮助

```bash
node mcp/index.js --help
```

## 4. 接入各 MCP 客户端（stdio 片段）

> 片段中 `MCP_ABS_PATH` 请替换为本目录绝对路径；`command` 固定为 `node`，`args` 为 `index.js` 绝对路径。环境变量按需填写，缺省值已可工作。

### 4.1 DSH（豆包 / 豆包桌面端）

在 DSH 的 MCP / 插件配置中添加一个本地（stdio）MCP 服务，等价配置：

```json
{
  "mcpServers": {
    "browser-behavior": {
      "command": "node",
      "args": ["MCP_ABS_PATH/index.js"],
      "env": {
        "DAEMON_URL": "http://127.0.0.1:8756",
        "REPLAY_DIR": "MCP_ABS_PATH/../replay"
      }
    }
  }
}
```

### 4.2 OpenCode

在 OpenCode 的 MCP 配置文件（如 `opencode.json` / 项目 `.opencode/mcp.json`）中添加：

```json
{
  "mcp": {
    "browser-behavior": {
      "type": "local",
      "command": ["node", "MCP_ABS_PATH/index.js"],
      "environment": {
        "DAEMON_URL": "http://127.0.0.1:8756",
        "REPLAY_DIR": "MCP_ABS_PATH/../replay"
      }
    }
  }
}
```

### 4.3 Claude Desktop

编辑 `claude_desktop_config.json`（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；Windows：`%APPDATA%\Claude\claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "browser-behavior": {
      "command": "node",
      "args": ["MCP_ABS_PATH/index.js"],
      "env": {
        "DAEMON_URL": "http://127.0.0.1:8756"
      }
    }
  }
}
```

保存后重启 Claude Desktop，在工具列表中确认出现 10 个 `browser-behavior` 工具。

### 4.4 Cursor

打开 Cursor 的 MCP 设置（`Settings → MCP`，或编辑项目 `.cursor/mcp.json` / 用户 `mcp.json`）：

```json
{
  "mcpServers": {
    "browser-behavior": {
      "command": "node",
      "args": ["MCP_ABS_PATH/index.js"],
      "env": {
        "DAEMON_URL": "http://127.0.0.1:8756"
      }
    }
  }
}
```

### 4.5 经 Streamable HTTP 远程接入

先按 3.3 启动 HTTP 服务，再在支持远程 MCP 的客户端中填入服务地址：

```json
{
  "mcpServers": {
    "browser-behavior": {
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

HTTP 会话约定：

- 客户端首次 `POST /mcp` 发送 `initialize`，服务端在响应头返回 `mcp-session-id`；
- 后续 `POST` 必须携带该会话头；`GET /mcp` 用于建立独立 SSE 流；`DELETE /mcp` 关闭会话；
- 服务默认仅监听 `127.0.0.1`；如需局域网共享，用 `--host 0.0.0.0` 启动，并自行在前置层加访问控制。

## 5. 工具清单（契约 §4，共 10 个）

| # | 工具名 | 必填参数 | 可选参数 | 说明 |
|---|---|---|---|---|
| 1 | `list_sites` | — | — | 列出已采集的网站域名、事件量与状态 |
| 2 | `query_behaviors` | `domain` | `sessionId`、`type`、`from`、`to`、`urlContains`、`limit`、`offset` | 按网站查询点击/输入/滚动/导航等行为记录 |
| 3 | `query_sessions` | `domain` | `from`、`to`、`limit` | 查询某网站的浏览会话列表 |
| 4 | `query_requests` | `domain` | `method`、`urlContains`、`status`、`from`、`to`、`limit` | 查询已脱敏的网络请求记录 |
| 5 | `behavior_stats` | `domain` | `from`、`to`、`groupBy`（`type`/`page`/`hour`） | 行为链路聚合统计 |
| 6 | `fulltext_search` | `query` | `domain`、`limit` | FTS5 全文检索（URL/选择器/元素文本/详情） |
| 7 | `export_trajectory` | `domain` | `sessionId`、`from`、`to`、`format`（`json`/`markdown`） | 导出会话/时间段行为轨迹 |
| 8 | `distill_skill` | `domain` | `name`、`sessionIds`、`minOccurrences`、`maxSteps` | 从重复轨迹蒸馏可复用技能 |
| 9 | `list_skills` | — | `domain` | 列出已蒸馏技能索引 |
| 10 | `trigger_replay` | `skillId` | `mode`（`dry_run`/`cdp`/`playwright`）、`headless`、`targetUrl` | 按技能执行确定性回放 |

参数约定：

- `domain`：小写主机名，如 `example.com`；
- `from` / `to`：Unix 毫秒时间戳数字；
- 所有工具返回 JSON 字符串；失败时返回 `{"error": "中文错误信息"}` 并标记 `isError`，不抛出未捕获异常。

## 6. 环境变量

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `DAEMON_URL` | `http://127.0.0.1:8756` | 本地守护进程 HTTP 基址；查询类工具全部走该地址 |
| `REPLAY_DIR` | `mcp/../replay`（项目根 `replay/`） | 蒸馏/回放模块目录；相对路径按 `mcp/` 目录解析 |
| `DB_PATH` | `daemon/data/behavior.db` | 数据库路径（保留项；当前查询均经 daemon HTTP API） |
| `DAEMON_TIMEOUT_MS` | `8000` | 调用 daemon 的超时毫秒数 |
| `PORT` | `8765` | HTTP 模式端口（也可用 `--port` 覆盖） |

## 7. 自检命令（契约 §8 模块C 验收）

> 本模块最近一次自检的命令、输出摘要与错误路径记录见 [SELFCHECK.md](./SELFCHECK.md)。

### 7.1 列出 10 个工具

```bash
node mcp/index.js --list
# 预期：输出 list_sites、query_behaviors、query_sessions、query_requests、behavior_stats、
#       fulltext_search、export_trajectory、distill_skill、list_skills、trigger_replay 共 10 项
```

### 7.2 HTTP 模式启动成功

```bash
node mcp/index.js --http --port 8765
# 预期 stderr 输出：[browser-behavior-mcp] Streamable HTTP 已启动：http://127.0.0.1:8765/mcp
```

### 7.3 自检客户端（stdio）

```bash
# 列出工具
node mcp/test-client.js list

# 调用查询工具（需 daemon 已启动并含有数据）
node mcp/test-client.js call list_sites
node mcp/test-client.js call query_sessions --domain example.com --limit 20
node mcp/test-client.js call query_behaviors --domain example.com --type click
node mcp/test-client.js call fulltext_search --query 购物车 --domain example.com
node mcp/test-client.js call export_trajectory --domain example.com --format markdown
node mcp/test-client.js call list_skills
```

`test-client.js` 参数自动识别类型：纯数字转数字、`true/false` 转布尔、JSON 字符串转对象、其余按字符串。

### 7.4 HTTP 模式快速验证

```bash
# 1) initialize 握手（记录响应头中的 mcp-session-id）
curl -X POST http://127.0.0.1:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"1.0"}}}'

# 2) tools/list（带上一步会话头）
curl -X POST http://127.0.0.1:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'mcp-session-id: <上一步返回的会话ID>' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) 调用工具
curl -X POST http://127.0.0.1:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'mcp-session-id: <会话ID>' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_sites","arguments":{}}}'
```

## 8. 故障排查

| 现象 | 原因与处理 |
|---|---|
| 返回「无法连接本地行为采集守护进程」 | daemon 未启动：执行 `node daemon/bin/daemon.js`；端口不一致时设置 `DAEMON_URL` |
| `distill_skill` 返回「回放/蒸馏模块尚未就绪」 | 模块D `replay/distill/index.js` 不存在或未导出 `distillSkill`；检查 `REPLAY_DIR` 指向 |
| `trigger_replay` 返回「技能未在守护进程技能索引中找到」 | 先用 `list_skills` 核对 `skillId`；该技能可能尚未蒸馏注册 |
| `trigger_replay` 的 `cdp` / `playwright` 失败 | 需要本机 Chrome 与回放模块就绪；先用 `mode=dry_run` 做离线预检 |
| HTTP 客户端收到 400「缺少会话 ID」 | 未先发送 `initialize`；需先握手取得 `mcp-session-id` |
| HTTP 客户端收到 404「会话不存在或已过期」 | 会话已超时或被 `DELETE`；重新 `initialize` 建立新会话 |

## 9. 已实现与待真机验证清单（契约 §9.6）

**已实现并在本环境自检通过：**

- 10 个工具注册、参数 schema 与中文描述；
- stdio 与 Streamable HTTP 双传输；`--list` / `--http` / `--help` 参数模式；
- 查询类工具经 daemon HTTP API 返回真实数据；参数缺失、daemon 断连、非法模式均返回中文错误 JSON；
- HTTP 会话初始化、`tools/list`、`tools/call`、`DELETE` 关闭全流程；SDK 官方 HTTP 客户端兼容性验证通过。

**待真机/完整环境验证：**

- `distill_skill` 对真实采集数据的完整蒸馏链路（依赖模块D 与真实数据库）；
- `trigger_replay` 的 `cdp`（Chrome `--remote-debugging-port=9222`）与 `playwright`（本机 Chrome）真实浏览器回放；
- 各 GUI 客户端（DSH、Claude Desktop、Cursor）在本机重启后的真实拉起与工具渲染。

验证步骤：启动 daemon → 灌入事件数据 → 启动本 MCP 服务 → 在目标客户端中按第 4 节配置接入 → 依次调用 `list_sites`、`query_behaviors`、`distill_skill`、`trigger_replay --mode dry_run`。
