# Browser Behavior Agent — 浏览器行为采集端 + 技能蒸馏/回放 + MCP 服务

> 一个**可直接运行**的完整系统：Chrome 扩展全天候静默采集你的浏览器行为（点击/鼠标/输入/滚动/导航/网络请求，精确到具体按钮和选择器）→ 本地守护进程按域名自动分表入库 → MCP Server 对外提供查询/检索/蒸馏/回放能力，任何 Agent（DSH / OpenCode / Claude / Cursor）都能接入，实现**行为自学习与可复现**。

> **运行平台**：Linux（systemd 用户单元自启）与 Windows（任务计划程序 / NSSM）双平台开箱即用。业务代码（扩展/daemon/mcp/replay）完全同一份 Node/TS，不做平台分支；运维层按平台分别提供 `scripts/install-native-host.sh`（Linux）与 `scripts/install-native-host.ps1`（Windows）。

```
┌─────────────────────┐   Native Messaging    ┌──────────────────┐
│  Chrome MV3 扩展      │ ───────────────────▶ │ 本地守护进程 daemon │
│  (WXT, 采集层+脱敏)    │   长连接/批量/自动重连  │  (Node+SQLite WAL) │
└─────────────────────┘                       │  按域名自动分表      │
        │ 记录点击/输入/滚动/                    │  FTS5 全文检索      │
        │ 导航/请求, 敏感字段硬丢弃               └─────────┬────────┘
                                                     │ HTTP 127.0.0.1:8756
                                            ┌────────▼────────┐
                                            │   MCP Server      │  stdio + Streamable HTTP
                                            │   10 个中文工具     │ ◀── DSH/OpenCode/Claude/Cursor
                                            └────────┬────────┘
                                     ┌───────────────┴───────────────┐
                                     ▼                               ▼
                          技能蒸馏 replay/distill       确定性回放 replay/runner
                          (Browser-BC 思路)             (Paragent 思路: dry_run/cdp/playwright)
```

## 一、目录结构

```
browser-behavior-agent/
├── extension/           # ① Chrome MV3 采集扩展（WXT + TS）：事件采集、敏感字段硬丢弃、Native Messaging 桥
├── daemon/              # ② 本地守护进程：按域名自动分表入库（sessions/pages/behaviors/requests）、FTS5、HTTP API、CLI、systemd
├── mcp/                 # ③ MCP Server：stdio + Streamable HTTP 双传输，10 个中文工具
├── replay/
│   ├── distill/         # ④ 技能蒸馏：从重复行为轨迹中挖掘可复用动作链（示范学习）
│   ├── runner/          # ⑤ 确定性回放：dry_run 预检 / CDP / Playwright 三种模式，逐步骤后置断言
│   └── skills/          # 技能 JSON 产物目录
├── scripts/             # mock 事件生成器、端到端验证脚本、Native Host 一键注册（.sh=Linux / .ps1=Windows）
├── docs/CONTRACTS.md    # 模块间共享契约（事件协议 / DB Schema / API / 工具清单 / 技能格式）
└── package.json         # 根便捷命令
```

## 二、快速开始（本机最小链路，约 3 分钟）

```bash
cd browser-behavior-agent

# 1) 安装各模块依赖（扩展用 pnpm，其余用 npm）
cd extension && pnpm install && cd ..
cd daemon   && npm install && cd ..
cd mcp      && npm install && cd ..
cd replay/distill && npm install && cd ../..
cd replay/runner  && npm install && cd ../..

# 2) 一键端到端验证（模拟扩展事件 → 入库 → MCP 查询 → 蒸馏 → 回放 dry-run）
bash scripts/verify-chain.sh
# 预期输出：PASS=12 FAIL=0
```

## 三、真机部署（真实浏览器采集）

### 3.1 安装扩展

```bash
cd extension && pnpm build
# 产物：extension/.output/chrome-mv3/
# 打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择该目录
```

### 3.2 注册 Native Messaging Host（扩展 ↔ 守护进程桥梁）

```bash
# 自动模式：从扩展构建产物的 key 计算扩展 ID
bash scripts/install-native-host.sh

# 手动模式：直接指定扩展 ID
bash scripts/install-native-host.sh --extension-id <扩展ID>

# 可选：一并注册 systemd 用户自启
bash scripts/install-native-host.sh --install-systemd
```

### 3.3 守护进程开机自启（systemd）

```bash
systemctl --user enable --now browser-behavior-daemon.service
# 日志：journalctl --user -u browser-behavior-daemon -f
# 说明：unit 内 ExecStart 的 node 路径与项目目录需按本机实际路径修改（daemon/deploy/ 下有中文注释）
```

### 3.4 Windows 部署

