// 模块D：轨迹清洗与动作序列化（契约 §7 第2、3步；§5 动作类型白名单）
// 清洗规则：
//  1. 丢弃 mousemove/mouseenter/heartbeat/focus/blur/tabswitch 等噪声事件；
//  2. 同方向连续 scroll 合并为一条 scroll；
//  3. 动作序列化为匹配键 type|selector|value（click 附带元素文本；input 脱敏值不参与区分）。

// 直接丢弃的事件类型（契约 §7 第2步 + §5 可执行类型白名单外的噪声）
const DROP_TYPES = new Set([
  'mousemove',
  'mouseenter',
  'heartbeat',
  'focus',
  'blur',
  'tabswitch',
  'request',
  'session_start',
  'session_end',
  'page_hide',
  'page_load',
  'keydown',
]);

// 契约 §5 允许进入技能动作序列的类型
const EXECUTABLE_TYPES = new Set(['navigate', 'click', 'dblclick', 'input', 'scroll', 'hover', 'wait']);

/** 脱敏值标记：契约 §1.4 中密码/敏感字段值已被置为 "****"，匹配时不参与区分 */
const MASKED_VALUE = '****';

/**
 * 把单条原始事件映射为可执行动作对象；不可执行的类型返回 null
 * @param {object} event 原始行为事件
 * @returns {object|null} 动作对象
 */
function mapEventToAction(event) {
  const { type, url, selector, element, detail } = event;

  switch (type) {
    case 'navigation': {
      // SPA pushState/hashchange 与整页跳转都归为 navigate 动作
      const targetUrl = detail.url || url;
      return {
        type: 'navigate',
        selector: 'html',
        value: targetUrl,
        text: '',
        masked: false,
        ts: event.ts,
        source: event,
      };
    }
    case 'click':
    case 'dblclick': {
      const text = (element && element.text) || '';
      return {
        type,
        selector: detail.selector || selector || '',
        value: '',
        text,
        masked: false,
        ts: event.ts,
        source: event,
      };
    }
    case 'input': {
      const rawValue = detail.value ?? '';
      const masked = rawValue === MASKED_VALUE;
      return {
        type: 'input',
        selector: detail.selector || selector || '',
        value: rawValue,
        text: '',
        masked,
        ts: event.ts,
        source: event,
      };
    }
    case 'scroll': {
      return {
        type: 'scroll',
        selector: 'body',
        value: detail.direction || '',
        text: '',
        masked: false,
        ts: event.ts,
        source: event,
      };
    }
    default:
      return null;
  }
}

/**
 * 动作匹配键：用于前缀树挖掘重复动作链（契约 §7 第3步）
 * - navigate：navigate|html|url
 * - click/dblclick：type|selector|elementText
 * - input：input|selector|脱敏占位（敏感值不参与区分）
 * - scroll：scroll|body|direction
 */
export function actionKey(action) {
  switch (action.type) {
    case 'navigate':
      return `navigate|html|${action.value}`;
    case 'click':
    case 'dblclick':
      return `${action.type}|${action.selector}|${action.text}`;
    case 'input':
      return `input|${action.selector}|${action.masked ? MASKED_VALUE : action.value}`;
    case 'scroll':
      return `scroll|body|${action.value}`;
    default:
      return `${action.type}|${action.selector}|${action.value}`;
  }
}

/**
 * 清洗单条会话轨迹
 * @param {object[]} events 该会话原始事件（已按 ts 升序）
 * @returns {object[]} 清洗后的动作序列（已附 key 字段）
 */
export function cleanSession(events) {
  const actions = [];
  let lastScroll = null;

  for (const event of events) {
    if (DROP_TYPES.has(event.type)) continue;
    const action = mapEventToAction(event);
    if (!action) continue;
    if (!EXECUTABLE_TYPES.has(action.type)) continue;

    // 同方向连续 scroll 合并：方向相同则丢弃后一条，方向变化才保留
    if (action.type === 'scroll') {
      if (lastScroll && lastScroll.type === 'scroll' && lastScroll.value === action.value) continue;
      lastScroll = action;
    } else {
      lastScroll = null;
    }

    // 连续跳转到同一 URL 去重，避免重复 navigate 撑长动作链
    const prev = actions[actions.length - 1];
    if (action.type === 'navigate' && prev && prev.type === 'navigate' && prev.value === action.value) {
      continue;
    }

    actions.push(action);
  }

  // 轨迹开头补一条 navigate：以会话首个事件的 URL 作为起始页（契约 §5 动作链以 navigate 起手）
  const startUrl = events[0]?.url || '';
  if (actions.length === 0) {
    if (startUrl) {
      actions.push({
        type: 'navigate',
        selector: 'html',
        value: startUrl,
        text: '',
        masked: false,
        ts: events[0].ts,
        source: events[0],
      });
    }
  } else if (actions[0].type !== 'navigate' && startUrl) {
    actions.unshift({
      type: 'navigate',
      selector: 'html',
      value: startUrl,
      text: '',
      masked: false,
      ts: events[0].ts,
      source: events[0],
    });
  }

  // 为每个动作附上匹配键
  for (const action of actions) action.key = actionKey(action);
  return actions;
}

/**
 * 批量清洗全部会话
 * @param {Map<string, object[]>} sessions 会话 id → 原始事件列表
 * @returns {{ cleaned: Map<string, object[]>, droppedSessionIds: string[] }}
 */
export function cleanAllSessions(sessions) {
  const cleaned = new Map();
  const droppedSessionIds = [];
  for (const [sessionId, events] of sessions) {
    const actions = cleanSession(events);
    if (actions.length === 0) {
      droppedSessionIds.push(sessionId);
      continue;
    }
    cleaned.set(sessionId, actions);
  }
  return { cleaned, droppedSessionIds };
}
