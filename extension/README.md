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
| `session_start` | `{userAgent, screenWidth, screenHeight, startUrl}` | background（content 首次 `get_session` 时补发） |
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
├── package.json                  # 脚本与依赖（wxt、@medv/finder、typescript）
├── wxt.config.ts                 # WXT 配置：权限、host_permissions、稳定 ID 备注
├── tsconfig.json                 # 继承 .wxt/tsconfig.json（wxt prepare 生成）
├── README.md                     # 本文件
├── public/                       # 静态资源（图标可后续放入，当前使用浏览器默认图标）
└── src/
    ├── shared/                   # content 与 background 共用模块
    │   ├── types.ts             # 事件 / 信封 / 内部消息类型（契约 §1.1、§1.2、§1.3）
    │   ├── defaults.ts          # 配置模型、默认规则、深度合并
    │   ├── redaction.ts         # §1.4 脱敏：元素判定、选择器元信息、URL/请求头/请求体剥离
    │   └── utils.ts             # UUID、域名提取、文本截断、正则编译、节流
    └── entrypoints/
        ├── background.ts        # service worker：Native 桥、webRequest、会话与定时器
        ├── content.ts            # 静态内容脚本：页面内事件采集与 SPA 导航拦截
        └── options/
            ├── index.html        # 中文配置页（WXT 自动识别为 options_ui）
            └── main.ts           # 配置读写、正则校验、恢复默认
```

---

## 三、构建与自检（契约 §8 模块A）

### 3.1 环境要求

- Node.js ≥ 20、pnpm 11.x（本机已装 pnpm 11.7.0）。
- 依赖：`wxt@^0.21.5`、`@medv/finder@^4.0.2`、`typescript@^5.9.3`。

### 3.2 命令

```bash
cd extension
pnpm install        # 安装依赖并执行 wxt prepare 生成类型
pnpm compile        # tsc --noEmit 类型检查（不产出文件）
pnpm build          # 生产构建（Chrome MV3）
pnpm dev            # 开发模式（自动重载；本机无 GUI 可不执行，详见第五节）
```

### 3.3 自检结果（本机 2026-10-31）

- `pnpm install`：依赖解析成功，`wxt prepare` 类型生成通过。
- `pnpm compile`：`tsc --noEmit` **零报错**。
- `pnpm build`：WXT 0.21.5 生产构建 **零报错**，构建摘要：

```
✔ Built extension in 1.681 s
  ├─ .output/chrome-mv3/manifest.json               675 B
  ├─ .output/chrome-mv3/options.html                4.05 kB
  ├─ .output/chrome-mv3/background.js               8.53 kB
  ├─ .output/chrome-mv3/chunks/options-*.js         2.90 kB
  └─ .output/chrome-mv3/content-scripts/content.js  13.16 kB
Σ Total size: 29.31 kB
```

### 3.4 构建产物

- **相对路径**：`extension/.output/chrome-mv3/`（相对于项目根目录，绝对路径请按你实际放置目录解析）
- 产物清单（已逐项核对存在）：

| 文件 | 说明 |
|---|---|
| `manifest.json` | MV3 清单（权限、host_permissions、background、content_scripts、options_ui） |
| `background.js` | service worker 脚本 |
| `content-scripts/content.js` | 静态注入的内容脚本 |
| `options.html` + `chunks/options-*.js` | 中文配置页 |

> **已知坑①**：WXT 不同版本的产物目录名可能变化。本版本（0.21.5）为 `.output/chrome-mv3/`；升级 WXT 后以 `pnpm build` 实际输出的目录为准，不要硬编码路径。

### 3.5 manifest 关键权限清单（构建产物 `manifest.json`）

```jsonc
{
  "manifest_version": 3,
  "permissions": ["storage", "nativeMessaging", "webRequest", "tabs", "scripting"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "options_ui": { "open_in_tab": true, "page": "options.html" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "all_frames": false,
    "run_at": "document_start",
    "js": ["content-scripts/content.js"]
  }]
}
```

| 权限 | 用途 |
|---|---|
| `storage` | 读写 options 保存的配置（总开关、敏感规则、采样开关） |
| `nativeMessaging` | 与本地守护进程 host `com.browser.behavior.collector` 建立长连接 |
| `webRequest` | `onBeforeRequest` / `onSendHeaders` / `onCompleted` / `onErrorOccurred` 采集 `request` 事件 |
| `tabs` | `onActivated` / `onRemoved` / `onReplaced`，产出 `tabswitch` 与 `session_end` |
| `scripting` | 仅声明备查；**本扩展使用静态 content script，不做 `chrome.scripting.executeScript` 动态注入**（已知坑④） |
| `host_permissions: <all_urls>` | 页面内容脚本匹配全部 http(s) 站点；`webRequest` 监听全部站点 |

---

## 四、真机加载步骤（无 GUI 环境已实现 + 待真机验证）

> 本沙箱环境无图形界面，`pnpm dev` 未执行；以下步骤在真实 Chrome 上操作。

1. 先在本机完成构建：`cd extension && pnpm install && pnpm build`。
2. 打开 Chrome，地址栏进入 `chrome://extensions/`。
3. 打开右上角 **开发者模式**（Developer mode）开关。
4. 点击 **加载已解压的扩展程序**，选择构建目录：
   ```
   extension/.output/chrome-mv3/
   ```
