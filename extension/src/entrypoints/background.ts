/**
 * background service worker：会话管理、Native Messaging 桥、webRequest 采集。
 * 契约 §1：批量上报（500ms/50条）、断线指数退避重连、敏感头剥离。
 */
export default defineBackground(() => {
  // placeholder background
});
