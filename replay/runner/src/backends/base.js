/**
 * 后端基类与共享工具。
 *
 * 后端需要实现的动作接口（cdp / playwright 各自适配，dry_run 不连浏览器）：
 * - connect()：建立浏览器连接；如 opts.targetUrl 存在则先导航到目标页
 * - disconnect()：释放连接
 * - navigate(url)：页面导航
 * - click(selector)：单击元素中心
 * - dblclick(selector)：双击元素中心
 * - input(selector, value)：聚焦并输入文本
 * - hover(selector)：悬停到元素中心
 * - scroll(selector, value)：滚动到元素，或按 value 滚动窗口
 * - wait(ms)：等待指定毫秒
 * - 探针：getUrl() / exists(selector) / textOf(selector)
 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 解析 CDP 调试端点（默认 http://127.0.0.1:9222）为 {host, port}。
 * @param {string} endpoint
 * @returns {{host: string, port: number}}
 */
export function parseCdpEndpoint(endpoint) {
  const u = new URL(endpoint);
  return { host: u.hostname, port: Number(u.port || 9222) };
}

/**
 * 基类：保存选项并提供未实现方法的中文报错，避免静默降级。
 */
export class BaseBackend {
  /**
   * @param {{mode?: string, headless?: boolean, targetUrl?: string, cdpEndpoint?: string, continueOnFail?: boolean}} opts
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.baselineUrl = null;
    this.connected = false;
  }

  /** 抛“未实现”中文错误 */
  _unimplemented(method) {
    throw new Error(`当前后端未实现动作：${method}（请检查模式配置）`);
  }

  async connect() {
    this._unimplemented('connect');
  }

  async disconnect() {
    // 默认空实现
  }

  async navigate() {
    this._unimplemented('navigate');
  }

  async click() {
    this._unimplemented('click');
  }

  async dblclick() {
    this._unimplemented('dblclick');
  }

  async input() {
    this._unimplemented('input');
  }

  async hover() {
    this._unimplemented('hover');
  }

  async scroll() {
    this._unimplemented('scroll');
  }

  async wait(ms) {
    await sleep(ms);
  }

  async getUrl() {
    this._unimplemented('getUrl');
  }

  async exists() {
    this._unimplemented('exists');
  }

  async textOf() {
    this._unimplemented('textOf');
  }
}
