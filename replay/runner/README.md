# runner（模块E）：确定性回放执行器

> 完整说明见上级目录 [`../README.md`](../README.md)；契约依据为 [`../../docs/CONTRACTS.md`](../../docs/CONTRACTS.md) §5 / §6 / §8。

## 快速命令

```bash
npm install                                   # 安装依赖（chrome-remote-interface、playwright-core，不下载浏览器）
npm run test:dry                             # dry_run 自检（18 项断言 + CLI 退出码）
npm run test:live                            # cdp / playwright 真机端到端自检（需本机 Chrome 开 9222 端口）
npm test                                     # 先 dry_run 后真机全量自检

node index.js --skill-file tests/fixtures/sample-skill.json --mode dry_run
node index.js --skill <skillId> --mode cdp
node index.js --skill <skillId> --mode playwright --headless --continue-on-fail
node index.js --help
```

## 对外导出

```js
import { runSkill, loadSkill } from './index.js';
// runSkill(skill, opts) → { summary, steps, plan, report }
// opts: { mode, headless, targetUrl, continueOnFail, cdpEndpoint }
```

## 目录提示

- `src/backends/`：三种模式的后端适配器，接口约定见 `src/backends/base.js`；
- `tests/fixtures/`：自检样例技能与静态页，**不写入生产 `replay/skills/` 目录**；
- 真机准备步骤、CDP 坐标计算、待验证清单统一见 `../README.md` 第 5、6 节。
