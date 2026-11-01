# 模块D · 技能蒸馏（replay/distill）

> 浏览器行为采集系统 · 从同一站点的多条重复行为轨迹中，蒸馏出可复用、可回放的技能 JSON。
> 算法思路参考 Browser-BC（行为克隆 + 技能蒸馏），实现依据：`docs/CONTRACTS.md` §5（技能格式）、§7（蒸馏算法）、§2（数据库 Schema）、§8（验收标准）。

## 1. 目录结构

```
replay/distill/
├── index.js              # CLI 入口 + ESM 导出 distillSkill(opts)，供模块C MCP 直接 import 调用
├── seed-mock-db.js       # 自检造数脚本：按契约 §2 构造 2~3 条相似会话轨迹的 mock 数据库
├── selfcheck.js          # 模块D 自检脚本：造临时库 → 蒸馏 → 逐条对照契约 §5 / §8 校验并打印清单
├── package.json          # 本模块独立依赖（better-sqlite3@^13）
└── src/
    ├── paths.js          # 路径解析、域名→表名清洗、默认配置（DB 路径、daemon 地址、URL 正则）
    ├── db.js             # daemon 数据库只读直连、按会话分组读取轨迹
    ├── clean.js          # 轨迹清洗、噪声丢弃、滚动合并、动作序列化与匹配键生成
    ├── mine.js           # 前缀树挖掘重复动作链、评分排序、嵌套子链剔除
    ├── assert.js         # 断言自动生成（text_present / element_present / url_contains / url_change）
    ├── skill.js          # 技能对象组装、skillId 生成、JSON 落盘、daemon 索引注册、结构校验
    └── report.js         # 控制台中文蒸馏报告
```

## 2. 蒸馏算法（契约 §7 全流程）

1. **轨迹读取**：以只读模式直连 daemon 的 SQLite（WAL 库），按 `domain` 选中 `behaviors_<清洗后域名>` 表，按 `session_id` 分组、`ts` 升序取出全部事件；可通过 `--session-ids` 限定会话。
2. **轨迹清洗**：
   - 直接丢弃 `mousemove / mouseenter / heartbeat / focus / blur / tabswitch / request / session_start / session_end / page_hide / page_load / keydown`；
   - 同方向连续 `scroll` 合并为一条 `scroll`；方向变化才保留新的一条；
   - 连续跳转到同一 URL 去重；轨迹开头补一条 `navigate` 记录起始页。
3. **动作序列化**：每条动作生成匹配键 `type|selector|value`：
   - `navigate` → `navigate|html|url`；
   - `click / dblclick` → `type|selector|元素文本`；
   - `input` → `input|selector|值`，脱敏值 `****` 不参与区分（契约 §1.4）；
   - `scroll` → `scroll|body|方向`。
4. **重复链挖掘**：前缀树（Trie）收集每条轨迹所有长度 ≤ `maxSteps` 的连续子串，树节点记录经过它的会话集合；会话数 ≥ `minOccurrences`、路径长度 ≥ 3 的路径即为候选重复链。长轨迹先截断（默认单会话 200 步），控制复杂度。
5. **评分与筛选**：`评分 = 出现次数 × 链长 × 动作多样性（不同匹配键个数）`；按评分降序，剔除已被入选长链包含的嵌套子链，取前 `topN` 条生成技能。
6. **断言生成**：
   - `click / dblclick` 元素文本非空 → `text_present`；
   - `input` → `element_present`（断言输入框在场）；
   - `navigate` → `url_contains`（断言停留在该站点域名下）；
   - 链尾用户动作后 2s 内出现 `navigation / page_load` 且 URL 变化：同源路径变化 → `url_contains`，跨域或整站跳转 → `url_change`。
   - 链尾跳转导航本身不进入动作链，其结果以上述断言形式挂到最后一个用户动作上。
7. **输出与注册**：技能 JSON 写入 `replay/skills/<skillId>.json`，随后尽力调用 daemon `POST /api/skills` 注册索引；daemon 未启动时仅打印中文警告，不阻塞落盘。

## 3. CLI 用法

