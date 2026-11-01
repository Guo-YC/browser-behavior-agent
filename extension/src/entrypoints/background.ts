/**
 * 模块A —— background service worker（契约 §1.1 / §1.2 / §1.3 / §1.5）。
 *
 * 职责：
 *  1. Native Messaging 长连接桥：批量发送（500ms 或 50 条）、1MB 拆包、断线指数退避重连；
 *  2. webRequest 采集 request 事件（onCompleted / onErrorOccurred），URL 参数与请求头脱敏；
 *  3. 会话管理：tab 级 sessionId、session_start / session_end、tabswitch、心跳与空闲超时；
 *  4. 接收 content script 上报的事件，补全公共字段后入队。
 */

import { defineBackground } from 'wxt/utils/define-background';
import { browser, type Browser } from 'wxt/browser';

import type {
  BatchEnvelope,
  BehaviorEvent,
  EventType,
  InternalMessage,
} from '../shared/types';
import type { ExtensionConfig } from '../shared/defaults';
import { CONFIG_STORAGE_KEY, mergeConfig } from '../shared/defaults';
import {
  buildRules,
  redactUrl,
  redactHeaders,
  redactPostBodyPreview,
  type RedactionRules,
} from '../shared/redaction';
import { getDomain, newSessionId } from '../shared/utils';

/** Native Messaging host 名称（契约 §0 / §1.1） */
const NATIVE_HOST_NAME = 'com.browser.behavior.collector';

/* ------------------------------------------------------------------ *
 * 配置与会话状态
 * ------------------------------------------------------------------ */

let config: ExtensionConfig = mergeConfig(undefined);
let rules: RedactionRules = buildRules(config.redaction);

/** 一个 tab 对应一条会话记录（契约 §1.2：tab 级 sessionId，跨导航保持） */
interface SessionRecord {
  sessionId: string;
  tabId: number;
  startedAt: number;
  /** 最近一次真实用户事件时间（用于空闲超时判定） */
  lastUserActive: number;
  /** 最近一次心跳时间（用于心跳间隔判定） */
  lastHeartbeat: number;
  url: string;
  title: string;
  domain: string;
  ended: boolean;
}

const sessions = new Map<number, SessionRecord>();

async function loadConfig(): Promise<void> {
  const stored = await browser.storage.local.get(CONFIG_STORAGE_KEY);
  config = mergeConfig(stored[CONFIG_STORAGE_KEY] as Partial<ExtensionConfig> | undefined);
  rules = buildRules(config.redaction);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[CONFIG_STORAGE_KEY]) return;
  config = mergeConfig(
    changes[CONFIG_STORAGE_KEY].newValue as Partial<ExtensionConfig> | undefined,
  );
  rules = buildRules(config.redaction);
});

/* ------------------------------------------------------------------ *
 * 事件组装与会话操作
 * ------------------------------------------------------------------ */

/** 按会话记录组装一条完整事件（契约 §1.2 公共字段） */
function buildEvent(
  type: EventType,
  rec: SessionRecord,
  detail: Record<string, unknown>,
  partial?: Partial<BehaviorEvent>,
): BehaviorEvent {
  const url = partial?.url || rec.url;
  return {
    type,
    ts: partial?.ts ?? Date.now(),
    sessionId: rec.sessionId,
    tabId: rec.tabId,
    url,
    title: partial?.title || rec.title,
    domain: partial?.domain || getDomain(url),
    detail,
  };
}

/** 取会话；不存在时为该 tab 建匿名会话（用于 webRequest 先于 content 注入到达的极端场景，不发 session_start） */
function getOrCreateSession(tabId: number, url = ''): SessionRecord {
  let rec = sessions.get(tabId);
  if (rec) return rec;
  const now = Date.now();
  rec = {
    sessionId: `s_orphan_${tabId}`,
    tabId,
    startedAt: now,
    lastUserActive: now,
    lastHeartbeat: 0,
    url,
    title: '',
    domain: getDomain(url),
    ended: false,
  };
  sessions.set(tabId, rec);
  return rec;
}

