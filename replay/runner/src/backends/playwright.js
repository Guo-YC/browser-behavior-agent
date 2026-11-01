// 模块E：Playwright 后端（依据 CONTRACTS.md §6；经 playwright-core 连接本机 9222 端口 Chrome）
// 复用本机已启动的 Chrome（--remote-debugging-port=9222），不下载浏览器。
import { chromium } from 'playwright-core';
import { Backend } from './base.js';

/**
 * Playwright 后端：通过 playwright-core 的 connectOverCDP 复用 9222 调试端口。
 */
export class PlaywrightBackend extends Backend {
  constructor({ port = 9222, host = '127.0.0.1', headless = false } = {}) {
    super();
    this.mode = 'playwright';
    this.port = port;
    this.host = host;
    this.headless = headless;
    this.browser = null;
    this.page = null;
  }

  async connect() {
    try {
      this.browser = await chromium.connectOverCDP(`http://${this.host}:${this.port}`);
      const contexts = this.browser.contexts();
      const context = contexts[0] || (await this.browser.newContext());
      const pages = context.pages();
      this.page = pages[0] || (await context.newPage());
    } catch (err) {
      throw new Error(
        `无法通过 playwright-core 连接 Chrome 调试端口 ${this.host}:${this.port}。请先以 --remote-debugging-port=${this.port} 启动 Chrome。原因：${err.message}`
      );
    }
  }

  async close() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
      this.page = null;
    }
  }

  async precheck(action) {
    if (action.type === 'navigate' && !/^https?:\/\//.test(action.value || '')) {
      return { pass: false, message: `步骤 ${action.step} navigate 目标非法：${action.value}` };
    }
    if ((action.type === 'click' || action.type === 'dblclick' || action.type === 'hover') && !action.selector) {
      return { pass: false, message: `步骤 ${action.step} ${action.type} 缺少选择器` };
    }
    if (action.type === 'input' && (!action.selector || !action.value)) {
      return { pass: false, message: `步骤 ${action.step} input 缺少选择器或输入值` };
    }
    return { pass: true, message: '' };
  }

  async run(action) {
    const page = this.page;
    switch (action.type) {
      case 'navigate': {
        await page.goto(action.value, { waitUntil: 'domcontentloaded', timeout: 15000 });
        return { pass: true, message: `导航到 ${action.value}` };
      }
      case 'click': {
        await page.click(action.selector, { timeout: 8000 });
        return { pass: true, message: `点击 ${action.selector}` };
      }
      case 'dblclick': {
        await page.dblclick(action.selector, { timeout: 8000 });
        return { pass: true, message: `双击 ${action.selector}` };
      }
      case 'input': {
        await page.fill(action.selector, action.value);
        return { pass: true, message: `输入 ${action.value}` };
      }
      case 'scroll': {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel || 'body');
          el?.scrollBy({ top: 400, behavior: 'auto' });
        }, action.selector || 'body');
        return { pass: true, message: `滚动（${action.value || 'down'}）` };
      }
      case 'hover': {
        await page.hover(action.selector, { timeout: 8000 });
        return { pass: true, message: `悬停 ${action.selector}` };
      }
      case 'wait': {
        await page.waitForTimeout(Math.max(0, action.waitMs || 0));
        return { pass: true, message: `等待 ${action.waitMs || 0}ms` };
      }
      case 'assert': {
        return { pass: true, message: '断言步骤（由断言求值器处理）' };
      }
      default:
        return { pass: false, message: `未知动作类型：${action.type}` };
    }
  }

  async getUrl() {
    return this.page.url();
  }

  async getText(selector) {
    const locator = this.page.locator(selector).first();
    return (await locator.textContent().catch(() => '')) || '';
  }

  async isPresent(selector) {
    const locator = this.page.locator(selector).first();
    return (await locator.count()) > 0 && (await locator.isVisible().catch(() => false));
  }
}
