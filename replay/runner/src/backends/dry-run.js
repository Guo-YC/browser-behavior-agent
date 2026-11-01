// 模块E：dry-run 预检后端（依据 CONTRACTS.md §6 回放执行前的合法性与可执行性校验）
// 不连接浏览器：逐动作做静态校验，输出将执行的计划，供 CI / 蒸馏后快速确认技能可回放。
import { Backend } from './base.js';
import { isValidHttpUrl } from '../contract.js';

/** 等待指定毫秒（dry-run 模式几乎不等待，但保留接口一致性） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * dry-run 后端：只做静态预检，不产生真实浏览器动作。
 * 校验规则：
 *  - navigate：URL 必须为合法 http(s) 地址；
 *  - click/dblclick/hover：选择器非空；
 *  - input：选择器非空且 value 非空；
 *  - scroll：选择器或方向非空；
 *  - wait：waitMs 必须 ≥0；
 *  - assert：必须至少有一条断言，且断言 target 非空（url_change 除外）。
 */
export class DryRunBackend extends Backend {
  constructor() {
    super();
    this.mode = 'dry_run';
    // dry-run 不产生真实浏览器动作，故 navigate/click 等均由静态校验覆盖
    this.capabilities = { ...this.capabilities };
  }

  async connect() {
    this.connected = true;
  }

  async close() {
    this.connected = false;
  }

  async precheck(action) {
    const problems = [];

    switch (action.type) {
      case 'navigate': {
        if (!isValidHttpUrl(action.value)) problems.push(`navigate 目标非法：${action.value}`);
        break;
      }
      case 'click':
      case 'dblclick':
      case 'hover': {
        if (!action.selector || typeof action.selector !== 'string' || action.selector.trim() === '') {
          problems.push(`${action.type} 缺少选择器`);
        }
        break;
      }
      case 'input': {
        if (!action.selector || typeof action.selector !== 'string' || action.selector.trim() === '') {
          problems.push('input 缺少选择器');
        }
        if (!action.value || typeof action.value !== 'string' || action.value.trim() === '') {
          problems.push('input 缺少输入值');
        }
        break;
      }
      case 'scroll': {
        if ((!action.selector || action.selector.trim() === '') && (!action.value || String(action.value).trim() === '')) {
          problems.push('scroll 缺少选择器或方向');
        }
        break;
      }
      case 'wait': {
        if (typeof action.waitMs !== 'number' || action.waitMs < 0) {
          problems.push('wait 的 waitMs 必须为 ≥0 的数字');
        }
        break;
      }
      case 'assert': {
        if (!Array.isArray(action.assertions) || action.assertions.length === 0) {
          problems.push('assert 动作必须至少包含一条断言');
        }
        for (const a of action.assertions || []) {
          if (a.kind !== 'url_change' && (!a.target || String(a.target).trim() === '')) {
            problems.push(`断言 ${a.kind} 的 target 不能为空`);
          }
        }
        break;
      }
      default:
        problems.push(`未知动作类型：${action.type}`);
    }

    if (problems.length > 0) {
      return { pass: false, message: `步骤 ${action.step} 预检未通过：${problems.join('；')}` };
    }
    return { pass: true, message: `步骤 ${action.step} 预检通过` };
  }

  // dry-run 不产生真实动作，run 仅返回通过（动作已由 precheck 校验）
  async run(action) {
    return { pass: true, message: `步骤 ${action.step} ${action.type}（预检通过，不实际执行）` };
  }

  async getUrl() {
    return '';
  }

  async getText() {
    return '';
  }

  async isPresent() {
    return false;
  }
}