/** 处理 content script 的 get_session：首次创建会话并补发 session_start（契约 §1.3） */
function handleGetSession(
  tabId: number,
  msg: Extract<InternalMessage, { channel: 'get_session' }>,
): Promise<{ ok: boolean; sessionId: string }> {
  let rec = sessions.get(tabId);
  // webRequest 先于 content 注入到达时建立的匿名会话：content 就绪后替换为正式会话 ID
  if (rec && rec.sessionId.startsWith('s_orphan_')) {
    sessions.delete(tabId);
    rec = undefined;
  }
  if (!rec) {
    const now = Date.now();
    const screenParts = msg.screen.split('x');
    rec = {
      sessionId: newSessionId(),
      tabId,
      startedAt: now,
      lastUserActive: now,
      lastHeartbeat: 0,
      url: msg.startUrl,
      title: '',
      domain: getDomain(msg.startUrl),
      ended: false,
    };
    sessions.set(tabId, rec);
    enqueue(
      buildEvent('session_start', rec, {
        userAgent: msg.userAgent,
        screenWidth: Number.parseInt(screenParts[0] ?? '0', 10),
        screenHeight: Number.parseInt(screenParts[1] ?? '0', 10),
        startUrl: msg.startUrl,
      }),
    );
  } else {
    rec.lastUserActive = Date.now();
  }
  return Promise.resolve({ ok: true, sessionId: rec.sessionId });
}

/** 处理 content script 上报的行为事件：更新会话状态后入队 */
function handleEvent(tabId: number, msg: Extract<InternalMessage, { channel: 'event' }>): void {
  if (!config.enabled) return;
  const rec = getOrCreateSession(tabId, msg.event.url);
  rec.lastUserActive = Date.now();
  if (msg.event.url) rec.url = msg.event.url;
  if (msg.event.title) rec.title = msg.event.title;
  enqueue(buildEvent(msg.event.type, rec, msg.event.detail, msg.event));
}

/** 处理页面元信息同步（SPA 导航 / page_load 后更新会话缓存） */
function handlePageMeta(
  tabId: number,
  msg: Extract<InternalMessage, { channel: 'page_meta' }>,
): void {
  const rec = sessions.get(tabId);
  if (!rec) return;
  rec.url = msg.url;
  rec.title = msg.title;
  rec.domain = getDomain(msg.url);
}

/* ------------------------------------------------------------------ *
 * Native Messaging 桥（契约 §1.1）
 * ------------------------------------------------------------------ */

let port: Browser.runtime.Port | null = null;
/** 待发送事件队列 */
const queue: BehaviorEvent[] = [];
/** 批量信封序号 */
let seq = 0;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** 事件入队；队列超限时丢弃最旧事件，避免断连期间内存膨胀 */
function enqueue(event: BehaviorEvent): void {
  if (!config.enabled) return;
  queue.push(event);
  if (queue.length > config.maxQueuedEvents) {
    queue.splice(0, queue.length - config.maxQueuedEvents);
  }
  if (queue.length >= config.batchSize) flushQueue();
}

/** 建立 Native 长连接；断线后指数退避重连（1s → 2s → 4s … 上限 30s） */
function connectNative(): void {
  if (port) return;
  try {
    port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    port.onDisconnect.addListener(onNativeDisconnect);
    port.onMessage.addListener(onNativeMessage);
    reconnectDelay = 1000;
    if (!flushTimer) flushTimer = setInterval(flushQueue, config.batchIntervalMs);
    flushQueue();
  } catch (err) {
    console.warn('[行为采集器] Native 连接建立失败，准备退避重连：', err);
    port = null;
    scheduleReconnect();
  }
}

/** 监听 host 回复：{ok:true, received} 或 ping 的 {ok:true, pong:true} */
function onNativeMessage(message: unknown): void {
  if (message && typeof message === 'object' && 'ok' in message) {
    // 收到确认即视为链路正常；队列仍由定时器与阈值驱动，无需额外动作
    return;
  }
}

/** 连接断开：清空端口引用并安排退避重连 */
function onNativeDisconnect(): void {
  port = null;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  console.warn(
    '[行为采集器] Native 连接断开：',
    browser.runtime.lastError?.message ?? '未知原因',
  );
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(reconnectDelay, 30_000);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, delay);
}

