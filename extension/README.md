# 模块A：Chrome MV3 行为采集扩展

> 浏览器行为采集端，技术栈 **WXT 0.21 + TypeScript**。
> 接口协议唯一事实源：[`../docs/CONTRACTS.md`](../docs/CONTRACTS.md)（§1 事件协议、§1.4 敏感字段硬丢弃、§1.5 请求记录、§8 验收标准）。
> 所有代码注释、对外文案均为中文；代码标识符为英文。

---

## 一、功能概览

| 能力 | 实现位置 | 契约依据 |
|---|---|---|
| 采集 click / dblclick / contextmenu / mousemove（≥500ms 节流）/ mouseenter（≥1s 节流）/ input / keydown / scroll（≥200ms 节流）/ focus / blur | `src/entrypoints/content.ts` | §1.2、§1.3 |
| SPA 导航采集：`pushState` / `replaceState` / `hashchange` / `popstate` → `navigation` 事件 | `src/entrypoints/content.ts`（`hookSpaNavigation`） | §1.3 navigation |
| 生命周期事件：`page_load` / `page_hide` | `src/entrypoints/content.ts` | §1.3 |
| `@medv/finder@^4` 生成页面内唯一、结构稳定的 CSS 选择器 | `src/entrypoints/content.ts`（`inspectTarget`） | 任务要求 |
| 敏感字段采集层硬丢弃：密码框 / 命中正则的输入框，`value`、`key` 一律 `****`，`element.redacted=true` | `src/shared/redaction.ts` | §1.4 #1、#2 |
| 会话管理：tab 级 `sessionId`（`s_<uuid>`）、`session_start` / `session_end`、心跳保活、30min 空闲回收 | `src/entrypoints/background.ts` | §1.2、§1.3 |
| Native Messaging 长连接：500ms 或 50 条批量打包、1MB 拆包、断线指数退避重连、监听 `onDisconnect` | `src/entrypoints/background.ts`（`connectNative` / `flushQueue`） | §1.1 |
| 网络请求采集：`webRequest.onCompleted` / `onErrorOccurred`（`onBeforeRequest` 取请求体、`onSendHeaders` 取请求头）→ `request` 事件；URL 参数与敏感请求头剥离 | `src/entrypoints/background.ts`（`registerWebRequest`）、`src/shared/redaction.ts` | §1.4 #4、#5、§1.5 |
| `tabs.onActivated` → `tabswitch`；`tabs.onRemoved` / `tabs.onReplaced` → `session_end`（`tab_close` / `replaced`） | `src/entrypoints/background.ts`（`registerTabs`） | §1.3 |
| 中文 options 配置页：采集总开关、敏感规则列表编辑、mousemove / scroll 采样开关 | `src/entrypoints/options/index.html`、`main.ts` | §1.4 #6 |

### 事件类型与 detail 字段对照（契约 §1.3）

| type | detail 字段 | 产生方 |
|---|---|---|
| `session_start` | `{userAgent, screenWidth, screenHeight, startUrl}` | background |
| `session_end` | `{reason: "tab_close" \| "idle" \| "replaced"}` | background |
| `page_load` | `{referrer, title}` | content |
| `navigation` | `{url, title, transitionType}` | content |
| `page_hide` | `{}` | content |
| `click` / `dblclick` / `contextmenu` | `{selector, element, button, clientX, clientY}` | content |
| `mousemove` | `{selector, clientX, clientY}` | content（节流 ≥500ms） |
| `mouseenter` | `{selector, element}` | content（节流 ≥1s） |
| `input` | `{selector, element, inputType, value}`（value ≤500 字符；敏感置 `****`） | content |
| `keydown` | `{selector, key, code, ctrlKey, metaKey, altKey, shiftKey}`（密码框 `key`/`code` 置 `****`） | content |
| `scroll` | `{scrollX, scrollY, scrollHeight, clientHeight, direction}` | content（节流 ≥200ms） |
| `focus` / `blur` | `{selector, element}` | content |
| `tabswitch` | `{active: true \| false}` | background |
| `request` | `{method, requestUrl, status, durationMs, resourceType, reqHeaders, respHeaders, postBodyPreview}` | background |
| `heartbeat` | `{active: true}` | background（空闲期每 5min 一次） |

> `copy` / `paste` 按契约 §1.4 #3 **不进入事件流**，本扩展未注册对应监听。