5. 加载后在扩展列表确认「浏览器行为采集器」已启用；点击扩展卡片上的 **详细信息 → 扩展程序选项**（或右键扩展图标 → 选项）打开配置页。
6. 验证：
   - 任意网页点击、输入、滚动后，`background` 应通过 Native Messaging 批量发往本地 host（host 未安装时控制台可见断连与退避重连日志，属正常现象）；
   - 打开选项页可看到总开关、敏感规则、采样开关三项设置。

### 开发模式（可选）

```bash
pnpm dev        # WXT 启动 watch 模式并自动拉起 Chrome（需要本机 Chrome 与图形界面）
```

---

## 五、固定扩展 ID（两种方案，二选一）

> **已知坑③**：扩展 ID 不固定时，Native Messaging host 注册清单 `allowed_origins` 会失效，host 无法被扩展拉起。开发期未打包加载的扩展，每次重新加载 ID 可能变化，必须按下述方案固定。

### 方案一（推荐，跨重启 / 跨机器保持一致）：在 `wxt.config.ts` 配置 `manifest.key`

1. 用 OpenSSL 生成扩展私钥（仅做一次，妥善保管）：

   ```bash
   openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out extension-key.pem
   ```

2. 在 `extension/wxt.config.ts` 的 `manifest` 中取消注释并填入 PEM（保持单行 `\n` 转义格式，或读取环境变量）：

   ```ts
   manifest: {
     // ...
     key: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n',
   }
   ```

3. 重新 `pnpm build` 后加载，扩展 ID 由公钥哈希派生，**永久固定**。后续在 `chrome://extensions` 上看到的 ID 与 host 注册清单中填写的 `chrome-extension://<ID>/*` 一致。

> 说明：MV3 下 `key` 字段同时用于派生扩展 ID；填入后开发加载与打包发布使用同一个 ID。

### 方案二（不配 `key` 的快速调试）：从 `chrome://extensions` 复制 ID 填给 host

1. 按第四节加载扩展后，在 `chrome://extensions/` 对应卡片上复制 **扩展程序 ID**（形如 `abcdefghijklmnopabcdefghijklmnop`）。
2. 把该 ID 写入模块B Native Messaging host 注册清单的 `allowed_origins`：

   ```json
   {
     "name": "com.browser.behavior.collector",
     "description": "浏览器行为采集本地守护进程",
     "path": "/absolute/path/to/host.js",
     "type": "stdio",
     "allowed_origins": ["chrome-extension://<这里粘贴扩展ID>/"]
   }
   ```

3. 注意：**删除扩展重新安装、修改静态清单导致重新打包，或换浏览器 profile，ID 都会变化**；一旦变化必须同步更新 host 清单并重新注册（见模块B `scripts/install-native-host.sh`）。

### 与 host 注册联动说明

