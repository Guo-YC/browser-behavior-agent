export default defineConfig({
  manifest: {
    name: '浏览器行为采集',
    description: '静默记录你的浏览器行为（点击/鼠标/输入/滚动/导航/请求），敏感字段硬丢弃，经 Native Messaging 存入本地库。',
    version: '0.1.0',
    permissions: ['nativeMessaging', 'storage', 'webRequest', 'tabs', 'scripting', 'activeTab'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: '浏览器行为采集（点按展开 options）',
    },
  },
});