/** 批量发送：按 1MB 上限拆包，每包一个 batch 信封（契约 §1.1） */
function flushQueue(): void {
  if (!port || queue.length === 0) return;
  while (queue.length > 0) {
    const slice: BehaviorEvent[] = [];
    let bytes = 0;
    while (queue.length > 0) {
      // 字符数 ×2 作为 UTF-8 字节的保守估计，保证不超 1MB
      const candidateBytes = JSON.stringify(queue[0]).length * 2;
      if (slice.length > 0 && bytes + candidateBytes > config.maxBatchBytes) break;
      slice.push(queue.shift()!);
      bytes += candidateBytes;
    }
    sendBatch(slice);
  }
}

function sendBatch(events: BehaviorEvent[]): void {
  if (!port) return;
  const envelope: BatchEnvelope = { type: 'batch', seq: ++seq, events };
  try {
    port.postMessage(envelope);
  } catch (err) {
    // 端口已断或缓冲区满：事件退回队列头部，等待重连后重发
    queue.unshift(...events);
    console.warn('[行为采集器] 批量消息发送失败，事件已退回队列：', err);
  }
}

/* ------------------------------------------------------------------ *
 * webRequest：request 事件采集（契约 §1.5 / §1.4 #4、#5）
 * ------------------------------------------------------------------ */

/** 请求计时、请求体预览、请求头缓存：key = `${requestId}:${tabId}` */
const requestStart = new Map<string, number>();
const requestBodyPreview = new Map<string, string>();
const requestHeadersCache = new Map<string, Browser.webRequest.HttpHeader[]>();

function requestKey(requestId: string, tabId: number): string {
  return `${requestId}:${tabId}`;
}

/** 仅采集 http(s) 页面请求；tabId < 0 为浏览器内部 / 扩展自身请求，跳过 */
function shouldTrack(details: { url: string; tabId: number }): boolean {
  if (details.tabId < 0) return false;
  return /^https?:/i.test(details.url);
}

function registerWebRequest(): void {
  // 开始计时 + 预存请求体预览（requestBody 仅在 onBeforeRequest 阶段可见）
  browser.webRequest.onBeforeRequest.addListener(
    (details): undefined => {
      if (!shouldTrack(details)) return;
      const key = requestKey(details.requestId, details.tabId);
      requestStart.set(key, Date.now());
      requestBodyPreview.set(key, redactPostBodyPreview(details.requestBody, rules));
      return undefined;
    },
    { urls: ['<all_urls>'] },
    ['requestBody'],
  );

  // 请求头仅在 onSendHeaders 阶段可见，先缓存供 onCompleted 使用（契约 §1.5 reqHeaders）
  browser.webRequest.onSendHeaders.addListener(
    (details): undefined => {
      if (!shouldTrack(details)) return;
      requestHeadersCache.set(
        requestKey(details.requestId, details.tabId),
        details.requestHeaders ?? [],
      );
      return undefined;
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders'],
  );

  browser.webRequest.onCompleted.addListener(
    (details): undefined => {
      if (!config.enabled || !shouldTrack(details)) return;
      const key = requestKey(details.requestId, details.tabId);
      const start = requestStart.get(key);
      const durationMs = start ? Date.now() - start : null;
      requestStart.delete(key);
      const bodyPreview = requestBodyPreview.get(key) ?? '';
      requestBodyPreview.delete(key);
      const reqHeaders = redactHeaders(requestHeadersCache.get(key), rules);
      requestHeadersCache.delete(key);

      const session = getOrCreateSession(details.tabId, details.url);
      session.lastUserActive = Date.now();

      enqueue(
        buildEvent(
          'request',
          session,
          {
            method: details.method,
            requestUrl: redactUrl(details.url, rules),
            status: details.statusCode,
            durationMs,
            resourceType: details.type,
            reqHeaders,
            respHeaders: redactHeaders(details.responseHeaders, rules),
            postBodyPreview: bodyPreview,
          },
          { url: details.url },
        ),
      );
      return undefined;
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  );

  browser.webRequest.onErrorOccurred.addListener(
    (details): undefined => {
      if (!config.enabled || !shouldTrack(details)) return;
      const key = requestKey(details.requestId, details.tabId);
      const start = requestStart.get(key);
      const durationMs = start ? Date.now() - start : null;
      requestStart.delete(key);
      requestBodyPreview.delete(key);
      requestHeadersCache.delete(key);

      const session = getOrCreateSession(details.tabId, details.url);
      enqueue(
        buildEvent(
          'request',
          session,
          {
            method: 'GET',
            requestUrl: redactUrl(details.url, rules),
            status: null,
            durationMs,
            resourceType: details.type,
            reqHeaders: {},
            respHeaders: {},
            postBodyPreview: '',
            error: details.error,
          },
          { url: details.url },
        ),
      );
      return undefined;
    },
    { urls: ['<all_urls>'] },
  );
}

/* ------------------------------------------------------------------ *
 * tab 事件：tabswitch / session_end（契约 §1.3）
 * ------------------------------------------------------------------ */

let prevActiveTabId = -1;

function registerTabs(): void {
  browser.tabs.onActivated.addListener(({ tabId }) => {
    if (!config.enabled) return;
    if (prevActiveTabId >= 0 && prevActiveTabId !== tabId) {
      const prev = sessions.get(prevActiveTabId);
      if (prev) enqueue(buildEvent('tabswitch', prev, { active: false }));
    }
    const current = getOrCreateSession(tabId);
    current.lastUserActive = Date.now();
    enqueue(buildEvent('tabswitch', current, { active: true }));
    prevActiveTabId = tabId;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    const rec = sessions.get(tabId);
    if (rec) {
      enqueue(buildEvent('session_end', rec, { reason: 'tab_close' }));
      sessions.delete(tabId);
    }
  });

  browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    const rec = sessions.get(removedTabId);
    if (rec) {
      enqueue(buildEvent('session_end', rec, { reason: 'replaced' }));
      sessions.delete(removedTabId);
    }
    // 新替换出的 tab 由其 content script 首次 get_session 时创建会话
    void addedTabId;
  });
}