---

## 二、目录结构

```
extension/
├── package.json
├── wxt.config.ts
├── tsconfig.json
├── README.md
└── src/
    ├── shared/
    │   ├── types.ts
    │   ├── defaults.ts
    │   ├── redaction.ts
    │   └── utils.ts
    └── entrypoints/
        ├── background.ts
        ├── content.ts
        └── options/
            ├── index.html
            └── main.ts
```

---

## 三、构建与自检（契约 §8 模块A）

### 3.1 环境要求

Node.js ≥ 20、pnpm 11.x。依赖：`wxt@^0.21.5`、`@medv/finder@^4.0.2`、`typescript@^5.9.3`。

### 3.2 命令

```bash
cd extension
pnpm install        # 安装依赖并执行 wxt prepare 生成类型
pnpm compile        # tsc --noEmit 类型检查（不产出文件）
pnpm build          # 生产构建（Chrome MV3）
pnpm dev            # 开发模式（需要本机 Chrome 与图形界面）
```

### 3.3 自检结果（本机 2026-10-31）

- `pnpm install`：依赖解析成功，`wxt prepare` 类型生成通过。
- `pnpm compile`：`tsc --noEmit` **零报错**。
- `pnpm build`：WXT 0.21.5 生产构建 **零报错**，产物：`.output/chrome-mv3/manifest.json`、`options.html`、`background.js`、`content-scripts/content.js` 等，总大小约 29 kB。

### 3.4 构建产物

- **相对路径**：`extension/.output/chrome-mv3/`（相对于项目根目录）。
- 已知坑：WXT 不同版本产物目录名可能变化（本版本为 `.output/chrome-mv3/`）；升级后以 `pnpm build` 实际输出为准。

### 3.5 manifest 关键权限

```jsonc
{
  "manifest_version": 3,
  "permissions": ["storage", "nativeMessaging", "webRequest", "tabs", "scripting"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "options_ui": { "open_in_tab": true, "page": "options.html" },
  "content_scripts": [{
    "matches": ["<all_urls>"], "all_frames": false, "run_at": "document_start",
    "js": ["content-scripts/content.js"]
  }]
}
```

| 权限 | 用途 |
|---|---|
| `storage` | 读写 options 配置 |
| `nativeMessaging` | 与本地守护进程 host `com.browser.behavior.collector` 建立长连接 |
| `webRequest` | 采集 `request` 事件 |
| `tabs` | `tabswitch` 与 `session_end` |
| `scripting` | 仅声明备查；本扩展使用静态 content script，不做动态注入 |
| `host_permissions: <all_urls>` | 页面内容脚本匹配全部 http(s) 站点 |

---

## 四、真机加载步骤

1. 构建：`cd extension && pnpm install && pnpm build`。
2. 打开 Chrome `chrome://extensions/`，开启**开发者模式**。
3. **加载已解压的扩展程序**，选择 `extension/.output/chrome-mv3/`。
4. 在扩展卡片上**详细信息 → 扩展程序选项**打开配置页。
5. 验证：任意网页点击/输入/滚动后，background 通过 Native Messaging 批量发往本地 host；host 未安装时控制台可见断连与退避重连日志（属正常）。

---

## 五、固定扩展 ID（两种方案，二选一）

> 扩展 ID 不固定时，Native Messaging host 注册清单 `allowed_origins` 会失效。

### 方案一（推荐）：在 `wxt.config.ts` 配置 `manifest.key`

1. 用 OpenSSL 生成扩展私钥（仅一次，妥善保管）：`openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out extension-key.pem`。
2. 在 `wxt.config.ts` 的 `manifest` 中取消注释并填入 PEM（保持单行 `\n` 转义格式，或读环境变量）。
3. 重新 `pnpm build` 后加载，扩展 ID 永久固定。

### 方案二（快速调试）：从 `chrome://extensions` 复制 ID 填给 host

把扩展 ID 填入 Native Messaging host 注册清单的 `allowed_origins`。注意：删除扩展重装、修改静态清单重打包、换 profile 都会改变 ID，需同步更新 host 清单并重新注册。

### 与 host 注册联动