```bash
# 进入模块目录（依赖已本地安装在 replay/distill/node_modules）
cd replay/distill

# 基础蒸馏（默认：min-occurrences=2、max-steps=20、top-n=5）
node index.js --domain example.com

# 指定技能名、限定会话、调整阈值
node index.js --domain example.com \
  --name "下单流程" \
  --session-ids s_001,s_002,s_003 \
  --min-occurrences 2 \
  --max-steps 20 \
  --top-n 5

# 查看中文帮助
node index.js --help
```

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--domain <域名>` | **必填**，网站小写 hostname（如 `example.com`） | — |
| `--name <技能名>` | 技能名称；不传则按首个点击文本自动生成 | 自动生成 |
| `--session-ids <a,b,c>` | 仅使用指定会话 id，逗号分隔 | 该站点全部会话 |
| `--min-occurrences <数>` | 动作链最少出现会话数 | `2` |
| `--max-steps <数>` | 动作链最大长度 | `20` |
| `--top-n <数>` | 按评分保留前 N 条链 | `5` |
| `--db-path <路径>` | 覆盖数据库路径（优先于环境变量） | 见下文 |

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `DB_PATH` | daemon 数据库文件路径 | `<项目根>/daemon/data/behavior.db` |
| `DAEMON_URL` | daemon HTTP 地址 | `http://127.0.0.1:8756`（契约 §3） |

### 作为模块被 MCP 调用（ESM 导出）

```js
import { distillSkill } from './replay/distill/index.js';

const result = await distillSkill({
  domain: 'example.com',
  name: '下单流程',           // 可选
  sessionIds: ['s_001'],     // 可选
  minOccurrences: 2,
  maxSteps: 20,
  topN: 5,
  dbPath: undefined,         // 可选，覆盖 DB 路径
});

// result.skillId / result.path 为主技能标识；
// result.skills 为全部技能（含技能对象与注册结果）；result.report 为完整报告
```

## 4. 数据库直读说明（契约 §2、§3）

- **只读连接**：使用 `better-sqlite3` 的 `new Database(path, { readonly: true, fileMustExist: true })`，只读取不写入，不与 daemon 抢写锁；WAL 模式下支持与 daemon 并发只读。
- **表名清洗**：域名中小写、非 `[a-zA-Z0-9_]` 字符替换为 `_`，实体表名为 `behaviors_<清洗后域名>`（例：`example.com` → `behaviors_example_com`）。
- **库不存在 / 表不存在 / 会话无记录**：均返回中文错误提示并以非零退出码结束，不会抛出英文栈信息给上层。
- 本模块**不写数据库**；唯一落盘是 `replay/skills/*.json`，唯一网络动作是向 daemon 注册技能索引。

## 5. 技能 JSON 结构（契约 §5）

落盘文件 `replay/skills/<skillId>.json` 结构严格遵循 §5，关键字段：

- `skillId`：`skl_<sha256 前 16 位>`（摘要输入：域名 + 名称 + 时间戳 + 动作链加盐，避免同名多技能碰撞）；
- `targetUrlPattern`：`^https://<转义域名>/.*`；
- `evidence.matchRate`：该链出现会话数 / 参与蒸馏会话数；
- `actions[]`：`step / type / selector / value / waitMs / optional / assertions[]`；
- `assertions[]`：`kind / target / timeoutMs`，`kind` 取值 `url_contains | text_present | element_present | url_change`。

## 6. 自检（契约 §8 模块D）

```bash
# 1) 造 mock 库（3 条相似会话：打开商品页 → 点击卡片 → 加入购物车 → 输入数量 → 提交订单 → 跳转确认页）
node replay/distill/seed-mock-db.js

# 2) 契约 §8 指定命令
node replay/distill/index.js --domain example.com --min-occurrences 2

# 3) 一体化自检：临时造库 → 蒸馏 → 结构/类型/断言/匹配率/报告逐条校验
node replay/distill/selfcheck.js
```

自检通过标准（`selfcheck.js` 清单）：

- mock 库构造成功（≥2 条相似会话）；
- 产出 ≥1 个技能，JSON 结构全部符合 §5；
- 动作类型覆盖 `navigate / click / input`；
- 每个技能至少包含一条断言，`matchRate ∈ [0,1]`；
- 报告包含候选链数、技能数、动作摘要与匹配率。

## 7. 已知限制与待验证项

- **索引持久化待模块B就绪**：当前环境中若 daemon 为占位 mock 服务，`POST /api/skills` 只做 HTTP 200 应答、不落库；本模块客户端已按契约 §3 实现注册请求与失败不阻塞逻辑，待模块B 正式 daemon 上线后回归验证索引可查（已实现 + 待真机/模块B 就绪验证）。
- **链匹配为连续子串前缀树挖掘**：对会话中插入的零星独立操作（如额外点了一次收藏），完整主链会以出现次数略降的形式被挖掘；代表会话提取时按子序列定位、跳过中间噪声动作，保证回放切片连贯。
- 长轨迹单会话截断上限 200 步（`src/mine.js` 内 `maxActionsPerSession`），如需更大规模可按站点规模调整。
