/**
 * options 页脚本：读取 / 写入 chrome.storage.local 中的采集配置（契约 §1.4 #6）。
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

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const statusEl = $<HTMLSpanElement>('status');

function showStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

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
  cfg.redaction.sensitivePatterns =
    patternLines.length > 0 ? patternLines : [DEFAULT_SENSITIVE_PATTERN];

  await browser.storage.local.set({ [CONFIG_STORAGE_KEY]: cfg });
  showStatus('已保存，配置即时生效。');
}

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
