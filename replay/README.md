# replay 层：技能蒸馏（模块D）+ 确定性回放（模块E）

> 契约依据：[`../docs/CONTRACTS.md`](../docs/CONTRACTS.md) §5 技能 JSON 格式、§6 回放执行器、§7 蒸馏算法、§8 验收标准。
> 本目录中 **`distill/` 为模块D**（从采集轨迹蒸馏技能 JSON），**`runner/` 为模块E**（本模块，把技能 JSON 确定性回放为浏览器操作），`skills/` 为生产技能存放目录（模块D 写入、模块E 只读、MCP 只读）。

```
replay/
├── distill/              # 模块D：技能蒸馏（Browser-BC 思路，LCS/前缀树挖掘重复动作链）
├── runner/               # 模块E：确定性回放执行器（Paragent 思路，本目录主体）
│   ├── index.js          #   CLI 入口 + ESM 导出 runSkill / loadSkill
│   ├── package.json      #   依赖：chrome-remote-interface@^0.33、playwright-core（不下载浏览器）
│   ├── src/
│   │   ├── contract.js      # 契约枚举与中文标签（动作/断言/模式/默认时长）
│   │   ├── loader.js        # 技能加载与 §5 顶层结构校验
│   │   ├── schema.js        # dry_run 静态预检规则（选择器/URL/输入值/断言目标）
│   │   ├── assertions.js    # 后置断言轮询评估（四种 kind，超时判定）
│   │   ├── executor.js      # 动作编排、失败策略、汇总结构组装、执行计划生成
│   │   ├── report.js        # 中文报告（控制台文本 + 返回结构共用）
│   │   └── backends/
│   │       ├── base.js        # 后端基类、公共工具、CDP 端点解析
│   │       ├── dry-run.js    # 预检后端（不连浏览器）
│   │       ├── cdp.js        # chrome-remote-interface 后端
│   │       └── playwright.js  # playwright-core 后端（connectOverCDP 优先，launch 兜底）
│   └── tests/
│       ├── fixtures/          # 自检样例（**不写入生产 replay/skills 目录**）
│       │   ├── sample-skill.json    # 合规样例（dry_run 全 PASS）
│       │   ├── broken-skill.json     # 缺陷样例（演练 FAIL/SKIP/退出码）
│       │   ├── local-skill.json      # 真机端到端样例（本地静态页）
│       │   └── local-page.html      # 真机自测静态页面
│       ├── serve-fixture.js   # 自测静态服务（127.0.0.1:18923）
│       ├── run-dry-test.js    # dry_run 自检（18 项断言 + CLI 退出码）
│       └── run-live-test.js   # cdp / playwright 真机端到端自检
└── skills/               # 生产技能 JSON（模块D 产出，模块E 与 MCP 只读）
```

---

## 1. 整体数据流（distill → runner → MCP）

```
采集轨迹（daemon /api/behaviors、/api/trajectory）
        │  模块D distill：清洗 → 动作序列化 → LCS 挖掘重复链 → 评分 → 生成断言
        ▼
replay/skills/<skillId>.json（契约 §5）
        │  模块E runner：加载 → 预检/真机执行 → 后置断言轮询 → 中文报告 + 返回结构
        ▼
MCP trigger_replay：import 模块E 的 runSkill(skill, opts)，把结果以 JSON 返回给调用方
```

- 模块D 负责「从行为轨迹学会做什么」；模块E 负责「按技能原样、确定性地再做一遍」。
- runner **只读** `skills/` 目录；样例与测试技能全部放在 `runner/tests/fixtures/`，避免与模块D 的生产产出冲突。

---

## 2. 三种回放模式（契约 §6）

| 模式 | 行为 | 浏览器来源 | 典型用途 |
|---|---|---|---|
| `dry_run`（默认） | 不连接浏览器，逐动作做静态预检：选择器语法、导航 URL 合法、input 必须有 value、断言 target 非空、timeoutMs 合法；输出**执行计划 JSON** + 中文报告 + 每条断言预检结果 | 无 | 技能入库前自检、CI 预检、离线审查 |
| `cdp` | 通过 `chrome-remote-interface` 连接 `http://127.0.0.1:9222`：`Page.navigate` 导航，`Runtime.evaluate` 定位元素并读取 `getBoundingClientRect` 中心坐标，`Input.dispatchMouseEvent` 真实点击/双击/悬停，`Input.insertText` 注入文本 | 必须先手动启动带调试端口的 Chrome | 对现有 Chrome 会话做确定性回放，复用已登录状态 |
| `playwright` | 使用 `playwright-core`（**不会下载浏览器二进制**）：优先 `chromium.connectOverCDP('http://127.0.0.1:9222')` 接管已有 Chrome；连接失败则 `chromium.launch({ channel: 'chrome' })` 调用**本机已安装**的 Chrome | 已有调试端口 Chrome，或本机 Chrome 安装路径 | 自动化流水线、独立会话回放、可选无头 |