- Native Messaging host 名称固定为 `com.browser.behavior.collector`（契约 §0），代码中常量见 `background.ts` 顶部 `NATIVE_HOST_NAME`。
- host 清单安装位置（按操作系统，模块B 脚本负责写入）：
  - Windows：`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser.behavior.collector`
  - macOS：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.browser.behavior.collector.json`
  - Linux：`~/.config/google-chrome/NativeMessagingHosts/com.browser.behavior.collector.json`
- 扩展启动后即 `chrome.runtime.connectNative(...)`；host 未安装 / 路径错误时，`onDisconnect` 触发并按 **1s → 2s → 4s → … 上限 30s** 指数退避重连，期间事件留在内存队列（上限 2000 条，超出丢弃最旧），链路恢复后继续批量发送。
- 单条 Native 消息 ≤1MB（契约 §1.1）：发送前按保守字节估算（字符数 ×2）拆包，每包一个 `batch` 信封；代码见 `background.ts` 的 `flushQueue`。

---

## 六、配置项（options 页 / `chrome.storage.local`）

存储键：`behavior.collector.config`（`src/shared/defaults.ts` 的 `CONFIG_STORAGE_KEY`）。content script 与 background 均监听 `storage.onChanged` 热更新，保存后即时生效，无需重载扩展。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 采集总开关；关闭后 content 与 background 均不再产出事件 |
| `sampleMousemove` | `true` | 是否采集 `mousemove`（页面内节流 ≥500ms） |
| `sampleScroll` | `true` | 是否采集 `scroll`（页面内节流 ≥200ms） |
| `redaction.enabled` | `true` | 脱敏总开关（默认开启，关闭仅用于调试） |
| `redaction.sensitivePatterns` | 默认规则一条 | 敏感属性正则列表，一行一条，大小写不敏感；options 页可增删改 |
| `redaction.dropHeaders` | 见下表 | 整头剥离（只读，内置在默认配置中） |
| `redaction.dropUrlParams` | 见下表 | URL 查询参数值置 `****`（只读，内置在默认配置中） |
| `heartbeatIntervalMs` | `300000`（5min） | 空闲期心跳间隔 |
| `idleTimeoutMs` | `1800000`（30min） | 空闲无真实事件 → `session_end(reason="idle")` |
| `batchSize` | `50` | 攒满条数立即发送 |
| `batchIntervalMs` | `500` | 定时刷新间隔 |

### 默认敏感正则（契约 §1.4 #2）

```
passw|pwd|token|secret|api[_-]?key|apikey|credit|card|cvv|cvc|pin|auth|session[_-]?id|ssn
```

命中元素的 `type` / `name` / `id` / `autocomplete` / `aria-label` / `placeholder` 任一属性即判定为敏感；`type=password` 直接判定敏感。

### 默认剥离请求头（契约 §1.4 #5）

`authorization`、`cookie`、`set-cookie`、`proxy-authorization`、`x-api-key`、`x-auth-token`、`x-csrf-token` —— 命中后整头不放入 `reqHeaders`。

### 默认脱敏 URL 参数（契约 §1.4 #4）

`token`、`access_token`、`signature`、`key`、`secret` —— 命中后参数值替换为 `****`，其余参数原样保留。

### 请求体预览（契约 §1.5）

- 仅当 `requestBody.raw` 存在且可解码为文本时截取 **≤1KB** 前缀；二进制不采集。
- JSON 字段名 / 表单键名命中敏感正则时，整段预览置 `****`。

---

## 七、会话与心跳行为说明

- **会话粒度**：一个 tab 一个 `s_<uuid>`；整页刷新后由 content 重新 `get_session`，background 命中已有会话则复用（`onRemoved` 前 tabId 不变）；tab 关闭 / 替换时发 `session_end`。
- **心跳**：仅在空闲期（距上一次真实事件 ≥5min）发送 `heartbeat {active:true}`，用于阻止守护进程按 30min 空闲回收会话；活跃期不刷心跳以减少噪声。
- **空闲回收**：background 每 60s 扫描一次，超过 30min 无真实用户事件的会话发 `session_end {reason:"idle"}` 并移出缓存。
- **MV3 service worker 休眠**：后台脚本可能被浏览器休眠回收；休眠期间定时器暂停，事件到达会唤醒 SW，`onInstalled` / `onStartup` 触发时会重新连接 Native 桥。**待真机验证**：长时间挂后台时心跳与空闲扫描的及时性，以真机 Chrome 表现为准。

---

## 八、已实现 + 待真机验证清单（契约 §9 #6）

| 项 | 状态 | 验证步骤 |
|---|---|---|
| `pnpm install` / `pnpm build` 零报错、产物含 manifest + background + content | ✅ 已在本环境验证 | 见 §3.3 构建摘要 |
| TypeScript 类型检查 `pnpm compile` 零报错 | ✅ 已在本环境验证 | `cd extension && pnpm compile` |
| 静态 content script 注入、页面事件采集 | ⏳ 已实现，待真机验证 | 按 §4 加载后打开网页，观察 background 日志与守护进程入库 |
| Native Messaging 握手、批量发送、断线退避重连 | ⏳ 已实现，待真机验证 | 先装好模块B host 与注册清单；扩展加载后在 `chrome://extensions` 后台页面查看连接状态；手动停止 host 观察退避日志 |
| `webRequest` 请求采集与头 / 参数 / 请求体脱敏 | ⏳ 已实现，待真机验证 | 打开含登录表单 / 外部 API 的页面，在守护进程 `requests_<domain>` 表核对 `reqHeaders` 无 cookie/authorization、URL 中 token 值为 `****` |
| options 页配置保存与热更新 | ⏳ 已实现，待真机验证 | 修改规则后切到网页触发事件，确认新规则即时生效 |
| 稳定扩展 ID（方案一 key / 方案二复制 ID） | ⏳ 文档已给出，待真机按 §5 操作 | 加载后核对 host `allowed_origins` 与扩展 ID 一致 |

---

## 九、开发备注与已知坑

1. **不要用 `chrome.scripting.executeScript` 动态注入替代静态 content script**（任务已知坑④）；内容脚本由 `content.ts` 顶部 `defineContentScript({ matches: ['<all_urls>'], runAt: 'document_start' })` 静态声明，WXT 自动写入 `manifest.content_scripts`。
2. WXT 产物目录名随版本变化（已知坑①）：以 `pnpm build` 终端输出与 `.output/` 实际目录为准。
3. Native Messaging 单条消息 ≤1MB（已知坑②）：本扩展发送前拆包；host 侧（模块B）必须每次消息独立事务写库。
4. `requestHeaders` 在 Chrome 中只能于 `onSendHeaders` 阶段取得，`requestBody` 只能于 `onBeforeRequest` 阶段取得；本扩展分别缓存、在 `onCompleted` 合并为 `request` 事件。
5. `mousemove` 高噪声：options 页可整体关闭；`mouseenter` 由 `mouseover + relatedTarget` 判定模拟（`mouseenter` 事件本身不冒泡）。
6. 契约接口未自行变更；如调试中发现协议缺陷，按契约 §9 #4 先修订 `docs/CONTRACTS.md` 并通知组织者。