/* ------------------------------------------------------------------ *
 * 心跳与空闲会话回收（契约 §1.3 heartbeat / §1.2 session_end idle）
 * ------------------------------------------------------------------ */

function registerSchedulers(): void {
  // 心跳：仅在空闲期按 heartbeatIntervalMs（默认 5min）周期上报 active:true，
  // 防止守护进程按 30min 空闲回收会话；活跃期不刷心跳，避免事件噪声（契约 §1.3 heartbeat）
  setInterval(() => {
    if (!config.enabled) return;
    const now = Date.now();
    for (const rec of sessions.values()) {
      if (rec.ended) continue;
      const idleMs = now - rec.lastUserActive;
      if (idleMs < config.heartbeatIntervalMs) continue;
      if (now - rec.lastHeartbeat < config.heartbeatIntervalMs) continue;
      rec.lastHeartbeat = now;
      enqueue(buildEvent('heartbeat', rec, { active: true }));
    }
  }, 30_000);

  // 空闲回收：超过 idleTimeoutMs（默认 30min）无真实用户事件 → session_end(reason='idle')
  setInterval(() => {
    const now = Date.now();
    for (const [tabId, rec] of sessions) {
      if (rec.ended) continue;
      if (now - rec.lastUserActive > config.idleTimeoutMs) {
        enqueue(buildEvent('session_end', rec, { reason: 'idle' }));
        rec.ended = true;
        sessions.delete(tabId);
      }
    }
  }, 60_000);
}

/* ------------------------------------------------------------------ *
 * 启动入口
 * ------------------------------------------------------------------ */

export default defineBackground(() => {
  void loadConfig().then(() => {
    connectNative();
    registerWebRequest();
    registerTabs();
    registerSchedulers();
  });

  // content script 消息路由
  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message.channel !== 'string') return;
    const tabId = sender.tab?.id ?? -1;
    switch (message.channel) {
      case 'get_session':
        return handleGetSession(tabId, message as Extract<InternalMessage, { channel: 'get_session' }>);
      case 'event':
        handleEvent(tabId, message as Extract<InternalMessage, { channel: 'event' }>);
        return Promise.resolve({ ok: true });
      case 'page_meta':
        handlePageMeta(tabId, message as Extract<InternalMessage, { channel: 'page_meta' }>);
        return Promise.resolve({ ok: true });
      default:
        return undefined;
    }
  });

  // service worker 唤醒时尝试重连 Native 桥（MV3 SW 可能被浏览器休眠回收）
  browser.runtime.onStartup.addListener(() => connectNative());
  browser.runtime.onInstalled.addListener(() => connectNative());
});
