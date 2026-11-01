# 模块E · 确定性回放引擎（replay/runner）

> 浏览器行为采集系统 · 把模块D 蒸馏出的技能 JSON，以 `dry_run / cdp / playwright` 三种模式逐动作回放，并对每步做后置断言。
> 思路参考 Paragent（录制→编译为确定性可回放脚本，断言失败才调模型修复），实现依据：`docs/CONTRACTS.md` §5（技能格式）、§6（回放器）、§8（验收标准）。

## 1. 目录结构

```
replay/runner/
├── index.js               # CLI 入口 + ESM 导出 runSkill / loadSkill
├── package.json           # 本模块独立依赖（chrome-remote-interface、playwright-core，不下载浏览器）
├── README.md
└── src/
    ├── contract.js        # 动作类型白名单、断言类型、数据校验工具
    ├── loader.js          # 读取并校验技能 JSON（按路径 / 目录 / 文件）
    ├── schema.js          # 技能 JSON 结构校验（契约 §5）
    ├── assertions.js      # 断言求值（url_contains / text_present / element_present / url_change）
    ├── executor.js        # 动作执行器（navigate/click/dblclick/input/scroll/hover/wait/assert）
    ├── report.js          # 中文回放报告（成功/失败步骤清单、执行计划 JSON）
    └── backends/
        ├── base.js        # 后端抽象基类（connect/close/navigate/click/.../evaluate）
        ├── dry-run.js     # 预检后端：不连浏览器，校验动作合法性 + 断言字段可求值
        ├── cdp.js         # CDP 后端（chrome-remote-interface，连 9222）
        └── playwright.js  # Playwright 后端（playwright-core，接管 9222）
```

## 2. 三种回放模式

| 模式 | 后端 | 说明 |
|---|---|---|
| `dry_run` | `backends/dry-run.js` | **预检**：不连接浏览器，逐动作校验合法性（网址、选择器、输入值、等待时长、断言字段），输出将执行的计划；用于 CI / 蒸馏后快速确认技能可回放 |
| `cdp` | `backends/cdp.js` | 经 `chrome-remote-interface` 连本机 `--remote-debugging-port=9222` 的 Chrome |
| `playwright` | `backends/playwright.js` | 经 `playwright-core` 连接同一 9222 端口（不下载浏览器，复用本机已启动的 Chrome） |

## 3. CLI 用法

```bash
cd replay/runner

# 预检（推荐先跑）
node index.js --skill-file <技能.json> --mode dry_run

# 真机回放（本机 Chrome 需以 --remote-debugging-port=9222 启动）
node index.js --skill-file <技能.json> --mode cdp
node index.js --skill-file <技能.json> --mode playwright

# 失败继续（默认遇失败中止；追加此参数跑完剩余步骤）
node index.js --skill-file <技能.json> --mode cdp --continue-on-fail
```

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--skill-file <路径>` | 技能 JSON 文件路径（必填，或 `--skill-dir`） | — |
| `--skill-dir <目录>` | 从目录加载全部技能 JSON 逐个回放 | — |
| `--mode <dry_run|cdp|playwright>` | 回放模式 | `dry_run` |
| `--target-url <URL>` | 覆盖目标页（对 skill 的 navigate 首步生效） | 用技能内首步 |
| `--continue-on-fail` | 失败时继续后续步骤 | 否（遇失败中止） |
| `--headless` | 浏览器无头模式（仅 playwright） | 有头 |

## 4. 动作与断言（契约 §5、§6）

支持的 `type`：`navigate / click / dblclick / input / scroll / hover / wait / assert`。

支持的断言 `kind`：

- `url_contains`：地址栏 URL 包含 `target` 片段（轮询 `timeoutMs`）；
- `url_change`：地址栏 URL 在轮询期间发生变化；
- `element_present`：`target`（或动作选择器）命中的元素存在且可见；
- `text_present`：`target` 文本出现在 `selector` 命中的元素内（不传 selector 则在 `body` 内查找）。

`optional: true` 的动作失败仅告警不中止；断言失败默认立即中止本次回放。

## 5. 作为模块被 MCP 调用（ESM 导出）

```js
import { loadSkill, runSkill } from './replay/runner/index.js';

const { skill } = await loadSkill({ skillFile: './replay/skills/skl_xxx.json' });
const result = await runSkill(skill, {
  mode: 'dry_run',            // dry_run | cdp | playwright
  targetUrl: 'https://example.com',
  continueOnFail: false,
  headless: false,
});

// result = { summary: {status, passed, failed, skipped, aborted, ...}, steps: [...], plan: [...], report: '中文报告' }
```

## 6. 自检

```bash
# 静态页面夹具服务（真机自测用）
node replay/runner/tests/serve-fixture.js

# dry_run 预检自测：合规样例全 PASS、缺陷样例 FAIL 与退出码、continue-on-fail
node replay/runner/tests/run-dry-test.js

# 真机端到端自测：cdp / playwright 各跑一遍本地静态页技能（需 Chrome 已开 9222）
node replay/runner/tests/run-live-test.js
```

自检通过标准见 `tests/run-dry-test.js`（dry_run 路径）与 `tests/run-live-test.js`（真机路径），对照契约 §8 模块E 验收标准。