```powershell
# 注册 Native Messaging Host（Chrome + Edge，免管理员，写 HKCU 注册表）
powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1

# 以“任务计划程序”自启守护进程（PowerShell）
$action = New-ScheduledTaskAction -Execute "node" -Argument "<项目绝对路径>\daemon\bin\daemon.js"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "BrowserBehaviorDaemon" -Action $action -Trigger $trigger
# 卸载：Unregister-ScheduledTask -TaskName "BrowserBehaviorDaemon" -Confirm:$false

# 或使用 NSSM 安装为 Windows 服务：
# nssm install BrowserBehaviorDaemon node <项目绝对路径>\daemon\bin\daemon.js
```

## 四、接入任意 Agent（MCP）

### 方式 A：stdio（推荐本地单机）

```bash
node mcp/index.js
```

在 DSH / OpenCode / Claude / Cursor 的 MCP 配置中指向该命令，即可把 10 个中文工具暴露给 AI。

### 方式 B：Streamable HTTP（远程/多客户端）

```bash
node mcp/index.js --http --port 8765   # 端点 http://127.0.0.1:8765/mcp
```

### 工具清单（10 个，描述均为中文）

`list_sites` / `query_behaviors` / `query_sessions` / `query_requests` / `behavior_stats` / `fulltext_search` / `export_trajectory` / `distill_skill` / `list_skills` / `trigger_replay`

## 五、已验证结果（本环境实测）

- 端到端最小链路 **12/12 通过**（mock 事件 → 入库 → FTS → MCP 双传输 → 蒸馏 → 回放 dry-run）；
- 真机回放：CDP 与 Playwright 各 **8/8 步真实点击/输入/滚动 PASS**；
- 扩展 `pnpm build` 零报错；MCP 10 工具 stdio+HTTP 双传输全通；
- 蒸馏：3 条重复会话 100% 匹配，生成 8 步「下单流程」技能。

## 六、待真机验证清单（代码已实现，需在你的真实环境跑）

| 项 | 说明 |
|---|---|
| 扩展真机加载 | chrome://extensions 加载 `.output/chrome-mv3`，确认事件入库 |
| systemd / 任务计划自启 | 重启后守护进程自动拉起 |
| 真实业务站点蒸馏 | 用真实采集数据蒸馏并回放 |
| DSH / OpenCode 真实接入 | 在客户端配置 MCP 后调用各工具 |

## 七、隐私与安全设计

- **采集层硬丢弃**：密码框、token/密钥/卡号类字段的值一律 `****`（正则规则可在扩展 options 页配置）；Authorization/Cookie 等请求头整头剥离；剪贴板只记长度不记内容。
- **纯本地**：扩展 → 本地守护进程（Native Messaging，无外网端口）；HTTP API 只监听 `127.0.0.1`；数据库留在本机。
- **可随时停**：扩展 options 页有采集总开关，关闭后立即停止采集。

## 八、常见问题

| 问题 | 处理 |
|---|---|
| 扩展连不上 host | 先跑 `scripts/install-native-host.sh`；确认扩展 ID 与 allowed_origins 一致；chrome://extensions 重新加载扩展 |
| daemon 启动报端口占用 | 检查 8756 是否被占用，或用 `PORT=8757 node daemon/bin/daemon.js` |
| MCP 工具报「daemon 连接失败」 | 先启动 daemon，再试；错误信息含排障引导 |
| 蒸馏报「无法打开数据库」 | 设置 `DB_PATH` 指向实际库路径 |
| 数据在重启后消失 | 确认数据库文件在本地磁盘而非网络挂载目录（见 §3.3 注意） |

## 九、相关开源项目与参考

本项目的架构设计与算法实现参考了以下公开开源项目（仅作功能参考，无代码依赖）：

| 项目 | 与本项目的关系 | 参考点 |
|---|---|---|
| [peek / rrweb-stack](https://github.com/peek/rrweb-stack) | 采集与存储参考 | 浏览器行为录制、按站点数据模型、MCP Server 暴露行为数据 |
| [Browser-BC](https://github.com/Einsia/Browser-BC) | 技能蒸馏参考 | 行为克隆 + 技能蒸馏：演示轨迹 → 可复用 Skill 的三层链路 |
| [Paragent](https://github.com/DevToolie/Paragent) | 确定性回放参考 | 成功轨迹编译为确定性回放脚本，逐步后置断言、失败修复回写 |
| [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) | 浏览器操作基座参考 | AI 主动操作浏览器的扩展 + daemon + 协议；其“操作↔响应证据链”采集思路可改造为被动记录 |
| [browser-tools-mcp](https://github.com/nicobailon/browser-tools-mcp) | MCP 服务参考 | 浏览器数据经 MCP 对外暴露的通道设计 |
| [mcp-chrome](https://github.com/justjake/mcp-chrome) | 采集参考 | 浏览器行为采集入口与全量事件模型 |

> 说明：上述项目用于功能与算法层面的对照参考；本项目所有代码为独立实现。若需在自身项目中使用上述任一项目，请遵循其各自的许可证。

## 十、许可与说明

- 仅供个人学习与行为研究使用；请遵守目标网站的服务条款与相关法规。
- 敏感信息（密码/令牌/卡号）不会以明文落盘，但**请勿**在登录态页面上采集含个人隐私的内容用于不当用途。
