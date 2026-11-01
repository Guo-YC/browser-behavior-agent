/**
 * playwright 后端：使用 playwright-core（不触发浏览器下载）。
 *
 * 连接策略（契约 §6）：
 * 1. 优先 chromium.connectOverCDP('http://127.0.0.1:9222') 连接已有 Chrome；
 * 2. 连接失败则 chromium.launch({ channel: 'chrome' }) 调用本机已安装的 Chrome。
 *
 * 注意：playwright-core 本身不含浏览器二进制，必须依赖系统已安装的 Chrome；
 * 本机未安装 Chrome 时 launch 会抛出明确中文错误，由执行器汇总到报告中。
 */
import { chromium } from 'playwright-core';
import { BaseBackend, sleep, parseCdpEndpoint } from './base.js';
import { DEFAULT_CDP_ENDPOINT } from '../contract.js';

export class PlaywrightBackend extends BaseBackend {
  constructor(opts) {
    super(opts);
    this.endpoint = opts.cdpEndpoint || DEFAULT_CDP_ENDPOINT;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.connectedVia = null; // 'cdp' 连接已有 Chrome | 'launch' 本机启动
    this.connectFallbackReason = null;
  }

  async connect() {
    const { host, port } = parseCdpEndpoint(this.endpoint);
    // 第一步：尝试通过 CDP 接管已有 Chrome
    try {
      this.browser = await chromium.connectOverCDP(`http://${host}:${port}`);
      this.connectedVia = 'cdp';
      this.context = this.browser.contexts()[0] || (await this.browser.newContext());
      this.page = this.context.pages()[0] || (await this.context.newPage());
    } catch (err) {
      // 第二步：CDP 不可用，回退到本机 Chrome 启动
      this.connectFallbackReason = err.message;
      try {
        this.browser = await chromium.launch({
          channel: 'chrome',
          headless: !!this.opts.headless,
        });
      } catch (launchErr) {
        throw new Error(
          `Playwright 兜底启动本机 Chrome 失败：${launchErr.message}。` +
            '请确认本机已安装 Chrome 并可被 channel: "chrome" 识别，' +
            '或先将 Chrome 以 --remote-debugging-port=9222 启动（准备步骤见 replay/README.md §5）。',
        );
      }
      this.connectedVia = 'launch';
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
    }
    this.connected = true;
    this.baselineUrl = await this.getUrl();
    if (this.opts.targetUrl) {
      await this.navigate(this.opts.targetUrl);
    }
  }

  async navigate(url) {
    // 先等网络空闲；失败则退化为 DOMContentLoaded，兼容慢加载页面
    try {
      await this.page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    } catch {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    await sleep(500);
  }

  async click(selector) {
    await this.page.click(selector, { timeout: 5000 });
  }

  async dblclick(selector) {
    await this.page.dblclick(selector, { timeout: 5000 });
  }

  async input(selector, value) {
    await this.page.fill(selector, value, { timeout: 5000 });
  }

  async hover(selector) {
    await this.page.hover(selector, { timeout: 5000 });
  }

  async scroll(selector, value) {
    if (selector) {
      await this.page.locator(selector).scrollIntoViewIfNeeded({ timeout: 5000 });
    } else {
      let dy = 600;
      if (typeof value === 'number') dy = value;
      else if (typeof value === 'string' && /^\d+$/.test(value.trim())) dy = Number(value.trim());
      else if (typeof value === 'string' && value.trim().toLowerCase() === 'up') dy = -600;
      await this.page.mouse.wheel(0, dy);
    }
    await sleep(200);
  }

  async exists(selector) {
    return (await this.page.locator(selector).count()) > 0;
  }

  async textOf(selector) {
    try {
      return (await this.page.locator(selector).innerText({ timeout: 2000 })).trim();
    } catch {
      return '';
    }
  }

  async getUrl() {
    return this.page.url();
  }

  async wait(ms) {
    await this.page.waitForTimeout(ms);
  }

  async disconnect() {
    try {
      if (this.context && this.connectedVia === 'launch') await this.context.close();
    } catch {
      // 忽略关闭异常
    }
    try {
      if (this.browser) await this.browser.close();
    } catch {
      // 忽略关闭异常
    }
    this.connected = false;
  }
}
