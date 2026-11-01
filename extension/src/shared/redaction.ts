/**
 * 敏感字段硬丢弃模块（契约 §1.4）。
 * 规则在采集层强制执行，敏感值绝不以原文进入事件流。
 */

import type { Browser } from 'wxt/browser';
import type { ElementMeta } from './types';
import { compilePatterns, matchesAny, truncate } from './utils';

/** 脱敏占位符（契约 §1.4 #1） */
export const MASK = '****';

/** 编译后的脱敏规则 */
export interface RedactionRules {
  enabled: boolean;
  patterns: RegExp[];
  dropHeaders: Set<string>;
  dropUrlParams: Set<string>;
}

/** 根据配置构建规则对象 */
export function buildRules(cfg: {
  enabled: boolean;
  sensitivePatterns: string[];
  dropHeaders: string[];
  dropUrlParams: string[];
}): RedactionRules {
  return {
    enabled: cfg.enabled,
    patterns: compilePatterns(cfg.sensitivePatterns),
    dropHeaders: new Set(cfg.dropHeaders.map((h) => h.toLowerCase())),
    dropUrlParams: new Set(cfg.dropUrlParams.map((p) => p.toLowerCase())),
  };
}

/** 判断 DOM 元素是否命中敏感规则 */
export function isSensitiveElement(el: Element | null, rules: RedactionRules): boolean {
  if (!el || !rules.enabled) return false;
  if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'password') return true;
  const attrs: Array<string | null> = [
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('autocomplete'),
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
  ];
  return matchesAny(rules.patterns, attrs.find((a) => a));
}

/** 构建契约 §1.3 element 对象 */
export function buildElementMeta(el: Element | null, redacted: boolean, maxText = 200): ElementMeta {
  const meta: ElementMeta = {
    tag: '',
    id: '',
    class: '',
    text: '',
    href: '',
    role: '',
    ariaLabel: '',
    inputType: '',
    redacted,
  };
  if (!el) return meta;
  meta.tag = el.tagName.toLowerCase();
  meta.id = el.getAttribute('id') ?? '';
  meta.class = el.getAttribute('class') ?? '';
  meta.text = truncate(el.textContent ?? '', maxText).replace(/\s+/g, ' ').trim();
  meta.role = el.getAttribute('role') ?? '';
  meta.ariaLabel = el.getAttribute('aria-label') ?? '';
  if (el instanceof HTMLAnchorElement) meta.href = el.getAttribute('href') ?? '';
  if (el instanceof HTMLInputElement) meta.inputType = el.type;
  else if (el instanceof HTMLTextAreaElement) meta.inputType = 'textarea';
  else if (el instanceof HTMLSelectElement) meta.inputType = 'select';
  return meta;
}

/** 脱敏输入值：敏感元素返回 ****，否则截断到 max 字符 */
export function maskInputValue(raw: string, redacted: boolean, max = 500): string {
  if (redacted) return MASK;
  return truncate(raw, max);
}

/** 脱敏按键：敏感元素返回 **** */
export function maskKey(raw: string, redacted: boolean): string {
  return redacted ? MASK : raw;
}

/** 脱敏请求 URL（契约 §1.4 #4） */
export function redactUrl(url: string, rules: RedactionRules): string {
  if (!rules.enabled) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(parsed.protocol)) return url;
  let changed = false;
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (rules.dropUrlParams.has(key.toLowerCase())) {
      parsed.searchParams.set(key, MASK);
      changed = true;
    }
  }
  return changed ? parsed.toString() : url;
}

/** 已脱敏请求头集合 */
export type HeaderMap = Record<string, string>;

/** 剥离敏感请求头（契约 §1.4 #5） */
export function redactHeaders(
  headers: Browser.webRequest.HttpHeader[] | undefined,
  rules: RedactionRules,
): HeaderMap {
  const out: HeaderMap = {};
  if (!headers) return out;
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (rules.enabled && rules.dropHeaders.has(name)) continue;
    if (h.value !== undefined) out[h.name] = h.value;
  }
  return out;
}

/** 与 webRequest.requestBody 结构对齐的本地类型 */
export interface RequestBodyLike {
  error?: string;
  formData?: Record<string, unknown[]>;
  raw?: Array<{ bytes?: ArrayBuffer }>;
}

/** 生成 postBodyPreview（契约 §1.5）：仅 JSON/表单截取 ≤1KB；含敏感字段名整段置 **** */
export function redactPostBodyPreview(
  raw: RequestBodyLike | undefined,
  rules: RedactionRules,
  maxBytes = 1024,
): string {
  if (!raw || !raw.raw || raw.raw.length === 0) return '';
  const chunks: string[] = [];
  let total = 0;
  for (const part of raw.raw) {
    if (!part.bytes) continue;
    const text = decodeBytes(part.bytes);
    if (text === null) return '';
    chunks.push(text);
    total += text.length;
    if (total >= maxBytes) break;
  }
  let body = chunks.join('').slice(0, maxBytes);
  if (rules.enabled) {
    if (looksLikeJson(body) && jsonHasSensitiveKey(body, rules)) return MASK;
    if (looksLikeForm(body) && formHasSensitiveKey(body, rules)) return MASK;
  }
  return body;
}

function decodeBytes(bytes: ArrayBuffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[');
}

function looksLikeForm(text: string): boolean {
  return /^[a-zA-Z0-9_\-\[\]]+=[^&]*(&[a-zA-Z0-9_\-\[\]]+=[^&]*)*$/.test(text.trim());
}

function jsonHasSensitiveKey(text: string, rules: RedactionRules): boolean {
  try {
    const obj = JSON.parse(text);
    return walkObject(obj);
  } catch {
    return /
"([^"]*(?:passw|pwd|token|secret|api[_-]?key|apikey|credit|card|cvv|cvc|pin|auth|session[_-]?id|ssn)[^"]*)"\s*:/i.test(
      text,
    );
  }
  function walkObject(node: unknown): boolean {
    if (node === null || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(walkObject);
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (matchesAny(rules.patterns, k)) return true;
      if (walkObject(v)) return true;
    }
    return false;
  }
}

function formHasSensitiveKey(text: string, rules: RedactionRules): boolean {
  return text
    .split('&')
    .map((pair) => pair.split('=')[0] ?? '')
    .some((key) => matchesAny(rules.patterns, decodeURIComponentSafe(key)));
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
