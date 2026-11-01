/**
 * content script：页面事件采集（点击/输入/滚动等）+ 敏感字段硬丢弃。
 * 契约 §1.3/§1.4。
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // placeholder content
  },
});
