/**
 * dry_run 后端：不连接任何浏览器，只配合执行器完成静态预检。
 * 动作方法不会被执行器调用；探针返回占位值，断言在该模式下只做目标非空等静态检查。
 */
import { BaseBackend } from './base.js';

export class DryRunBackend extends BaseBackend {
  constructor(opts) {
    super(opts);
    this.modeLabel = '预检模式（dry_run，不连接浏览器）';
  }

  async connect() {
    this.baselineUrl = this.opts.targetUrl || null;
    this.connected = true;
  }

  async getUrl() {
    return this.baselineUrl || '';
  }

  async exists() {
    // dry_run 不做真机存在性探测
    return null;
  }

  async textOf() {
    return null;
  }
}
