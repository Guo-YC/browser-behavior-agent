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
  // 静态声明匹配全部 http(s) 页面（契约 §1.5 要求 host_permissions <all_urls>）
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: false,
  main() {
    void bootstrap();
  },
});

/* ------------------------------------------------------------------ *
 * 运行时状态
 * ------------------------------------------------------------------ */

let config: ExtensionConfig = mergeConfig(undefined);
let rules: RedactionRules = buildRules(config.redaction);
/** 本 tab 会话 ID（background 在 get_session 时分配，跨导航保持，契约 §1.2） */
let sessionId = '';
/** 滚动方向判断用的上一次纵坐标 */
let lastScrollY = window.scrollY;

/* ------------------------------------------------------------------ *
 * 配置加载与热更新
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * 会话与事件上报
 * ------------------------------------------------------------------ */

/** 首次注入时向 background 申请本 tab 的 sessionId（background 负责补发 session_start） */
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
    // background 未就绪（扩展刚加载、SW 休眠唤醒中）时静默失败，下一次事件再重试
    sessionId = '';
  }
}

/** 组装一条事件并发送给 background（background 补全 / 校验公共字段后入队） */
function emit(type: EventType, detail: Record<string, unknown>, element?: ElementMeta): void {
  if (!config.enabled) return;
  // 首次注入时 background 尚未就绪导致会话为空：后台静默重试，下一条事件即可带上 sessionId
  if (!sessionId) void ensureSession();

  const event: Partial<BehaviorEvent> & { type: EventType; detail: Record<string, unknown> } = {
    type,
    ts: Date.now(),
    sessionId,
    tabId: -1, // 由 background 根据 sender.tab.id 覆盖
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

/** 同步当前页面 URL / 标题给 background（更新会话缓存，用于 request / tabswitch 事件取公共字段） */
function syncPageMeta(): void {
  browser.runtime
    .sendMessage({
      channel: 'page_meta',
      url: location.href,
      title: document.title,
    } satisfies InternalMessage)
    .catch(() => undefined);
}

/** 解析事件目标元素：生成稳定选择器 + element 元信息 + 敏感判定 */
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
    // @medv/finder：生成页面内唯一、结构稳定的 CSS 选择器（契约 §1 任务要求）
    selector = finder(el, { root: document.body, timeoutMs: 1000 });
  } catch {
    selector = '';
  }
  return { selector, meta, sensitive };
}

/* ------------------------------------------------------------------ *
 * 交互事件监听
 * ------------------------------------------------------------------ */

/** 鼠标主/中/右键事件：click / dblclick / contextmenu，detail 带 button 与坐标（契约 §1.3） */
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

/** mousemove：节流 ≥500ms/条/页（契约 §1.3）；总开关 sampleMousemove 关闭则不采集 */
function registerMouseMove(): void {
  const throttled = throttle(500, (e: MouseEvent) => {
    if (!config.sampleMousemove) return;
    const { selector } = inspectTarget(e.target);
    emit('mousemove', { selector, clientX: e.clientX, clientY: e.clientY });
  });
  document.addEventListener('mousemove', throttled, true);
}

/** mouseenter：事件本身不冒泡，用 mouseover + relatedTarget 判定模拟；节流 ≥1s/条/页 */
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

/** input：输入框内容，value ≤500 字符；敏感元素硬丢弃为 ****（契约 §1.3 / §1.4） */
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

/** keydown：按键；密码框 / 敏感框 key 置 ****（契约 §1.3 keydown / §1.4 #1） */
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

/** scroll：节流 ≥200ms/条/页；记录方向；sampleScroll 关闭则不采集 */
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

/** focus / blur：用冒泡版 focusin / focusout 代理采集（契约 §1.3） */
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

/* ------------------------------------------------------------------ *
 * SPA 导航与页面生命周期
 * ------------------------------------------------------------------ */

/** 发 navigation 事件并同步页面元信息（契约 §1.3 navigation：pushState/hashchange 也发） */
function emitNavigation(transitionType: string): void {
  emit('navigation', {
    url: location.href,
    title: document.title,
    transitionType,
  });
  syncPageMeta();
}

/** 拦截 history.pushState / replaceState，并监听 hashchange / popstate */
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

/** page_load：新文档加载完成，detail {referrer, title}（契约 §1.3） */
function reportPageLoad(): void {
  emit('page_load', { referrer: document.referrer, title: document.title });
  syncPageMeta();
}

/** page_hide：页面隐藏 / 卸载（契约 §1.3） */
function registerPageHide(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') emit('page_hide', {});
  });
  window.addEventListener('pagehide', () => emit('page_hide', {}));
  window.addEventListener('beforeunload', () => emit('page_hide', {}));
}

/* ------------------------------------------------------------------ *
 * 启动入口
 * ------------------------------------------------------------------ */

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

  // 若脚本注入时文档已加载完成（如扩展安装后刷新前打开的页面），补发一次 page_load；
  // document_start 注入的常规场景等待 window load 事件。
  if (document.readyState !== 'loading') {
    reportPageLoad();
  } else {
    window.addEventListener('load', reportPageLoad);
  }

  // 配置热更新后再次尝试拿到 sessionId（首次启动时 background 可能尚未就绪）
  browser.storage.onChanged.addListener(() => {
    if (!sessionId) void ensureSession();
  });
}
