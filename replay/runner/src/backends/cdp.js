// 模块E：CDP 后端（依据 CONTRACTS.md §6；经 chrome-remote-interface 连本机 9222 端口 Chrome）
// 复用本机已以 --remote-debugging-port=9222 启动的 Chrome，不下载浏览器。
import CDP from 'chrome-remote-interface';
import { Backend } from './base.js';

/** 等待指定毫秒 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 由选择器生成一段注入页面、返回元素信息的脚本 */
function elementEvalScript(selector) {
  return `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return {
        found: true,
        tag: el.tagName,
        text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 200),
        visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    })()
  `;
}

/**
 * CDP 后端：通过 chrome-remote-interface 与 Chrome 9222 调试端口通信。
 */
export class CdpBackend extends Backend {
  constructor({ port = 9222, host = '127.0.0.1' } = {}) {
    super();
    this.mode = 'cdp';
    this.port = port;
    this.host = host;
    this.client = null;
  }

  async connect() {
    try {
      this.client = await CDP({ host: this.host, port: this.port });
      const { Page, Runtime } = this.client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      // 优先取第一个可用页面上下文
      const { result } = await Runtime.evaluate({ expression: 'window.location.href', returnByValue: true });
      this.currentUrl = result?.value || '';
    } catch (err) {
      throw new Error(
        `无法连接 Chrome 调试端口 ${this.host}:${this.port}。请先以 --remote-debugging-port=${this.port} 启动 Chrome。原因：${err.message}`
      );
    }
  }

  async close() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {}
      this.client = null;
    }
  }

  async precheck(action) {
    // CDP 后端也做基础合法性预检（复用 dry-run 规则中的关键项）
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
    const { Runtime, Page } = this.client;
    switch (action.type) {
      case 'navigate': {
        await Page.navigate({ url: action.value });
        await new Promise((resolve) => setTimeout(resolve, 800));
        const { result } = await Runtime.evaluate({ expression: 'window.location.href', returnByValue: true });
        this.currentUrl = result?.value || action.value;
        return { pass: true, message: `导航到 ${action.value}` };
      }
      case 'click':
      case 'dblclick': {
        const evalRes = await this.evalElementInfo(action.selector);
        if (!evalRes.found) return { pass: false, message: `元素 ${action.selector} 未找到` };
        const clickType = action.type === 'click' ? 'click' : 'dblclick';
        const expression = `
          (() => {
            const el = document.querySelector(${JSON.stringify(action.selector)});
            if (!el) return false;
            el.${clickType}();
            return true;
          })()
        `;
        const { result } = await Runtime.evaluate({ expression, returnByValue: true });
        return result?.value ? { pass: true, message: `${clickType} ${action.selector}` } : { pass: false, message: `无法触发 ${clickType}` };
      }
      case 'input': {
        const found = await this.evalElementInfo(action.selector);
        if (!found.found) return { pass: false, message: `输入框 ${action.selector} 未找到` };
        // 清空并设值，派发 input/change 事件
        const expression = `
          (() => {
            const el = document.querySelector(${JSON.stringify(action.selector)});
            if (!el) return false;
            el.focus();
            el.value = ${JSON.stringify(action.value)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()
        `;
        const { result } = await Runtime.evaluate({ expression, returnByValue: true });
        return result?.value ? { pass: true, message: `输入 ${action.value}` } : { pass: false, message: '输入失败' };
      }
      case 'scroll': {
        const expression = `
          (() => {
            const el = document.querySelector(${JSON.stringify(action.selector || 'body')});
            const dir = ${JSON.stringify(action.value || 'down')};
            if (!el) return false;
            const delta = dir === 'up' ? -400 : 400;
            el.scrollBy({ top: delta, behavior: 'auto' });
            return true;
          })()
        `;
        const { result } = await Runtime.evaluate({ expression, returnByValue: true });
        return result?.value ? { pass: true, message: `滚动（${action.value || 'down'}）` } : { pass: false, message: '滚动失败' };
      }
      case 'hover': {
        const found = await this.evalElementInfo(action.selector);
        if (!found.found) return { pass: false, message: `元素 ${action.selector} 未找到` };
        const expression = `
          (() => {
            const el = document.querySelector(${JSON.stringify(action.selector)});
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
            return true;
          })()
        `;
        const { result } = await Runtime.evaluate({ expression, returnByValue: true });
        return result?.value ? { pass: true, message: `悬停 ${action.selector}` } : { pass: false, message: '悬停失败' };
      }
      case 'wait': {
        await sleep(Math.max(0, action.waitMs || 0));
        return { pass: true, message: `等待 ${action.waitMs || 0}ms` };
      }
      case 'assert': {
        return { pass: true, message: '断言步骤（由断言求值器处理）' };
      }
      default:
        return { pass: false, message: `未知动作类型：${action.type}` };
    }
  }

  /** 获取元素信息（是否存在、可见性、文本、位置） */
  async evalElementInfo(selector) {
    const { result } = await this.client.Runtime.evaluate({
      expression: elementEvalScript(selector),
      returnByValue: true,
    });
    return result?.value || { found: false };
  }

  async getUrl() {
    const { result } = await this.client.Runtime.evaluate({ expression: 'window.location.href', returnByValue: true });
    this.currentUrl = result?.value || this.currentUrl || '';
    return this.currentUrl;
  }

  async getText(selector) {
    const expression = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? (el.innerText || el.textContent || '').trim() : '';
      })()
    `;
    const { result } = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    return result?.value || '';
  }

  async isPresent(selector) {
    const info = await this.evalElementInfo(selector);
    return Boolean(info.found && info.visible);
  }
}