### 2.1 动作覆盖范围

`navigate / click / dblclick / input / scroll / hover / wait / assert` 八类动作全部由执行器分发到对应后端；`assert` 动作本身不操作页面，只运行后置断言（**assert 类型动作没有 selector**，执行器不会为其要求选择器）。

### 2.2 后置断言（契约 §5 四种 kind）

每个动作可携带若干断言；动作执行完成后，在 `timeoutMs`（默认 5000ms）内按 100ms 间隔轮询，任一时刻满足即 `PASS`，超时未满足记 `FAIL`：

| kind | 判定规则 | 定位方式 |
|---|---|---|
| `url_contains` | 当前网址包含 `target` 子串 | 页面级，无需选择器 |
| `url_change` | 当前网址 ≠ 动作执行前记录的基线网址 | 页面级，`target` 可留空 |
| `element_present` | 选择器对应元素存在于 DOM | 断言可选 `selector`，缺省回退动作 `selector` |
| `text_present` | 选择器对应元素文本包含 `target` | 断言可选 `selector`，缺省回退动作 `selector` |

> 兼容扩展说明：契约 §5 断言标准字段为 `kind / target / timeoutMs`；为支持「动作完成后校验页面其他区域」，断言允许附带可选 `selector` 字段，缺省回退到所属动作的选择器。

### 2.3 失败策略（契约 §6）

- `optional: true` 的动作失败 → 步骤状态 `SKIP`，继续后续动作；
- `optional: false` 的动作失败 → 步骤状态 `FAIL`，**中止**回放，剩余动作全部标记 `SKIP` 并给出原因；
- CLI `--continue-on-fail` 解除中止：非可选动作失败后仍跑完剩余步骤，报告如实标注 `FAIL`。

步骤记录结构（`steps[]` 每项）：

```json
{
  "step": 3,
  "action": "click",
  "actionLabel": "单击元素",
  "selector": "html > body > form#search-form > button#submit",
  "value": null,
  "optional": false,
  "status": "PASS | FAIL | SKIP",
  "detail": "动作执行成功，3 条后置断言全部通过",
  "checks": [],
  "assertions": [
    { "kind": "url_change", "kindLabel": "网址相比动作前发生变化", "target": "",
      "timeoutMs": 5000, "status": "PASS", "detail": "动作前「…」→ 当前「…」" }
  ]
}
```

---

## 3. CLI 用法

在 `replay/runner/` 目录下执行：

```bash
# 安装依赖（playwright-core 不触发浏览器下载）
npm install

# 预检模式（默认，不连浏览器）
node index.js --skill-file tests/fixtures/sample-skill.json --mode dry_run

# 按技能 ID 读取生产目录 replay/skills/<skillId>.json
node index.js --skill skl_a1b2c3d4e5f60718 --mode dry_run

# CDP 真机回放
node index.js --skill-file tests/fixtures/local-skill.json --mode cdp

# Playwright 驱动本机 Chrome，无头运行，失败后继续
node index.js --skill skl_xxx --mode playwright --headless --continue-on-fail

# 查看帮助 / 版本
node index.js --help
node index.js --version
```

| 参数 | 说明 |
|---|---|
| `--skill <skillId>` | 技能 ID，自动读取 `replay/skills/<skillId>.json`（与 `--skill-file` 二选一） |
| `--skill-file <路径>` | 直接指定技能 JSON 文件（绝对路径，或相对当前工作目录） |
| `--mode <模式>` | `dry_run`（默认）/ `cdp` / `playwright` |
| `--headless` | 无头模式（仅 playwright 本机 `launch({channel:'chrome'})` 启动时生效；CDP 接管已有窗口不生效） |
| `--target-url <网址>` | 连接后首先导航到的网址 |
| `--continue-on-fail` | 非可选动作失败后继续跑完剩余步骤（默认遇失败即中止） |

**退出码**（契约 §8 验收口径）：

- `0`：回放全部通过；或已开启 `--continue-on-fail` 跑完剩余步骤；
- `1`：存在失败步骤且未开启 `--continue-on-fail`；浏览器连接失败同样返回 `1`；
- `2`：参数错误（未知参数、缺失技能标识、非法模式等）。

---

## 4. ESM 导出（供 MCP 模块调用）

模块E 对外导出 `runSkill` 与 `loadSkill`，MCP `trigger_replay` 工具通过 `import()` 调用（契约 §4）：

```js
import { runSkill, loadSkill } from './runner/index.js';

const { skill } = await loadSkill({ skillId: 'skl_xxx' });
const result = await runSkill(skill, {
  mode: 'cdp',            // dry_run | cdp | playwright
  headless: false,
  targetUrl: undefined,
  continueOnFail: false,
  cdpEndpoint: 'http://127.0.0.1:9222', // 可选，默认 9222
});

// result = { summary, steps, plan, report }
console.log(result.summary.message);   // 中文结论
console.log(result.report);            // 完整中文报告文本
```

