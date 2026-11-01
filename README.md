# Browser Behavior Agent

### 让你的 Agent 学会你在浏览器里怎么做事

**采集行为 → 蒸馏技能 → 确定性回放 → 任意 Agent 通过 MCP 复用。全链路本地运行。**

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20Streamable%20HTTP-22b8cf)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-495057)
![Privacy](https://img.shields.io/badge/data-100%25%20local-2f9e44)

> 📄 产品功能介绍页：[`docs/index.html`](docs/index.html)（自包含单文件，可直接用 GitHub Pages 托管 `docs/` 目录）

---

### 它解决什么问题

现有的浏览器自动化只有两条老路：**人写脚本**——选择器一改就全线失效，还不会告诉你哪一步断了；**模型现场操作**——每次路径都不一样，没法回归验证。而这个项目走第三条路：把人的真实操作变成**可执行、可验证、可复用**的结构化资产。

| 你在做的事 | 系统产出什么 |
|---|---|
| 正常浏览网页 | 点击 / 输入 / 滚动 / 导航 / 网络请求，精确到 **CSS 选择器 + 元素文本 + URL + 时间戳** |
| 同一件事重复做几遍 | 从多条轨迹中**蒸馏出动作链**，自动生成前置/后置断言，输出技能 JSON |
| 让技能跑起来 | **确定性回放**：dry_run 预检 / CDP / Playwright 三种模式，逐步断言，失效点位精确报错 |
| 让 Agent 自己用 | 10 个中文 **MCP 工具**，stdio 与 Streamable HTTP 双传输，DSH / OpenCode / Claude / Cursor 通用 |

### 核心能力

| 能力 | 说明 | 模块 |
|---|---|---|
| 全天候静默采集 | 11 类事件，点击精确到元素文本与选择器路径，输入记录值而非"输入了" | `extension/` |
| 按域名自动分表 | 新域名首次出现即建表，WAL + FTS5 全文索引，精确重复事件自动去重 | `daemon/` |
| 结构化检索 | 按站点 / 会话 / 类型 / 时间窗 / URL 片段组合查询，全文命中返回高亮片段 | `daemon/` |
| 技能蒸馏 | 前缀树在多条轨迹中挖重复动作链，生成 `text_present` / `element_present` / `url_contains` 断言 | `replay/distill/` |
| 确定性回放 | 三步一断言，失败即中止并报出具体步骤，绝不静默乱点 | `replay/runner/` |
| Agent 一插即用 | 查询 / 统计 / 全文检索 / 轨迹导出 / 蒸馏 / 回放，10 个工具全覆盖 | `mcp/` |

### 和常见方案的区别

|  | 录屏工具 | 手写 RPA 脚本 | 本项目 |
|---|---|---|---|
| 记录形式 | 像素视频，机器读不懂 | 写死的选择器 | 选择器 + 文本 + URL 结构化入库 |
| 页面改版后 | — | 静默失败 | 逐步断言，精确定位失效步骤 |
| 能否被 Agent 调用 | 不能 | 需二次封装 | 原生 MCP 协议 |
| 数据存放 | 常在第三方云端 | 本地 | 只落本机 SQLite，无外网端口 |

### 先验证链路是否通畅

```bash
# 装好各模块依赖后，一条命令验证整条链路（模拟事件→入库→查询→MCP→蒸馏→回放）
bash scripts/verify-chain.sh
# 期望输出：PASS=12 FAIL=0
```

不需要浏览器、不需要扩展，先用模拟事件确认流水线通畅，再去接真机采集（见 §三）。

### 架构一览

```
┌─────────────────────┐   Native Messaging    ┌──────────────────┐
│  Chrome MV3 扩展      │ ───────────────────▶ │  本地守护进程 daemon │
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

> **运行平台**：Linux（systemd 用户单元自启）与 Windows（任务计划程序 / NSSM）双平台开箱即用。业务代码（扩展/daemon/mcp/replay）完全同一份 Node/TS，不做平台分支；运维层按平台分别提供 `scripts/install-native-host.sh`（Linux）与 `scripts/install-native-host.ps1`（Windows）。


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
├── scripts/             # mock 事件生成器、端到端验证脚本、一键部署 setup.sh、Native Host 注册（.sh=Linux / .ps1=Windows）
├── docs/
│   ├── index.html       # 产品功能介绍页（自包含单文件，可用 GitHub Pages 托管 docs/）
│   └── CONTRACTS.md     # 模块间共享契约（事件协议 / DB Schema / API / 工具清单 / 技能格式）
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

单步手动跑链路：

```bash
node daemon/bin/daemon.js                    # 启动守护进程（127.0.0.1:8756）
node scripts/mock-events.js                  # 模拟扩展灌入 73 条事件（2 域名 4 会话）
node daemon/bin/cli.js query sites           # 查库：按域名自动分表结果
node daemon/bin/cli.js query search --q 提交订单 --domain example.com
node mcp/index.js --list                     # MCP 列出 10 个工具
node mcp/test-client.js call list_sites      # MCP 查询真实数据
node replay/distill/index.js --domain example.com --name 下单流程 --min-occurrences 2
node replay/runner/index.js --skill skl_xxx --mode dry_run
```

## 三、真机部署（真实浏览器采集）

### 3.1 一键部署（推荐，单条命令）

先装好扩展并取得其 ID，然后**一条命令**完成「注册 Native Host + 安装并启动 systemd 守护进程」：

```bash
# 一次性取得扩展 ID：chrome://extensions 开启「开发者模式」→ 复制本扩展的 32 位 ID
bash scripts/setup.sh --extension-id <你的扩展ID>
```

`setup.sh` 自动完成四件事，无需手动分步：

1. **扩展构建检查**：产物缺失时自动 `pnpm build`；
2. **注册 Native Messaging Host**：把扩展 ↔ 守护进程的 stdio 桥写入 Chrome/Chromium 配置目录；
3. **安装并启动 systemd 守护进程**：自动探测 node 路径与项目根，替换单元内 `<PROJECT_ROOT>`/`<NODE_BIN>` 占位符，写入 `~/.config/systemd/user/` 并 `daemon-reload` + `enable --now`，无需手动改单元文件；
4. **打印 MCP 启动命令与链路验证入口**。

完成后守护进程已由 systemd 托管（`systemctl --user status browser-behavior-daemon`），MCP 按脚本打印的命令启动即可。

### 3.2 安装扩展（首次，一次性）

1. 构建：`cd extension && pnpm build`，产物在 `extension/.output/chrome-mv3/`。
2. 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择上面的产物目录。
3. 从 `chrome://extensions` 复制该扩展的 32 位 ID（`setup.sh --extension-id` 需要用到）。

### 3.3 手动方式（可选，替代 3.1 的分步做法）

```bash
# 1) 注册 Native Messaging Host（自动从 manifest key 计算，或手动指定 ID）
bash scripts/install-native-host.sh --extension-id <你的扩展ID>

# 2) 安装并启动 systemd 守护进程（安装时自动替换占位符，无需手动改单元）
bash scripts/install-native-host.sh --extension-id <ID> --install-systemd

#    状态：systemctl --user status browser-behavior-daemon
#    日志：journalctl --user -u browser-behavior-daemon -f
```

> 说明：`install-native-host.sh --install-systemd` 会自动探测 node 路径并替换单元占位符为实际值，开箱即用。

> 注意：SQLite WAL 模式要求数据库文件位于本地 POSIX 磁盘（如 `~/data/`），**不要放在网络挂载目录**。默认路径为 `daemon/data/behavior.db`，可用环境变量 `DB_PATH` 覆盖。

### 3.4 Windows 部署

业务代码与 Linux 完全同一份（Node 原生跨平台），只需安装依赖、构建扩展、注册 host、配自启。

**前置要求**

- 安装 Node.js 20+（自带 npm 与 npx）；
- `better-sqlite3` 官方提供 Windows prebuilt 二进制，`npm install` 通常**免编译**；若公司内网镜像缺少 prebuild 触发本地编译，需安装 Visual Studio Build Tools（「使用 C++ 的桌面开发」工作负载）与 Python 3；
- 扩展构建与 Linux 相同：`cd extension && pnpm install && pnpm build`。

**安装与注册 Host（PowerShell，免管理员）**

```powershell
# 在项目根目录（browser-behavior-agent\）下
cd extension       ; pnpm install ; pnpm build ; cd ..
cd daemon          ; npm install ; cd ..
cd mcp             ; npm install ; cd ..
cd replay\distill  ; npm install ; cd ..
cd replay\runner   ; npm install ; cd ..

# 扩展已加载后从 chrome://extensions 复制扩展 ID（manifest 含 key 时可省略 -ExtensionId）
powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1 -ExtensionId <你的扩展ID>
#   脚本行为：写 %LOCALAPPDATA%\BrowserBehaviorAgent\native-host\com.browser.behavior.collector.json
#   并注册 HKCU 注册表（Chrome + Edge，默认值 = 清单 JSON 绝对路径），可重复执行自动覆盖。
#   只注册 Chrome 加 -SkipEdge；查看全部参数加 -Help。
```

数据库建议放本地盘（勿放网盘/同步盘目录），例如：`C:\Users\<用户名>\browser-behavior-data\behavior.db`。

**开机自启（首选：任务计划程序，登录时隐藏窗口启动）**

```powershell
# PowerShell 中执行（当前用户即可，无需管理员）
$proj = "C:\path\to\browser-behavior-agent"          # 改成你的实际项目目录
$db   = "C:\Users\$env:USERNAME\browser-behavior-data\behavior.db"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -Command `"`$env:DB_PATH='$db'; `$env:PORT='8756'; Set-Location '$proj\daemon'; node bin\daemon.js`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName "BrowserBehaviorDaemon" -Action $action -Trigger $trigger `
  -Description "浏览器行为采集守护进程（模块B）"
Start-ScheduledTask -TaskName "BrowserBehaviorDaemon"
# 卸载：Unregister-ScheduledTask -TaskName "BrowserBehaviorDaemon" -Confirm:$false
```

等价的 schtasks 一行命令：

```bat
schtasks /Create /TN "BrowserBehaviorDaemon" /SC ONLOGON /F /TR "powershell -WindowStyle Hidden -Command \"$env:DB_PATH='C:\Users\%USERNAME%\browser-behavior-data\behavior.db'; $env:PORT='8756'; Set-Location 'C:\path\to\browser-behavior-agent\daemon'; node bin\daemon.js\""
```

**自启备选：NSSM（注册为后台服务，日志更易查）**

```bat
nssm install BrowserBehaviorDaemon C:\Program Files\nodejs\node.exe C:\path\to\browser-behavior-agent\daemon\bin\daemon.js
nssm set BrowserBehaviorDaemon AppDirectory C:\path\to\browser-behavior-agent\daemon
nssm set BrowserBehaviorDaemon AppEnvironmentExtra DB_PATH=C:\Users\<用户名>\browser-behavior-data\behavior.db PORT=8756
nssm start BrowserBehaviorDaemon
nssm status BrowserBehaviorDaemon
nssm stop  BrowserBehaviorDaemon
```

**MCP 接入（Windows）**：与 Linux 完全一致，路径写反斜杠即可：

```powershell
node mcp\index.js --list
node mcp\index.js --http --port 8765
```

各 Agent 的 MCP 配置中 `command` 写 `node`，参数为绝对路径（JSON 内反斜杠需转义 `\\`）：`"C:\\path\\to\\browser-behavior-agent\\mcp\\index.js"`。

**Windows Native Host 注册要点（真机验证结论）**

- Chrome 的 Native Messaging 清单**只认 `path` 一个字段，`args` 会被静默忽略**——因此不能把 `node.exe` 写进 `path`、把 `host.js` 写进 `args`。
- Chrome 拉起 host 时还会在命令行追加扩展 origin（`chrome-extension://<扩展ID>/`）和 `--parent-window=<hwnd>`。若 `path` 直接指向 `node.exe`，node 会因 `bad option: --parent-window=…` 立即退出，扩展侧只看到 `Native host has exited`。
- 正确做法：由安装脚本生成启动器 `%LOCALAPPDATA%\BrowserBehaviorAgent\native-host\run-host.cmd`（内容为 `"<node.exe 绝对路径>" "<host.js 绝对路径>" %*`），并把清单的 `path` 指向该启动器。
- 校验：`reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser.behavior.collector` 的默认值应指向清单 JSON；清单内 `path` 应指向 `run-host.cmd`，`allowed_origins` 与实际扩展 ID 一致。
- 注意：`install-native-host.ps1` 必须保存为 **UTF-8 带 BOM**，否则 Windows PowerShell 5.1 会按 ANSI 解码，中文注释变乱码并直接报语法错误。
- 未打包加载的扩展 ID 由产物目录绝对路径派生（`extension\.output\chrome-mv3`），跨配置目录稳定；可用 `node scripts/load-extension-cdp.mjs 9222` 直接读出，或在 `chrome://extensions` 复制。

**Windows 辅助脚本**

| 脚本 | 用途 |
|---|---|
| `scripts/load-extension-cdp.mjs` | 向已开调试端口的 Chrome 装载未打包扩展，打印真实扩展 ID（Chrome 137+ 命令行 `--load-extension` 已失效） |
| `scripts/verify-live-collect.mjs` | 真机采集链路验证：扩展 → Native Host → daemon 入库 → API 可查 |
| `scripts/click-report.mjs` | 跨全库聚合点击行为，输出按域名分布 + 时间线 |
| `scripts/toggle-mousemove.mjs` | 热开关 mousemove 采样（默认开启，噪声大时可关闭，点击/输入/滚动不受影响） |

**Windows 其它待真机验证**（本沙箱为 Linux，无法实机执行）：

- Edge 变体 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\…` 同样注册；
- 任务计划程序登录后自动拉起 daemon（`/health` 可访问）；NSSM 安装/启停正常。

## 四、接入任意 Agent（MCP）

MCP Server 是通用协议，**DSH（豆包）/ OpenCode / Claude Desktop / Cursor** 均可接入。两种传输任选：

### 方式 A：stdio（推荐本地单机）

在各 Agent 的 MCP 配置中添加（以 OpenCode 为例，其余见 `mcp/README.md`）：

```json
{
  "browser-behavior": {
    "type": "local",
    "command": ["node", "/绝对路径/browser-behavior-agent/mcp/index.js"],
    "enabled": true
  }
}
```

### 方式 B：Streamable HTTP（远程/多客户端）

```bash
node mcp/index.js --http --port 8765     # 端点 http://127.0.0.1:8765/mcp
```

### 工具清单（10 个，描述均为中文）

| 工具 | 作用 |
|---|---|
| `list_sites` | 列出已采集网站及事件量 |
| `query_behaviors` | 按站点/会话/类型/时间/URL 查行为（点击/输入/滚动…） |
| `query_sessions` | 查询浏览会话 |
| `query_requests` | 查询网络请求（已脱敏） |
| `behavior_stats` | 行为链路统计（按类型/页面/小时聚合） |
| `fulltext_search` | 全文检索行为记录 |
| `export_trajectory` | 导出行为轨迹（json / markdown 时间线） |
| `distill_skill` | 从重复轨迹蒸馏可复用技能 |
| `list_skills` | 列出已蒸馏技能 |
| `trigger_replay` | 按技能执行确定性回放（dry_run / cdp / playwright） |

**典型 AI 工作流**：让 Agent「查一下我在 example.com 上反复做的操作」→ `query_behaviors` / `behavior_stats` → 「把重复操作提炼成技能」→ `distill_skill` → 「用这个技能再跑一遍并验证结果」→ `trigger_replay --mode playwright`。

## 五、已验证结果（本环境实测）

| 环节 | 结果 |
|---|---|
| 扩展构建 | `pnpm build` 零报错，MV3 manifest 权限/脚本齐全（WXT 0.21.5） |
| 采集→入库 | mock 73 条事件（2 域名 4 会话 11 种行为类型）→ 按域名自动分表、会话/页面/行为/请求 4 表落库，重启持久化一致 |
| 去重/全文检索 | 精确重复事件 `inserted=0, ignored=1`；FTS5 命中「提交订单」带高亮 |
| MCP stdio | 10 工具齐全，`list_sites` / `query_behaviors` 返回真实数据 |
| MCP HTTP | initialize 握手、tools/list、tools/call、DELETE 会话全通过 |
| 技能蒸馏 | 3/3 会话挖掘出 8 步下单链（匹配率 100%），自动生成 text_present/element_present/url_contains 断言 |
| 回放 dry_run | 蒸馏技能 8/8 步 PASS（含逐断言预检），退出码 0 |
| 回放真机（CDP/Playwright） | 连本机 Chrome 9222 调试端口，8 类动作+4 类断言 **8/8 PASS**（CDP 3.98s / Playwright 4.69s） |
| Native Host 帧协议 | 4 字节小端长度帧 ping→pong、batch→入库正确；双 host 并发 30 事件零丢失 |

验证脚本：`bash scripts/verify-chain.sh`（PASS=12 FAIL=0）；各模块自检记录见各目录 `SELFCHECK*` 文档。

## 六、待真机验证清单（代码已实现，需在你的真实环境跑）

| 项 | 说明 |
|---|---|
| 扩展真实加载与 Native 握手 | 本沙箱无 GUI，需按 §3.1/3.2 在真机 Chrome 加载扩展、注册 host 后观察事件入库 |
| webRequest 真机脱敏 | 真实站点请求头/参数剥离效果需真机抽查 |
| systemd 开机自启 | unit 已提供，需真机 `systemctl --user` 验证 |
| 回放真实业务站点 | mock 站点为虚构域名；对真实站点回放需站点可达且选择器仍有效（失效会记 FAIL 明细，不会静默乱点） |
| 长链路（≥10 步）与多标签页回放 | 已实现，待多页场景验证 |

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
| 蒸馏报「无法打开数据库」 | 设置 `DB_PATH` 指向实际库路径（如 `DB_PATH=/tmp/xxx/behavior.db node replay/distill/index.js ...`） |
| 数据在重启后消失 | 确认数据库文件在本地磁盘而非网络挂载目录（见 §3.3 注意） |

## 九、相关开源项目与参考

本项目的架构设计与算法实现参考了以下公开开源项目（仅作功能参考，无代码依赖）：

| 项目 | 与本项目的关系 | 参考点 |
|---|---|---|
| [peek / rrweb-stack](https://github.com/peek/rrweb-stack) | 采集与存储参考 | 浏览器行为录制、按站点数据模型、MCP Server 暴露行为数据 |
| [Browser-BC](https://github.com/Einsia/Browser-BC) | 技能蒸馏参考 | 行为克隆 + 技能蒸馏：演示轨迹 → 可复用 Skill 的三层链路 |
| [Paragent](https://github.com/DevToolie/Paragent) | 确定性回放参考 | 成功轨迹编译为确定性回放脚本，逐步后置断言、失败修复回写 |
| [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) | 浏览器操作基座参考 | AI 主动操作浏览器的扩展 + daemon + 协议；其"操作↔响应证据链"采集思路可改造为被动记录 |
| [browser-tools-mcp](https://github.com/nicobailon/browser-tools-mcp) | MCP 服务参考 | 浏览器数据经 MCP 对外暴露的通道设计 |
| [mcp-chrome](https://github.com/justjake/mcp-chrome) | 采集参考 | 浏览器行为采集入口与全量事件模型 |

> 说明：上述项目用于功能与算法层面的对照参考；本项目所有代码为独立实现。若需在自身项目中使用上述任一项目，请遵循其各自的许可证。

## 十、许可与说明

- 仅供个人学习与行为研究使用；请遵守目标网站的服务条款与相关法规。
- 敏感信息（密码/令牌/卡号）不会以明文落盘，但**请勿**在登录态页面上采集含个人隐私的内容用于不当用途。
