/** 事件类型枚举（与 daemon 契约 docs/CONTRACTS.md §1.2 对齐） */
export type BehaviorEventType =
  | 'click' | 'dblclick' | 'mousemove' | 'mouseenter' | 'contextmenu'
  | 'input' | 'keydown' | 'scroll' | 'focus' | 'blur'
  | 'navigation' | 'tabswitch' | 'page_load' | 'page_hide'
  | 'request' | 'session_start' | 'session_end' | 'heartbeat';

/** 采集层脱敏标记的元素元信息 */
export interface ElementInfo {
  tag: string;
  id: string;
  class: string;
  text: string;
  href: string;
  role: string;
  ariaLabel: string;
  inputType: string;
  redacted: boolean;
}

/** 单条行为事件（公共字段 + 各类型 detail） */
export interface BehaviorEvent {
  type: BehaviorEventType;
  ts: number;
  sessionId: string;
  tabId: number;
  url: string;
  title: string;
  domain: string;
  detail?: Record<string, unknown>;
}