- `summary`：技能标识、模式、起止时间、耗时、通过/失败/跳过计数、最终状态、是否中止、连接错误、后端说明、技能级预检结果；
- `steps[]`：逐步骤记录（见 §2.3）；
- `plan[]`：执行计划快照（动作顺序、参数、断言清单），`dry_run` 下作为核心交付物之一；
- `report`：控制台已打印的同一份中文报告文本，MCP 可直接回传给调用方。

### 与 MCP `trigger_replay` 的联动

契约 §4 中 `trigger_replay(skillId, mode?, headless?, targetUrl?)` 的实现路径：

1. MCP 先按 `skillId` 通过 daemon `GET /api/skills` 或直接解析 `REPLAY_DIR/skills/<skillId>.json` 取得技能对象；
2. 动态 `import` 模块E 的 `runner/index.js`，调用 `runSkill(skill, { mode, headless, targetUrl, continueOnFail: false })`；
3. 把 `result.summary` 与 `result.steps` 序列化为 JSON 字符串返回；`result.report` 作为中文人类可读说明附在响应中；
4. `mode` 缺省为 `dry_run`；连接失败时 MCP 返回中文错误「浏览器连接失败」并附 §5 真机准备提示。

---

## 5. 真机回放准备步骤

### 5.1 CDP 模式：启动带调试端口的 Chrome

1. 关闭所有已运行的 Chrome 实例（同用户数据目录无法二次开放调试端口）；
2. 使用独立用户数据目录启动，避免污染日常浏览器：

```bash
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-replay-profile

# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-replay-profile

# Windows（PowerShell）
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\chrome-replay-profile"
```

3. 确认调试端点可访问：`curl http://127.0.0.1:9222/json/version`，能看到 `Browser` 与 `webSocketDebuggerUrl` 即就绪；
4. 在需要登录态的站点先手工登录到该独立目录会话中，再执行 `--mode cdp` 回放。

### 5.2 Playwright 模式连接策略

1. **优先**：检测 `http://127.0.0.1:9222`，`chromium.connectOverCDP` 接管已有 Chrome（同 §5.1 准备）；
2. **兜底**：CDP 不可达时 `chromium.launch({ channel: 'chrome', headless })` 调用本机已安装的 Chrome；`playwright-core` 本身**不含浏览器二进制**，因此本机必须装有 Chrome，否则启动会抛出明确中文错误；
3. 无头运行仅在兜底 `launch` 路径生效：`--headless`。

### 5.3 CDP 坐标计算要点（已知坑 ②）

CDP 的 `Input.dispatchMouseEvent` 需要页面坐标。执行器在页面内通过 `Runtime.evaluate` 执行：

```js
const el = document.querySelector(selector);
const r = el.getBoundingClientRect();
// 中心坐标 = 视口内 left/top + 半宽/高（CDP 鼠标事件使用 CSS 像素视口坐标）
const x = r.left + r.width / 2;
const y = r.top + r.height / 2;
```

`getBoundingClientRect` 返回的是相对视口的坐标，正好对应 CDP 鼠标事件坐标系；元素被遮挡（`visible = width > 0 && height > 0`）时动作判失败并给出中文错误。

### 5.4 其他注意事项（已知坑）

- **playwright-core ≠ playwright**：依赖已固定 `playwright-core`，安装时不会下载 Chromium；浏览器来源见 §5.2。
- **选择器存在性探测（坑 ③）**：技能选择器来自采集端 `@medv/finder` 的 CSS 路径；真机执行前每个选择器都会先做存在性/可见性探测，探测失败即记失败原因，不静默点击坐标 0,0。
- **assert 动作无选择器（坑 ④）**：纯断言动作不要求 `selector`，其断言只能使用页面级断言（`url_contains` / `url_change`）或附带独立 `selector` 的 `text_present` / `element_present`。
- **输入兼容性**：CDP 路径使用 `Input.insertText` 注入文本（浏览器派发真实 `input` 事件），并补派 `input` / `change` 事件兼容 Vue/React 等框架；Playwright 路径使用 `page.fill`。
- **导航超时兜底**：`Page.navigate` / `page.goto` 等待 load / networkidle，15 秒超时后退化到 DOMContentLoaded，避免慢页面挂死。

---

## 6. 自检与验收记录（契约 §8 模块E）

### 6.1 dry_run 自检（已通过，本机 Node v22）

命令：

```bash
cd replay/runner && npm install && npm run test:dry
```

结果（`tests/run-dry-test.js`，18 项断言全部 PASS）：

