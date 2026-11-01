/**
 * 事件协议类型定义（唯一事实源：docs/CONTRACTS.md §1）。
 * content script、background service worker、options 页共用本文件。
 */

/** 契约 §1.2 允许的全部事件类型 */
export type EventType =
  | 'click'
  | 'dblclick'
  | 'contextmenu'
  | 'mousemove'
  | 'mouseenter'
  | 'input'
  | 'keydown'
  | 'scroll'
  | 'focus'
  | 'blur'
  | 'navigation'
  | 'tabswitch'
  | 'page_load'
  | 'page_hide'
  | 'request'
  | 'session_start'
  | 'session_end'
  | 'heartbeat';

/** 契约 §1.3 element 对象：选择器相关元信息，text ≤200 字符 */
export interface ElementMeta {
  tag: string;
  id: string;
  class: string;
  text: string;
  href: string;
  role: string;
  ariaLabel: string;
  inputType: string;
  /** 命中 §1.4 敏感规则时为 true，此时 value/key 已硬丢弃为 **** */
  redacted: boolean;
}

/** 契约 §1.2 事件公共字段 */
export interface CommonFields {
  type: EventType;
  ts: number;
  sessionId: string;
  tabId: number;
  url: string;
  title: string;
  domain: string;
}

/** 一条完整行为事件（公共字段 + detail） */
export interface BehaviorEvent extends CommonFields {
  detail: Record<string, unknown>;
}

/** 契约 §1.1 批量消息信封 */
export interface BatchEnvelope {
  type: 'batch';
  seq: number;
  events: BehaviorEvent[];
}

/**
 * content script → background 的内部消息。
 * background 负责补全 sessionId / tabId / ts / domain 等公共字段后入队。
 */
export type InternalMessage =
  | { channel: 'event'; event: Partial<BehaviorEvent> & { type: EventType; detail: Record<string, unknown> } }
  | {
      channel: 'get_session';
      startUrl: string;
      userAgent: string;
      screen: string;
    }
  | { channel: 'page_meta'; url: string; title: string };

/** get_session 的回复 */
export interface GetSessionReply {
  ok: boolean;
  sessionId: string;
}
