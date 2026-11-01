# 模块C 自检记录（契约 §8 验收标准）

> 自检日期：2026-10-31　环境：Node.js v22.23.2、`@modelcontextprotocol/sdk@1.32.2`（npm 安装的 ^1 稳定版，未使用资料包 2.0 alpha）
> 说明：自检时模块B 真实 daemon 尚未就位，临时用一个实现契约 §3 接口的本地 mock 服务（`127.0.0.1:8756`）提供示例数据用于链路验证；真实 daemon 启动后无需修改本模块代码即可接入。

## 1. 安装依赖

```bash
cd mcp && npm install
```

结果：`added 95 packages in 26s`，仅依赖 `@modelcontextprotocol/sdk@^1`。

## 2. `--list`：列出 10 个工具后退出

命令：

```bash
node mcp/index.js --list
```

输出工具清单（共 10 个，数量校验 `grep -c` = 10）：

| # | 工具名 | 状态 |
|---|---|---|
| 1 | `list_sites` | ✅ 已注册 |
| 2 | `query_behaviors` | ✅ 已注册 |
| 3 | `query_sessions` | ✅ 已注册 |
| 4 | `query_requests` | ✅ 已注册 |
| 5 | `behavior_stats` | ✅ 已注册 |
| 6 | `fulltext_search` | ✅ 已注册 |
| 7 | `export_trajectory` | ✅ 已注册 |
| 8 | `distill_skill` | ✅ 已注册 |
| 9 | `list_skills` | ✅ 已注册 |
| 10 | `trigger_replay` | ✅ 已注册 |

每个工具的中文 description 均含参数含义、取值范围与调用示例（见 `src/tools.js`）。

## 3. Streamable HTTP 模式启动

命令：

```bash
node mcp/index.js --http --port 8765
```

stderr 输出：

```
[browser-behavior-mcp] Streamable HTTP 已启动：http://127.0.0.1:8765/mcp
[browser-behavior-mcp] daemon：http://127.0.0.1:8756；replay：…/browser-behavior-agent/replay
```

端点校验：

- `GET /mcp`（无会话）→ `400`，中文错误「缺少 mcp-session-id 请求头。」
- `POST /mcp`（非 initialize 且无会话）→ `400`
- 未知路径 `/foo` → `404`

## 4. HTTP 会话握手与工具调用（curl 实测）

### 4.1 initialize

```bash
curl -X POST http://127.0.0.1:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-check","version":"1.0"}}}'
```

响应头：`content-type: application/json`、`mcp-session-id: bf8442c6-…`；响应体：

```json
{"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"browser-behavior-mcp","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
```

### 4.2 tools/list（携带会话头）

工具数量：**10**，名称与 §2 表格一致。

### 4.3 tools/call `list_sites`（返回真实 mock 数据）

```json
{
  "count": 2,
  "sites": [
    { "domain": "example.com", "firstSeen": 1793199909676, "lastSeen": 1793455509676, "eventCount": 428, "status": "active", "tableName": "behaviors_example_com" },
    { "domain": "shop.example.org", "firstSeen": 1793027109676, "lastSeen": 1793286309676, "eventCount": 156, "status": "active", "tableName": "behaviors_shop_example_org" }
  ]
}
```

### 4.4 DELETE 关闭会话

`DELETE /mcp`（携带会话头）→ `200`；删除后再以该会话 `GET /mcp` → `404`。

### 4.5 SDK 官方 HTTP 客户端兼容性回归

使用 `StreamableHTTPClientTransport` 连接 `http://127.0.0.1:8765/mcp`：成功建立会话 → `tools/list` 返回 **10** 个工具 → `list_sites` 返回上述两条站点数据，全流程退出码 0。

## 5. stdio 自检客户端（`mcp/test-client.js`）

### 5.1 列出工具

```bash
node mcp/test-client.js list
```

输出：`服务端共注册 10 个工具：`，10 个名称与 §2 一致，退出码 0。

### 5.2 查询类工具调用结果（连接 mock daemon，退出码 0）

