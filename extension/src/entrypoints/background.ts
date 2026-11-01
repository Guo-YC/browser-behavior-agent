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

let config: ExtensionConfig = mergeConfig(undefined);
let rules: RedactionRules = buildRules(config.redaction);

/** 一个 tab 对应一条会话记录（契约 §1.2：tab 级 sessionId，跨导航保持） */
interface SessionRecord {
  sessionId: string;
  tabId: number;
  startedAt: number;
  lastUserActive: number;
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

function handleGetSession(
  tabId: number,
  msg: Extract<InternalMessage, { channel: 'get_session' }>,
): Promise<{ ok: boolean; sessionId: string }> {
  let rec = sessions.get(tabId);
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

function handleEvent(tabId: number, msg: Extract<InternalMessage, { channel: 'event' }>): void {
  if (!config.enabled) return;
  const rec = getOrCreateSession(tabId, msg.event.url);
  rec.lastUserActive = Date.now();
  if (msg.event.url) rec.url = msg.event.url;
  if (msg.event.title) rec.title = msg.event.title;
  enqueue(buildEvent(msg.event.type, rec, msg.event.detail, msg.event));
}

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

let port: Browser.runtime.Port | null = null;
const queue: BehaviorEvent[] = [];
let seq = 0;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function enqueue(event: BehaviorEvent): void {
  if (!config.enabled) return;
  queue.push(event);
  if (queue.length > config.maxQueuedEvents) {
    queue.splice(0, queue.length - config.maxQueuedEvents);
  }
  if (queue.length >= config.batchSize) flushQueue();
}

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

function onNativeMessage(message: unknown): void {
  if (message && typeof message === 'object' && 'ok' in message) {
    return;
  }
}

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

function flushQueue(): void {
  if (!port || queue.length === 0) return;
  while (queue.length > 0) {
    const slice: BehaviorEvent[] = [];
    let bytes = 0;
    while (queue.length > 0) {
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
    queue.unshift(...events);
    console.warn('[行为采集器] 批量消息发送失败，事件已退回队列：', err);
  }
}

const requestStart = new Map<string, number>();
const requestBodyPreview = new Map<string, string>();
const requestHeadersCache = new Map<string, Browser.webRequest.HttpHeader[]>();

function requestKey(requestId: string, tabId: number): string {
  return `${requestId}:${tabId}`;
}

function shouldTrack(details: { url: string; tabId: number }): boolean {
  if (details.tabId < 0) return false;
  return /^https?:/i.test(details.url);
}

function registerWebRequest(): void {
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
    void addedTabId;
  });
}

function registerSchedulers(): void {
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

export default defineBackground(() => {
  void loadConfig().then(() => {
    connectNative();
    registerWebRequest();
    registerTabs();
    registerSchedulers();
  });

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

  browser.runtime.onStartup.addListener(() => connectNative());
  browser.runtime.onInstalled.addListener(() => connectNative());
});
