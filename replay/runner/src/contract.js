/**
 * 模块E 契约常量（对齐 docs/CONTRACTS.md §5 技能 JSON 格式、§6 回放执行器）。
 * 这里只放允许的枚举值与中文标签，便于 CLI、预检、后端适配器共用同一份事实源。
 */

/** §5 允许的动作类型（mousemove / mouseenter 等噪声已在蒸馏层丢弃） */
export const ACTION_TYPES = [
  'navigate',
  'click',
  'dblclick',
  'input',
  'scroll',
  'hover',
  'wait',
  'assert',
];

/** §5 允许的断言类型 */
export const ASSERTION_KINDS = [
  'url_contains',
  'text_present',
  'element_present',
  'url_change',
];

/** 断言状态：PASS 通过 / FAIL 失败 / SKIP 跳过（可选动作失败时使用） */
export const STEP_STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  SKIP: 'SKIP',
};

/** 模式枚举（§6） */
export const MODES = {
  DRY_RUN: 'dry_run',
  CDP: 'cdp',
  PLAYWRIGHT: 'playwright',
};

/** 动作类型中文标签，用于报告展示 */
export const ACTION_LABELS = {
  navigate: '导航到页面',
  click: '单击元素',
  dblclick: '双击元素',
  input: '输入文本',
  scroll: '滚动页面',
  hover: '悬停元素',
  wait: '等待延时',
  assert: '后置断言',
};

/** 断言类型中文标签 */
export const ASSERTION_LABELS = {
  url_contains: '当前网址包含指定文本',
  text_present: '元素文本包含指定内容',
  element_present: '目标元素存在于页面',
  url_change: '网址相比动作前发生变化',
};

/** 默认动作后停留时长（毫秒），给页面渲染与断言轮询留出窗口 */
export const DEFAULT_WAIT_MS = 300;

/** 默认断言超时（毫秒），与 §5 示例保持一致 */
export const DEFAULT_ASSERTION_TIMEOUT_MS = 5000;

/** 断言轮询间隔（毫秒） */
export const ASSERTION_POLL_INTERVAL_MS = 100;

/** CDP 默认调试地址（Chrome --remote-debugging-port=9222） */
export const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';