| 命令 | 返回摘要 |
|---|---|
| `call list_sites` | `count=2`，2 条站点记录 |
| `call query_sessions --domain example.com --limit 5` | 2 条会话（`s_a1b2c3d4`、`s_e5f6g7h8`），含 startedAt/pageCount/eventCount/userAgent/screen |
| `call query_behaviors --domain example.com --type click` | `total=6`，返回 3 条 click 记录（selector/element/detail 均为解析后对象） |
| `call query_requests --domain example.com --method GET` | `total=1`，`GET https://example.com/api/products`，status 200，durationMs 182 |
| `call query_requests --domain example.com --status 200` | 状态码数字过滤生效，命中 2 条 |
| `call behavior_stats --domain example.com --groupBy type` | `page_load:1 / click:3 / navigation:1 / input:1` |
| `call behavior_stats --domain example.com --groupBy hour` | 按小时聚合生效（key=`15`, count=6） |
| `call fulltext_search --query 加入购物车` | 命中 2 条 click，均带 snippet `…加入购物车…` |
| `call export_trajectory --domain example.com --sessionId s_a1b2c3d4` | JSON 轨迹，5 条事件按 ts 升序 |
| `call export_trajectory --domain example.com --format markdown` | 输出 Markdown 时间线表格（事件总数 5/6，含选择器与文本摘要） |
| `call list_skills` | `count=1`，技能 `skl_0123456789abcdef`（加入购物车，example.com） |

### 5.3 蒸馏与回放桥接（动态 `import()` 真实模块D/模块E）

| 命令 | 结果 |
|---|---|
| `call distill_skill --domain example.com --name 下单流程 --minOccurrences 2` | 蒸馏成功：`skillId=skl_9d0b1ced1cf878cc`，技能文件写入 `replay/skills/`，返回 `{skillId, path}`，退出码 0 |
| `call trigger_replay --skillId skl_0123456789abcdef --mode dry_run` | 经 daemon 索引定位技能 → 读取技能 JSON → 动态导入 runner → 返回 dry_run 逐步 PASS/FAIL/SKIP 中文报告与执行计划 |

## 6. 错误路径校验（均返回中文错误 JSON，`isError=true`，退出码 1，无未捕获异常）

| 场景 | 返回错误信息（摘要） |
|---|---|
| `call query_sessions`（缺必填 `domain`） | `缺少必填参数「网站域名」（domain），请补充后重试。` |
| `DAEMON_URL=http://127.0.0.1:9999 call list_sites` | `无法连接本地行为采集守护进程（daemon，地址：…）。请先在项目根目录执行「node daemon/bin/daemon.js」启动守护进程；…底层原因：网络连接失败。` |
| `call trigger_replay --skillId skl_notexist` | `未在守护进程技能索引中找到技能「skl_notexist」。请先执行 distill_skill 蒸馏技能，或确认 skillId 拼写正确。` |
| `call trigger_replay --mode xxx` | `参数 mode 仅支持 dry_run、cdp、playwright，当前取值：xxx` |
| replay 模块目录缺失/导出缺失 | 返回中文引导：模块路径、REPLAY_DIR 提示、应导出的函数名（`distillSkill` / `runSkill`） |

## 7. 契约符合性核对

- 工具名与入参与契约 §4 表格逐字一致；必填参数加粗项在工具内手工校验，缺失返回中文错误。
- 查询类工具全部经 daemon HTTP API（`fetch`）；`from`/`to` 按毫秒时间戳数字转换后作为 query 参数提交。
- `distill_skill` / `trigger_replay` 通过动态 `import()` 调用 replay 模块；`REPLAY_DIR` 使用 `path.resolve` 解析为绝对路径。
- 所有工具返回 JSON 字符串；网络故障、业务错误、模块缺失均包装为中文错误结果。
- 双传输：stdio（默认 `node mcp/index.js`）、Streamable HTTP（`--http --port 8765`，端点 `/mcp`，处理 GET SSE 发现 / POST 会话消息 / DELETE 会话关闭）；`--list` 仅列出工具后退出。

## 8. 待真机/完整环境验证（契约 §9.6）

- 接模块B 真实 daemon（非 mock）后，重复 §5.2 全部查询命令，核对真实库数据条数与索引命中；
- `trigger_replay` 的 `cdp`（Chrome `--remote-debugging-port=9222`）与 `playwright`（本机 Chrome）模式真实浏览器回放；
- DSH/豆包、Claude Desktop、Cursor、OpenCode 本机重启后真实拉起 stdio 服务并渲染 10 个工具；
- 远程 HTTP 模式在非本机客户端的会话保持与断线重连表现。
