/**
 * options 页脚本：读取 / 写入 chrome.storage.local 中的采集配置（契约 §1.4 #6：规则可配置）。
 * 文案与状态提示全部为中文。
 */

import { browser } from 'wxt/browser';
import {
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  DEFAULT_DROP_HEADERS,
  DEFAULT_DROP_URL_PARAMS,
  DEFAULT_SENSITIVE_PATTERN,
  mergeConfig,
  type ExtensionConfig,
} from '../../shared/defaults';

/** 按 id 取控件，类型断言辅助函数 */
function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const statusEl = $<HTMLSpanElement>('status');

/** 在状态栏显示中文提示，error=true 时用红色 */
function showStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

/** 从存储读取配置并回填表单 */
async function loadConfig(): Promise<void> {
  const stored = await browser.storage.local.get(CONFIG_STORAGE_KEY);
  const cfg = mergeConfig(stored[CONFIG_STORAGE_KEY] as Partial<ExtensionConfig> | undefined);

  $<HTMLInputElement>('enabled').checked = cfg.enabled;
  $<HTMLInputElement>('sampleMousemove').checked = cfg.sampleMousemove;
  $<HTMLInputElement>('sampleScroll').checked = cfg.sampleScroll;
  $<HTMLTextAreaElement>('patterns').value = cfg.redaction.sensitivePatterns.join('\n');
  $('dropHeaders').textContent = cfg.redaction.dropHeaders.join('、');
  $('dropUrlParams').textContent = cfg.redaction.dropUrlParams.join('、');
}

/** 校验正则文本：逐条编译，返回错误信息列表（空数组表示全部合法） */
function validatePatterns(lines: string[]): string[] {
  const errors: string[] = [];
  lines.forEach((src, index) => {
    try {
      new RegExp(src, 'i');
    } catch (err) {
      errors.push(`第 ${index + 1} 行正则无效：${src}（${(err as Error).message}）`);
    }
  });
  return errors;
}

/** 保存表单内容到存储 */
async function saveConfig(): Promise<void> {
  const stored = await browser.storage.local.get(CONFIG_STORAGE_KEY);
  const cfg = mergeConfig(stored[CONFIG_STORAGE_KEY] as Partial<ExtensionConfig> | undefined);

  const patternLines = $<HTMLTextAreaElement>('patterns').value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const errors = validatePatterns(patternLines);
  if (errors.length > 0) {
    showStatus(errors.join('；'), true);
    return;
  }

  cfg.enabled = $<HTMLInputElement>('enabled').checked;
  cfg.sampleMousemove = $<HTMLInputElement>('sampleMousemove').checked;
  cfg.sampleScroll = $<HTMLInputElement>('sampleScroll').checked;
  // 规则为空时回落到默认规则，避免误关导致脱敏失效
  cfg.redaction.sensitivePatterns =
    patternLines.length > 0 ? patternLines : [DEFAULT_SENSITIVE_PATTERN];

  await browser.storage.local.set({ [CONFIG_STORAGE_KEY]: cfg });
  showStatus('已保存，配置即时生效。');
}

/** 表单恢复默认值（仅回填，不立即写入，点“保存设置”后生效） */
function resetForm(): void {
  $<HTMLInputElement>('enabled').checked = DEFAULT_CONFIG.enabled;
  $<HTMLInputElement>('sampleMousemove').checked = DEFAULT_CONFIG.sampleMousemove;
  $<HTMLInputElement>('sampleScroll').checked = DEFAULT_CONFIG.sampleScroll;
  $<HTMLTextAreaElement>('patterns').value =
    DEFAULT_CONFIG.redaction.sensitivePatterns.join('\n');
  $('dropHeaders').textContent = DEFAULT_DROP_HEADERS.join('、');
  $('dropUrlParams').textContent = DEFAULT_DROP_URL_PARAMS.join('、');
  showStatus('已恢复默认规则，请点击“保存设置”生效。');
}

$<HTMLButtonElement>('save').addEventListener('click', () => {
  void saveConfig();
});
$<HTMLButtonElement>('reset').addEventListener('click', resetForm);

void loadConfig();
