/**
 * 敏感字段硬丢弃模块（契约 §1.4）。
 *
 * 规则在采集层强制执行，敏感值绝不以原文进入事件流：
 *  1. type=password 的输入框 → value/key 一律 "****"，element.redacted=true；
 *  2. name/id/autocomplete/aria-label/placeholder 命中正则 → 同上；
 *  3. copy/paste 不进事件流（由 content script 直接跳过，不在这里处理）；
 *  4. 请求 URL 中 token/access_token/signature/key/secret 等参数值 → "****"；
 *  5. 请求头 authorization/cookie/set-cookie/proxy-authorization/x-api-key/
 *     x-auth-token/x-csrf-token 整头剥离；
 *  6. 规则列表来自可配置项（options 页可开关/追加），默认全部开启。
 */

import type { Browser } from 'wxt/browser';
import type { ElementMeta } from './types';
import { compilePatterns, matchesAny, truncate } from './utils';

/** 脱敏占位符（契约 §1.4 #1：value/key 一律 "****"） */
export const MASK = '****';

/** 编译后的脱敏规则（由 background / content 初始化时根据配置构建） */
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

/**
 * 判断 DOM 元素是否命中敏感规则。
 * 检查顺序：type=password → name/id/autocomplete/aria-label/placeholder 正则。
 */
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

/**
 * 构建契约 §1.3 element 对象。
 * @param el 目标 DOM 元素
 * @param redacted 是否已判定为敏感元素
 * @param maxText 文本截断长度（默认 200，契约 §1.3）
 */
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

/** 脱敏输入值：敏感元素返回 ****，否则截断到 max 字符（契约 §1.3：value ≤500） */
export function maskInputValue(raw: string, redacted: boolean, max = 500): string {
  if (redacted) return MASK;
  return truncate(raw, max);
}

/** 脱敏按键：敏感元素返回 ****（契约 §1.3 keydown：密码框 key 置 "****"） */
export function maskKey(raw: string, redacted: boolean): string {
  return redacted ? MASK : raw;
}

/**
 * 脱敏请求 URL（契约 §1.4 #4）：命中参数名的查询参数值置 ****，其余原样保留。
 * 非 http(s) 或解析失败时原样返回。
 */
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

/** 已脱敏请求头集合（契约 §1.3：reqHeaders/respHeaders 为已脱敏对象） */
export type HeaderMap = Record<string, string>;

/**
 * 剥离敏感请求头（契约 §1.4 #5）：命中规则的头整头不放入结果；
 * 其余头原样保留。
 */
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

/** 与 webRequest.requestBody 结构对齐的本地类型（WXT 类型中该对象为内联匿名类型） */
export interface RequestBodyLike {
  error?: string;
  formData?: Record<string, unknown[]>;
  raw?: Array<{ bytes?: ArrayBuffer }>;
}

/**
 * 生成 postBodyPreview（契约 §1.5）：
 * - 仅当 requestBody.raw 存在且为 JSON / 表单时截取 ≤1KB 前缀；
 * - 含敏感字段名则整段置 ****；
 * - 非文本（二进制）不采集，返回空串。
 */
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
    if (text === null) return ''; // 二进制内容不采集
    chunks.push(text);
    total += text.length;
    if (total >= maxBytes) break;
  }
  let body = chunks.join('').slice(0, maxBytes);

  if (rules.enabled) {
    // JSON 字段名 / 表单键名命中敏感正则 → 整段置 ****
    if (looksLikeJson(body) && jsonHasSensitiveKey(body, rules)) return MASK;
    if (looksLikeForm(body) && formHasSensitiveKey(body, rules)) return MASK;
  }
  return body;
}

/** 尝试把 ArrayBuffer 解码为 UTF-8 文本；二进制返回 null */
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

/** JSON 文本中是否出现敏感字段名（键名匹配任一敏感正则） */
function jsonHasSensitiveKey(text: string, rules: RedactionRules): boolean {
  try {
    const obj = JSON.parse(text);
    return walkObject(obj);
  } catch {
    // 截断导致 JSON 不完整：退化为扫描键名模式
    return /"([^"]*(?:passw|pwd|token|secret|api[_-]?key|apikey|credit|card|cvv|cvc|pin|auth|session[_-]?id|ssn)[^"]*)"\s*:/i.test(
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

/** 表单键名是否命中敏感规则 */
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