- 合规样例 `tests/fixtures/sample-skill.json`：5 个动作全部 `PASS`，执行计划 5 条，CLI 退出码 `0`；
- 缺陷样例 `tests/fixtures/broken-skill.json`：默认策略第 1 步 `FAIL` 中止，后续 7 步 `SKIP`，CLI 退出码 `1`；
- 缺陷样例追加 `--continue-on-fail`：8 步全部跑完（失败 7 / 可选跳过 1），CLI 退出码 `0`；
- 报告中文文案、执行计划 JSON 段落、失败步骤清单均校验通过。

### 6.2 真机端到端自检（CDP 接管路径已本机验证，launch 兜底路径见 §6.3）

命令：

```bash
cd replay/runner && npm run test:live
```

实测环境：本机 Chrome `146.0.7680.31`，调试端口 `127.0.0.1:9222`；本地静态服务 `127.0.0.1:18923`；技能 `tests/fixtures/local-skill.json` 覆盖 `navigate → input → click → dblclick → hover(可选) → scroll → wait → assert` 八类动作与四种断言。

| 模式 | 结果 | 明细 |
|---|---|---|
| `cdp` | **8/8 PASS** | 导航、输入、单击（url_change + text_present + url_contains）、双击、悬停、滚动、等待、页脚文本断言全部通过 |
| `playwright` | **8/8 PASS** | `connectOverCDP` 接管同一 Chrome，八类动作与断言全部通过 |

### 6.3 待真机验证清单（已实现，未在本机环境跑全）

> 以下功能代码已完整实现，因环境条件限制未完成真机全量验证；上机后按步骤执行并回填结果。

| # | 待验证项 | 验证步骤 | 状态 |
|---|---|---|---|
| 1 | Playwright CDP 不可用时 `chromium.launch({ channel: 'chrome' })` 兜底启动 | 关闭 9222 端口 Chrome，执行 `node index.js --skill-file tests/fixtures/local-skill.json --mode playwright --headless`，观察报告「后端说明」为「本机启动 Chrome」 | 已实现，待验证；本机 VM 的 Chrome 为定制构建，不在标准 `/opt/google/chrome/chrome` 路径，兜底解析失败时已返回中文错误与准备提示 |
| 2 | Playwright `--headless` 无头启动兜底路径 | 同 #1，追加 `--headless`，确认无可见窗口、动作与断言通过 | 已实现，待验证（与 #1 同一本机环境限制） |
| 3 | CDP 多标签页 / 多 target 场景 | 调试 Chrome 打开多个标签后执行 `--mode cdp`，确认连接默认首页面；必要时在后端按 `targetUrl` 匹配页面 | 已实现（默认首 target），待多页场景验证 |
| 4 | 真实业务站点选择器稳定性 | 用模块D 蒸馏出的生产技能跑 `--mode cdp`，核对动态页面下 `@medv/finder` 路径是否失效；失效记录到 `FAIL` 明细 | 已实现，待业务站点验证 |
| 5 | 键盘修饰键 / Enter 提交 | 当前 `input` 走 `insertText`；如需 Enter 触发提交，在技能中改用 `click` 提交按钮，或后续在 CDP 后端补充 `Input.dispatchKeyEvent` 修饰键动作 | 部分实现，待扩展验证 |
| 6 | SPA 路由（pushState / hashchange）断言 | `url_change` / `url_contains` 基于 `location.href` 轮询，SPA 场景已在本地静态页 `pushState` 案例覆盖；其他框架待业务验证 | 已实现，待业务验证 |
| 7 | 长链路技能（≥10 步）超时与中止行为 | 构造长动作链，分别在默认中止与 `--continue-on-fail` 下核对退出码与 SKIP 标记 | 已实现，待长链验证 |

### 6.4 已知边界

- 选择器仅支持 `document.querySelector` 可解析的 CSS 选择器；`:text()`、`role=` 等 Playwright 扩展语法在 cdp 模式不可用；
- `scroll` 动作带选择器时执行 `scrollIntoView({ block: 'center' })`；不带选择器时按 `value`（数字像素，`up` 向上，其余向下 600px）滚动当前窗口；
- 真机断言轮询期间页面发生导航导致上下文销毁时，动作错误会被捕获并计入 `FAIL`，不抛出未捕获异常。

---

## 7. 与模块D、模块C 的接口边界

- **只读契约**：runner 只读取 `replay/skills/<skillId>.json`，不写技能文件、不操作 daemon 数据库；
- **错误文案**：所有对外报错、报告、CLI 帮助均为中文（契约 §9.1）；代码标识符使用英文；
- **依赖版本**：`chrome-remote-interface@^0.33`、`playwright-core`（不下载浏览器，契约 §9.5）；
- 如发现契约缺陷需变更接口，先修订 `docs/CONTRACTS.md` 并通知组织者，不在本模块内静默改协议（契约 §9.4）。
