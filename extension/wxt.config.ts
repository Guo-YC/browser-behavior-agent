import { defineConfig } from 'wxt';

/**
 * WXT 构建配置（模块A：Chrome MV3 采集扩展）。
 *
 * 权限说明（对照契约 §1.5 / §1.2 与任务要求）：
 * - storage         读取 options 页保存的采集配置（总开关、敏感规则、采样开关）
 * - nativeMessaging 与本地守护进程（host 名 com.browser.behavior.collector）建立长连接
 * - webRequest      监听 onCompleted / onErrorOccurred / onBeforeRequest，采集 request 事件
 * - tabs            监听 onActivated / onRemoved / onReplaced，产出 tabswitch 与 session_end
 * - scripting       仅声明备查；本扩展使用静态 content script，不做动态注入（见契约已知坑④）
 *
 * 稳定扩展 ID 方案详见 README.md「三、固定扩展 ID」章节。
 */
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: '浏览器行为采集器',
    short_name: '行为采集器',
    version: '1.0.0',
    description: '按 CONTRACTS.md §1 协议采集浏览器行为，经 Native Messaging 上报本地守护进程（采集层强制脱敏）。',
    permissions: ['storage', 'nativeMessaging', 'webRequest', 'tabs', 'scripting'],
    host_permissions: ['<all_urls>'],
    // 静态内容脚本由 src/entrypoints/content.ts 中的 defineContentScript 声明，
    // 不在此手动写 content_scripts，避免与 WXT 自动生成的清单冲突。
    // options 页由 src/entrypoints/options/index.html 自动识别并写入 options_ui。
    // —— 固定扩展 ID（推荐做法，二选一，见 README）——
    // 方案一：发布前在此填入公钥对应的 manifest.key（PEM），ID 永久固定；
    // 方案二：不填 key，未打包加载时每次安装 ID 会变化，需在 host 注册清单里填入
    //         chrome://extensions 页面显示的「扩展程序 ID」（见 README 说明）。
    // key: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n',
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
