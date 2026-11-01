/**
 * dry_run 模式预检规则：不连浏览器，只对动作字段与断言目标做静态合法性检查。
 * 规则对齐契约 §5：动作类型、选择器语法、input 必须有 value、断言 target 非空等。
 */
import {
  ACTION_TYPES,
  ASSERTION_KINDS,
  ACTION_LABELS,
  ASSERTION_LABELS,
  DEFAULT_WAIT_MS,
} from './contract.js';

/**
 * 选择器语法静态校验（@medv/finder 产出的 CSS 路径，如
 * `html > body > div#app > button.btn-primary[type="submit"]`）。
 * 只做括号/引号配对与边界检查，不做完整 CSS 解析；非法选择器在真机模式会再做存在性探测。
 * @param {any} sel
 * @returns {boolean}
 */
export function validSelector(sel) {
  if (typeof sel !== 'string' || sel.trim() === '') return false;
  const s = sel.trim();
  if (s.startsWith('>') || s.endsWith('>')) return false;
  if ((s.match(/\[/g) || []).length !== (s.match(/\]/g) || []).length) return false;
  if ((s.match(/\(/g) || []).length !== (s.match(/\)/g) || []).length) return false;
  if ((s.match(/"/g) || []).length % 2 !== 0) return false;
  if ((s.match(/'/g) || []).length % 2 !== 0) return false;
  if (/\>\s*>/.test(s)) return false; // 连续空层级
  return true;
}

/**
 * 导航目标合法性：支持 http/https/about:blank，也允许站内相对路径与锚点。
 * @param {any} v
 * @returns {boolean}
 */
export function isValidUrl(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  const s = v.trim();
  if (s.startsWith('#') || s.startsWith('/')) return true;
  try {
    const u = new URL(s);
    return ['http:', 'https:', 'about:'].includes(u.protocol);
  } catch {
    return false;
  }
}

/**
 * 单条断言预检。
 * 选择器归属：text_present / element_present 优先使用断言自带的可选 selector，
 * 缺省回退到所属动作的选择器（§5 断言对象标准字段为 kind/target/timeoutMs；
 * 断言内 selector 为兼容扩展，便于在动作之后校验页面其他区域，详见 replay/README.md）。
 * @param {object} assertion 断言对象
 * @param {object} action 所属动作
 * @returns {{status: 'PASS'|'FAIL', message: string, assertion: object}}
 */
export function precheckAssertion(assertion, action) {
  const label = ASSERTION_LABELS[assertion.kind] || assertion.kind;

  if (!ASSERTION_KINDS.includes(assertion.kind)) {
    return { status: 'FAIL', message: `类型 "${assertion.kind}" 不被支持`, assertion };
  }

  // url_change 只比较动作前后网址；element_present 由选择器定位元素，target 均可留空；
  // url_contains / text_present 必须给出非空 target
  if (assertion.kind === 'url_contains' || assertion.kind === 'text_present') {
    if (typeof assertion.target !== 'string' || assertion.target.trim() === '') {
      return { status: 'FAIL', message: 'target 不能为空', assertion };
    }
  }

  // 依赖选择器的断言：断言自带 selector 或动作选择器二者至少有一个合法
  if (assertion.kind === 'text_present' || assertion.kind === 'element_present') {
    const selector = assertion.selector || action.selector;
    if (!validSelector(selector)) {
      return {
        status: 'FAIL',
        message: '需要合法选择器（断言 selector 或动作选择器），当前为空或非法',
        assertion,
      };
    }
  }

  if (assertion.timeoutMs !== undefined && (typeof assertion.timeoutMs !== 'number' || assertion.timeoutMs <= 0)) {
    return { status: 'FAIL', message: `timeoutMs 必须是正数（当前为 ${String(assertion.timeoutMs)}）`, assertion };
  }

  let targetDesc;
  if (assertion.kind === 'url_change') {
    targetDesc = '比较动作前后网址是否变化';
  } else if (assertion.target) {
    targetDesc = `目标：${assertion.target}`;
  } else {
    targetDesc = '元素存在性检查（由选择器定位）';
  }
  return { status: 'PASS', message: targetDesc, assertion };
}

/**
 * 单个动作预检，返回动作级检查项与断言级检查项。
 * @param {object} action 动作对象
 * @returns {{checks: Array<{status:string,message:string}>, assertionChecks: Array<object>, overall: boolean}}
 */
export function precheckAction(action) {
  const checks = [];
  const push = (ok, message) => checks.push({ status: ok ? 'PASS' : 'FAIL', message });

  const label = ACTION_LABELS[action.type] || action.type;

  if (!ACTION_TYPES.includes(action.type)) {
    push(false, `动作类型 "${action.type}" 不在允许列表内（${ACTION_TYPES.join('/')}）`);
  }

  switch (action.type) {
    case 'navigate':
      push(isValidUrl(action.value), `导航目标：${action.value || '（空）'}`);
      break;
    case 'click':
    case 'dblclick':
    case 'hover':
      push(validSelector(action.selector), `目标选择器：${action.selector || '（空）'}`);
      break;
    case 'input':
      push(validSelector(action.selector), `目标选择器：${action.selector || '（空）'}`);
      push(
        typeof action.value === 'string' && action.value.length > 0,
        `输入内容${action.value ? `："${action.value}"` : '（空，input 动作必须携带 value）'}`,
      );
      break;
    case 'scroll':
      if (action.selector) {
        push(validSelector(action.selector), `滚动目标选择器：${action.selector}`);
      } else {
        push(true, '未指定选择器，回放时将滚动当前窗口');
      }
      break;
    case 'wait': {
      // 注意：负数是真值，不能用 || 兜底；需按类型显式判断
      const ms =
        typeof action.waitMs === 'number'
          ? action.waitMs
          : typeof action.value === 'number'
            ? action.value
            : undefined;
      push(
        typeof ms === 'number' && ms > 0,
        `等待时长：${ms ?? `未设置，使用默认 ${DEFAULT_WAIT_MS}ms`}`,
      );
      break;
    }
    case 'assert':
      push(
        Array.isArray(action.assertions) && action.assertions.length > 0,
        '断言动作至少需要一条后置断言',
      );
      break;
    default:
      break;
  }

  // 通用：动作后停留时长（wait 动作自身已在上文校验等待时长，此处不重复检查）
  if (
    action.type !== 'wait' &&
    action.waitMs !== undefined &&
    (typeof action.waitMs !== 'number' || action.waitMs < 0)
  ) {
    push(false, `waitMs 必须是非负数（当前为 ${String(action.waitMs)}）`);
  }

  const assertionChecks = (action.assertions || []).map((a) => precheckAssertion(a, action));
  const overall =
    checks.every((c) => c.status === 'PASS') &&
    assertionChecks.every((c) => c.status === 'PASS');

  return { checks, assertionChecks, overall };
}

/**
 * 技能级全局预检：动作编号连续性、动作类型覆盖等。
 * @param {object} skill 技能对象
 * @returns {Array<{status:string,message:string}>}
 */
export function precheckSkill(skill) {
  const checks = [];
  const push = (ok, message) => checks.push({ status: ok ? 'PASS' : 'FAIL', message });

  push(Array.isArray(skill.actions) && skill.actions.length > 0, '动作链非空');

  const steps = skill.actions.map((a) => a.step);
  const dup = steps.filter((s, i) => steps.indexOf(s) !== i);
  push(dup.length === 0, `动作 step 编号${dup.length ? `重复：${[...new Set(dup)].join(', ')}` : '无重复'}`);

  if (skill.targetUrlPattern !== undefined) {
    let ok = true;
    try {
      new RegExp(skill.targetUrlPattern);
    } catch {
      ok = false;
    }
    push(ok, `targetUrlPattern 正则${ok ? '合法' : '非法'}`);
  }

  return checks;
}