- Host 名称固定为 `com.browser.behavior.collector`（`background.ts` 顶部 `NATIVE_HOST_NAME`）。
- Host 清单位置（模块B 脚本负责写入）：Windows `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser.behavior.collector`；macOS `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/...`；Linux `~/.config/google-chrome/NativeMessagingHosts/...`。
- 断线退避：`1s → 2s → 4s → … 上限 30s`，期间事件留在内存队列（上限 2000 条）。
- 单条 Native 消息 ≤1MB：发送前按字符数 ×2 保守估算拆包。

---

## 六、配置项（options 页 / `chrome.storage.local`）

存储键：`behavior.collector.config`。content 与 background 均监听 `storage.onChanged` 热更新。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 采集总开关 |
| `sampleMousemove` | `true` | 是否采集 mousemove |
| `sampleScroll` | `true` | 是否采集 scroll |
| `redaction.enabled` | `true` | 脱敏总开关 |
| `redaction.sensitivePatterns` | 默认规则一条 | 敏感属性正则列表 |
| `redaction.dropHeaders` | 见下表 | 整头剥离 |
| `redaction.dropUrlParams` | 见下表 | URL 参数值置 `****` |
| `heartbeatIntervalMs` | `300000`（5min） | 空闲期心跳间隔 |
| `idleTimeoutMs` | `1800000`（30min） | 空闲回收 |
| `batchSize` | `50` | 攒满条数立即发送 |
| `batchIntervalMs` | `500` | 定时刷新间隔 |

默认敏感正则：`passw|pwd|token|secret|api[_-]?key|apikey|credit|card|cvv|cvc|pin|auth|session[_-]?id|ssn`

默认剥离请求头：`authorization`、`cookie`、`set-cookie`、`proxy-authorization`、`x-api-key`、`x-auth-token`、`x-csrf-token`

默认脱敏 URL 参数：`token`、`access_token`、`signature`、`key`、`secret`

请求体预览：仅 JSON/表单截取 ≤1KB；JSON 字段名 / 表单键名命中敏感正则时整段置 `****`。

---

## 七、会话与心跳行为说明

- 会话粒度：一个 tab 一个 `s_<uuid>`；整页刷新后 content 重新 `get_session`，background 复用已有会话；tab 关闭 / 替换发 `session_end`。
- 心跳：仅空闲期（距上次真实事件 ≥5min）发 `heartbeat`，防守护进程按 30min 回收；活跃期不刷心跳。
- 空闲回收：background 每 60s 扫描，超 30min 无真实事件 → `session_end {reason:"idle"}`。
- MV3 SW 休眠：休眠期定时器暂停，事件到达唤醒 SW，`onInstalled` / `onStartup` 时重连 Native 桥。

---

## 八、已实现 + 待真机验证清单（契约 §9 #6）

| 项 | 状态 | 验证步骤 |
|---|---|---|
| `pnpm install` / `pnpm build` 零报错 | ✅ 本环境已验证 | 见 §3.3 |
| TypeScript 类型检查零报错 | ✅ 本环境已验证 | `pnpm compile` |
| 静态 content script 注入、页面事件采集 | ⏳ 已实现，待真机验证 | 按 §4 加载后观察入库 |
| Native Messaging 握手、批量发送、退避重连 | ⏳ 已实现，待真机验证 | 装好 host 后加载扩展观察连接状态 |
| webRequest 采集与脱敏 | ⏳ 已实现，待真机验证 | 核对 requests 表无 cookie/authorization |
| options 页保存与热更新 | ⏳ 已实现，待真机验证 | 修改规则后确认即时生效 |
| 稳定扩展 ID | ⏳ 文档已给出 | 按 §5 操作 |

---

## 九、开发备注与已知坑

1. 不要用 `chrome.scripting.executeScript` 动态注入替代静态 content script（静态 `defineContentScript` 写入 manifest）。
2. WXT 产物目录名随版本变化，以实际输出为准。
3. Native Messaging 单条消息 ≤1MB：发送前拆包；host 侧每次消息独立事务。
4. `requestHeaders` 只能在 `onSendHeaders` 阶段取得，`requestBody` 只能在 `onBeforeRequest` 阶段取得；本扩展分别缓存、在 `onCompleted` 合并。
5. `mousemove` 高噪声可整体关闭；`mouseenter` 由 `mouseover + relatedTarget` 模拟。
6. 契约接口未自行变更；如发现协议缺陷，先修订 `docs/CONTRACTS.md` 并通知组织者。
