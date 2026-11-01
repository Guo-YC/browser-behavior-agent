export default defineConfig({
  manifest: {
    name: '浏览器行为采集器',
    description: '静默记录你的浏览器行为（点击/鼠标/输入/滚动/导航/请求），敏感字段硬丢弃，经 Native Messaging 存入本地库。',
    version: '0.1.0',
    // 稳定扩展 ID（方案一）：如需固定 ID，取消注释并填入 PEM 私钥（见 extension/README §五）
    // key: '',
    permissions: ['storage', 'nativeMessaging', 'webRequest', 'tabs', 'scripting'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: '浏览器行为采集器（点按打开设置）',
    },
  },
});
