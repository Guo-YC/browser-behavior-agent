/**
 * cdp 后端：通过 chrome-remote-interface 连接已启动的 Chrome 调试端口（默认 127.0.0.1:9222）。
 *
 * 真机准备（详见 replay/README.md）：
 *   Chrome --remote-debugging-port=9222 --user-data-dir=<独立目录>
 *
 * 实现要点：
 * - Runtime.evaluate 在页面内 querySelector 定位元素，并读取 getBoundingClientRect 中心坐标；
 * - Input.dispatchMouseEvent 完成真实点击 / 双击 / 悬停；
 * - 聚焦后 Input.insertText 注入文本（浏览器派发真实 input 事件），并补派 input/change 兼容框架；
 * - Page.navigate 导航，load 事件 15 秒超时兜底。
 */
import CDP from 'chrome-remote-interface';
import { BaseBackend, sleep, parseCdpEndpoint } from './base.js';
import { DEFAULT_CDP_ENDPOINT } from '../contract.js';

export class CdpBackend extends BaseBackend {
  constructor(opts) {
    super(opts);
    this.endpoint = opts.cdpEndpoint || DEFAULT_CDP_ENDPOINT;
    this.client = null;
    this.Page = null;
    this.Runtime = null;
    this.Input = null;
    this.DOM = null;
  }

  /** 建立 CDP 连接并启用 Page / Runtime / DOM 域 */
  async connect() {
    const { host, port } = parseCdpEndpoint(this.endpoint);
    try {
      this.client = await CDP({ host, port });
    } catch (err) {
      throw new Error(
        `无法连接 CDP 调试端点 ${this.endpoint}：${err.message}。` +
          '请先以 --remote-debugging-port=9222 启动 Chrome（准备步骤见 replay/README.md）。',
      );
    }
    this.Page = this.client.Page;
    this.Runtime = this.client.Runtime;
    this.Input = this.client.Input;
    this.DOM = this.client.DOM;
    await this.Page.enable();
    await this.Runtime.enable();
    await this.DOM.enable();
    this.connected = true;
    this.connectedVia = 'cdp';
    this.baselineUrl = await this.getUrl();
    if (this.opts.targetUrl) {
      await this.navigate(this.opts.targetUrl);
    }
  }

  /** 在页面内执行表达式并返回 byValue 结果 */
  async _eval(expression) {
    const res = await this.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description || res.exceptionDetails.text || '未知脚本异常';
      throw new Error(`页面脚本执行异常：${desc}`);
    }
    return res.result?.value;
  }

  async getUrl() {
    return await this._eval('location.href');
  }

  async navigate(url) {
    await this.Page.navigate({ url });
    // 等待 load 事件；15 秒超时兜底，避免页面永不触发 load 导致挂死
    await Promise.race([this.Page.loadEventFired(), sleep(15000)]);
    await sleep(500);
  }

  /** 定位元素并返回中心坐标、文本、可见性 */
  async _locate(selector) {
    return await this._eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      return {
        found: true,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        text: (el.innerText || el.textContent || '').trim(),
        visible: r.width > 0 && r.height > 0
      };
    })()`);
  }

  async exists(selector) {
    const v = await this._locate(selector);
    return !!(v && v.found);
  }

  async textOf(selector) {
    const v = await this._locate(selector);
    return v?.text ?? '';
  }

  /** 派发鼠标事件（press 时 buttons=1，release 时 buttons=0） */
  async _mouseAt(x, y, type, clickCount = 1, button = 'left') {
    await this.Input.dispatchMouseEvent({
      type,
      x,
      y,
      button,
      clickCount,
      buttons: type === 'mouseReleased' ? 0 : 1,
    });
  }

  async click(selector) {
    const el = await this._locate(selector);
    if (!el?.found) throw new Error(`未找到可点击元素：${selector}`);
    if (!el.visible) throw new Error(`元素当前不可见：${selector}`);
    await this._mouseAt(el.x, el.y, 'mousePressed', 1);
    await sleep(30);
    await this._mouseAt(el.x, el.y, 'mouseReleased', 1);
    await sleep(120);
  }

  async dblclick(selector) {
    const el = await this._locate(selector);
    if (!el?.found) throw new Error(`未找到可双击元素：${selector}`);
    if (!el.visible) throw new Error(`元素当前不可见：${selector}`);
    // 第一次单击 + 第二次单击（clickCount=2）组成双击
    await this._mouseAt(el.x, el.y, 'mousePressed', 1);
    await this._mouseAt(el.x, el.y, 'mouseReleased', 1);
    await sleep(30);
    await this._mouseAt(el.x, el.y, 'mousePressed', 2);
    await sleep(30);
    await this._mouseAt(el.x, el.y, 'mouseReleased', 2);
    await sleep(120);
  }

  async hover(selector) {
    const el = await this._locate(selector);
    if (!el?.found) throw new Error(`未找到悬停元素：${selector}`);
    await this.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x: el.x,
      y: el.y,
      button: 'none',
    });
  }

  async input(selector, value) {
    const el = await this._locate(selector);
    if (!el?.found) throw new Error(`未找到输入框：${selector}`);
    if (!el.visible) throw new Error(`输入框当前不可见：${selector}`);
    await this._eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.focus();
    })()`);
    // insertText 向聚焦元素注入文本，浏览器会派发真实 input 事件
    await this.Input.insertText({ text: value });
    // 兼容不监听原生 input 事件的前端框架，补派 input / change
    await this._eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await sleep(120);
  }

  async scroll(selector, value) {
    if (selector) {
      await this._eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      })()`);
    } else {
      // value 为数字时按像素滚动；"up" 向上，其余默认向下
      let px = 600;
      if (typeof value === 'number') px = value;
      else if (typeof value === 'string' && /^\d+$/.test(value.trim())) px = Number(value.trim());
      else if (typeof value === 'string' && value.trim().toLowerCase() === 'up') px = -600;
      await this._eval(`(() => { window.scrollBy(0, ${JSON.stringify(px)}); })()`);
    }
    await sleep(200);
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // 连接已断开时忽略关闭异常
      }
      this.client = null;
    }
    this.connected = false;
  }
}
