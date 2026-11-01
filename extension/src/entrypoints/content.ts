/**
 * 模块A —— content script 行为采集器（契约 §1.2 / §1.3 / §1.4）。
 *
 * 职责：
 *  1. 在页面内监听交互事件，生成符合 §1.2/§1.3 协议的事件并上报 background；
 *  2. 在采集层执行 §1.4 敏感规则（密码框 / 敏感属性输入框的值与按键硬丢弃）；
 *  3. 拦截 SPA 导航（pushState / replaceState / hashchange / popstate）发 navigation 事件；
 *  4. 上报页面加载 / 隐藏生命周期事件。
 *
 * 注意：copy / paste 按契约 §1.4 #3 不进入事件流，本脚本未注册对应监听。
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { finder } from '@medv/finder';

import type { BehaviorEvent, ElementMeta, EventType, InternalMessage } from '../shared/types';
import type { ExtensionConfig } from '../shared/defaults';
import { CONFIG_STORAGE_KEY, mergeConfig } from '../shared/defaults';
import {
  buildRules,
  isSensitiveElement,
  buildElementMeta,
  maskInputValue,
  maskKey,
  type RedactionRules,
} from '../shared/redaction';
import { getDomain, throttle } from '../shared/utils';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: false,
  main() {
    void bootstrap();
  },
});

let config: ExtensionConfig = mergeConfig(undefined);
let rules: RedactionRules = buildRules(config.redaction);
let sessionId = '';
let lastScrollY = window.scrollY;

async function loadConfig(): Promise<void> {
  const stored = await browser.storage.local.get(CONFIG_STORAGE_KEY);
  config = mergeConfig(
    stored[CONFIG_STORAGE_KEY] as Partial<ExtensionConfig> | undefined,
  );
  rules = buildRules(config.redaction);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[CONFIG_STORAGE_KEY]) return;
  config = mergeConfig(
    changes[CONFIG_STORAGE_KEY].newValue as Partial<ExtensionConfig> | undefined,
  );
  rules = buildRules(config.redaction);
});

async function ensureSession(): Promise<void> {
  if (sessionId) return;
  try {
    const reply = await browser.runtime.sendMessage<InternalMessage, { ok: boolean; sessionId: string }>({
      channel: 'get_session',
      startUrl: location.href,
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height}`,
    });
    sessionId = reply?.sessionId ?? '';
  } catch {
    sessionId = '';
  }
}

function emit(type: EventType, detail: Record<string, unknown>, element?: ElementMeta): void {
  if (!config.enabled) return;
  if (!sessionId) void ensureSession();

  const event: Partial<BehaviorEvent> & { type: EventType; detail: Record<string, unknown> } = {
    type,
    ts: Date.now(),
    sessionId,
    tabId: -1,
    url: location.href,
    title: document.title,
    domain: getDomain(location.href),
    detail,
  };
  if (element) {
    detail.element = element;
  }

  browser.runtime
    .sendMessage({ channel: 'event', event } satisfies InternalMessage)
    .catch(() => {
      // 队列已满或 SW 唤醒失败时丢弃该条，避免阻塞页面
    });
}

function syncPageMeta(): void {
  browser.runtime
    .sendMessage({
      channel: 'page_meta',
      url: location.href,
      title: document.title,
    } satisfies InternalMessage)
    .catch(() => undefined);
}

function inspectTarget(target: EventTarget | null): {
  selector: string;
  meta: ElementMeta | null;
  sensitive: boolean;
} {
  const el = target instanceof Element ? target : null;
  if (!el) return { selector: '', meta: null, sensitive: false };

  const sensitive = isSensitiveElement(el, rules);
  const meta = buildElementMeta(el, sensitive);
  let selector = '';
  try {
    selector = finder(el, { root: document.body, timeoutMs: 1000 });
  } catch {
    selector = '';
  }
  return { selector, meta, sensitive };
}

function registerPointerEvents(): void {
  const onClick = (e: MouseEvent) => {
    const { selector, meta } = inspectTarget(e.target);
    emit(e.type === 'contextmenu' ? 'contextmenu' : 'click', {
      selector,
      button: e.button,
      clientX: e.clientX,
      clientY: e.clientY,
    }, meta ?? undefined);
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('contextmenu', onClick, true);

  document.addEventListener('dblclick', (e: MouseEvent) => {
    const { selector, meta } = inspectTarget(e.target);
    emit('dblclick', {
      selector,
      button: e.button,
      clientX: e.clientX,
      clientY: e.clientY,
    }, meta ?? undefined);
  }, true);
}

function registerMouseMove(): void {
  const throttled = throttle(500, (e: MouseEvent) => {
    if (!config.sampleMousemove) return;
    const { selector } = inspectTarget(e.target);
    emit('mousemove', { selector, clientX: e.clientX, clientY: e.clientY });
  });
  document.addEventListener('mousemove', throttled, true);
}

function registerMouseEnter(): void {
  const throttled = throttle(1000, (e: MouseEvent) => {
    const over = e.target;
    const related = e.relatedTarget;
    if (related instanceof Node && over instanceof Node && over.contains(related)) return;
    const { selector, meta } = inspectTarget(over);
    emit('mouseenter', { selector }, meta ?? undefined);
  });
  document.addEventListener('mouseover', throttled, true);
}

function registerInput(): void {
  document.addEventListener(
    'input',
    (e: Event) => {
      const el = e.target;
      if (
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement) &&
        !(el instanceof HTMLSelectElement)
      ) {
        return;
      }
      const { selector, meta, sensitive } = inspectTarget(el);
      emit('input', {
        selector,
        inputType: el.type || el.tagName.toLowerCase(),
        value: maskInputValue(el.value, sensitive),
      }, meta ?? undefined);
    },
    true,
  );
}

function registerKeydown(): void {
  document.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      const { selector, meta, sensitive } = inspectTarget(e.target);
      emit('keydown', {
        selector,
        key: maskKey(e.key, sensitive),
        code: sensitive ? '****' : e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      }, meta ?? undefined);
    },
    true,
  );
}

function registerScroll(): void {
  const throttled = throttle(200, () => {
    if (!config.sampleScroll) return;
    const y = window.scrollY;
    const direction = y > lastScrollY ? 'down' : y < lastScrollY ? 'up' : 'none';
    lastScrollY = y;
    emit('scroll', {
      scrollX: window.scrollX,
      scrollY: y,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: window.innerHeight,
      direction,
    });
  });
  window.addEventListener('scroll', throttled, true);
}

function registerFocusBlur(): void {
  document.addEventListener(
    'focusin',
    (e: FocusEvent) => {
      const { selector, meta } = inspectTarget(e.target);
      emit('focus', { selector }, meta ?? undefined);
    },
    true,
  );
  document.addEventListener(
    'focusout',
    (e: FocusEvent) => {
      const { selector, meta } = inspectTarget(e.target);
      emit('blur', { selector }, meta ?? undefined);
    },
    true,
  );
}

function emitNavigation(transitionType: string): void {
  emit('navigation', {
    url: location.href,
    title: document.title,
    transitionType,
  });
  syncPageMeta();
}

function hookSpaNavigation(): void {
  const pushState = history.pushState;
  history.pushState = function patchedPushState(...args: Parameters<typeof pushState>) {
    const result = pushState.apply(this, args);
    emitNavigation('pushState');
    return result;
  };
  const replaceState = history.replaceState;
  history.replaceState = function patchedReplaceState(...args: Parameters<typeof replaceState>) {
    const result = replaceState.apply(this, args);
    emitNavigation('replaceState');
    return result;
  };

  window.addEventListener('hashchange', () => emitNavigation('hashchange'));
  window.addEventListener('popstate', () => emitNavigation('popstate'));
}

function reportPageLoad(): void {
  emit('page_load', { referrer: document.referrer, title: document.title });
  syncPageMeta();
}

function registerPageHide(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') emit('page_hide', {});
  });
  window.addEventListener('pagehide', () => emit('page_hide', {}));
  window.addEventListener('beforeunload', () => emit('page_hide', {}));
}

async function bootstrap(): Promise<void> {
  await loadConfig();
  await ensureSession();

  registerPointerEvents();
  registerMouseMove();
  registerMouseEnter();
  registerInput();
  registerKeydown();
  registerScroll();
  registerFocusBlur();
  hookSpaNavigation();
  registerPageHide();

  if (document.readyState !== 'loading') {
    reportPageLoad();
  } else {
    window.addEventListener('load', reportPageLoad);
  }

  browser.storage.onChanged.addListener(() => {
    if (!sessionId) void ensureSession();
  });
}
