// 模块D：技能对象组装、技能 JSON 落盘、daemon 索引注册（契约 §5、§3 POST /api/skills）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { skillsDir, targetUrlPattern, resolveDaemonUrl } from './paths.js';
import { buildStepAssertions, buildTailAssertion } from './assert.js';

/**
 * 生成技能 id：skl_<sha256(domain|name|timestamp|动作链摘要) 前 16 位>（契约 §5）
 * 动作链摘要用于区分同一域名下同名的多条技能，避免 id 碰撞
 */
export function makeSkillId(domain, name, timestamp, salt = '') {
  const hash = crypto
    .createHash('sha256')
    .update(`${domain}|${name}|${timestamp}|${salt}`)
    .digest('hex')
    .slice(0, 16);
  return `skl_${hash}`;
}

/** 把动作转成中文短语，用于自动生成技能描述 */
function actionPhrase(action) {
  switch (action.type) {
    case 'navigate': {
      const parsed = parseUrlSafe(action.value);
      return parsed ? `打开 ${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}` : `打开 ${action.value}`;
    }
    case 'click':
      return `点击“${action.text || action.selector}”`;
    case 'dblclick':
      return `双击“${action.text || action.selector}”`;
    case 'input':
      return `在 ${action.selector} 输入“${action.masked ? '****' : action.value}”`;
    case 'scroll':
      return `页面滚动（${action.value || '方向未记录'}）`;
    case 'hover':
      return `悬停在 ${action.selector}`;
    default:
      return action.type;
  }
}

/** 安全解析 URL，失败返回 null */
function parseUrlSafe(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * 从候选链的支撑会话中挑一条“代表会话”，取得连贯的动作切片
 * （前缀树节点样本可能来自不同会话；这里按子序列方式在会话内定位链上动作，
 *  允许跳过中间的零星噪声点击/滚动，保证回放动作连贯）
 */
function findRepresentative(chain, cleaned, rawSessions) {
  const keys = chain.keys;
  for (const sid of chain.sessionIds) {
    const actions = cleaned.get(sid);
    if (!actions) continue;
    // 子序列匹配：按链上顺序在会话动作序列中逐个定位，记录下标
    const positions = [];
    let cursor = 0;
    let matched = true;
    for (const key of keys) {
      const index = actions.findIndex((a, i) => i >= cursor && a.key === key);
      if (index === -1) {
        matched = false;
        break;
      }
      positions.push(index);
      cursor = index + 1;
    }
    if (matched) {
      return {
        sessionId: sid,
        actions,
        positions,
        rawEvents: rawSessions.get(sid) || [],
      };
    }
  }
  // 兜底：取第一条支撑会话的前 chain.length 条动作
  const fallbackSid = chain.sessionIds[0];
  const fallbackActions = cleaned.get(fallbackSid) || [];
  return {
    sessionId: fallbackSid,
    actions: fallbackActions,
    positions: fallbackActions.map((_, i) => i).slice(0, chain.length),
    rawEvents: rawSessions.get(fallbackSid) || [],
  };
}

/**
 * 组装一条候选链为符合契约 §5 的技能对象
 */
export function assembleSkill({
  chain,
  cleaned,
  rawSessions,
  totalSessions,
  domain,
  name,
  timestamp,
}) {
  const rep = findRepresentative(chain, cleaned, rawSessions);

  // 按子序列定位到的下标取链上动作（跳过中间零星噪声）
  let picked = rep.positions.map((index) => rep.actions[index]);

  // 动作链起手兜底 navigate：链首不是 navigate 时，向前找最近一条 navigate，或用会话首个 URL 补一条
  if (picked.length > 0 && picked[0].type !== 'navigate') {
    const firstPos = rep.positions[0];
    let prevNavigate = null;
    for (let i = firstPos - 1; i >= 0; i--) {
      if (rep.actions[i].type === 'navigate') {
        prevNavigate = rep.actions[i];
        break;
      }
    }
    if (prevNavigate) {
      picked = [prevNavigate, ...picked];
    } else {
      const startUrl = rep.rawEvents[0]?.url || '';
      if (startUrl) {
        picked = [
          {
            type: 'navigate',
            selector: 'html',
            value: startUrl,
            text: '',
            masked: false,
            ts: rep.rawEvents[0].ts,
            source: rep.rawEvents[0],
          },
          ...picked,
        ];
      }
    }
  }

  // 链尾跳转导航不进入动作链：页面跳转结果转为断言挂到最后一个用户动作上（契约 §7 第6步）
  while (picked.length > 1 && picked[picked.length - 1].type === 'navigate') {
    picked.pop();
  }

  // 生成技能动作序列（契约 §5 actions 结构）
  const actions = picked.map((action, index) => {
    const step = {
      step: index + 1,
      type: action.type,
      selector: action.selector,
      waitMs: 300,
      optional: false,
      assertions: buildStepAssertions(action),
    };
    // navigate 与 input 携带 value；scroll 携带方向；其余动作不写 value 字段
    if (action.type === 'navigate' || action.type === 'input') {
      step.value = action.value;
    } else if (action.type === 'scroll') {
      step.value = action.value;
    }
    return step;
  });

  // 链尾 2s 内 URL 变化断言挂到最后一步
  if (actions.length > 0) {
    const tailRaw = picked[picked.length - 1];
    actions[actions.length - 1].assertions.push(...buildTailAssertion(tailRaw, rep.rawEvents));
  }

  // 技能名称：显式指定优先，否则按首个点击文本自动生成
  const firstClickText = picked.find((a) => a.text)?.text;
  const skillName =
    name || (firstClickText ? `流程-${firstClickText}` : `通用流程-${domain}`);

  const description = `在 ${domain} 站点执行：${picked.map(actionPhrase).join('，')}。`;

  const matchRate = totalSessions > 0 ? chain.occurrences / totalSessions : 0;

  // 动作链摘要加盐，保证同名多技能 id 不碰撞
  const salt = crypto
    .createHash('sha256')
    .update(chain.keys.join('›'))
    .digest('hex')
    .slice(0, 8);
  const skillId = makeSkillId(domain, skillName, timestamp, salt);
  const fileName = `${skillId}.json`;
  const skillPath = path.join(skillsDir, fileName);

  return {
    skill: {
      skillId,
      name: skillName,
      domain,
      description,
      targetUrlPattern: targetUrlPattern(domain),
      createdAt: timestamp,
      version: 1,
      sourceSessions: chain.sessionIds,
      evidence: {
        trajectoryCount: chain.occurrences,
        matchRate: Number(matchRate.toFixed(4)),
      },
      actions,
    },
    skillPath,
    representativeSessionId: rep.sessionId,
  };
}

/**
 * 按契约 §5 校验技能 JSON 结构，返回问题清单（空数组表示通过）
 * @param {object} skill 技能对象
 * @returns {string[]} 不通过项的中文描述
 */
export function validateSkillJson(skill) {
  const problems = [];
  const required = ['skillId', 'name', 'domain', 'description', 'targetUrlPattern', 'createdAt', 'version', 'sourceSessions', 'evidence', 'actions'];
  for (const field of required) {
    if (skill[field] === undefined || skill[field] === null) problems.push(`缺少必填字段：${field}`);
  }

  if (skill.skillId && !/^skl_[0-9a-f]{16}$/.test(skill.skillId)) {
    problems.push(`skillId 格式不符合契约 §5：${skill.skillId}`);
  }
  if (typeof skill.createdAt !== 'number') problems.push('createdAt 必须为时间戳数字');
  if (skill.version !== 1) problems.push('version 必须为 1');
  if (!Array.isArray(skill.sourceSessions) || skill.sourceSessions.length === 0) {
    problems.push('sourceSessions 必须为非空数组');
  }
  if (!skill.evidence || typeof skill.evidence.trajectoryCount !== 'number') {
    problems.push('evidence.trajectoryCount 必须为数字');
  }
  if (skill.evidence && (typeof skill.evidence.matchRate !== 'number' || skill.evidence.matchRate < 0 || skill.evidence.matchRate > 1)) {
    problems.push('evidence.matchRate 必须为 0~1 之间的数字');
  }
  if (!Array.isArray(skill.actions) || skill.actions.length === 0) {
    problems.push('actions 必须为非空数组');
  }

  const allowedTypes = new Set(['navigate', 'click', 'dblclick', 'input', 'scroll', 'hover', 'wait', 'assert']);
  const allowedAssertions = new Set(['url_contains', 'text_present', 'element_present', 'url_change']);
  (skill.actions || []).forEach((action, index) => {
    const prefix = `actions[${index}]`;
    if (typeof action.step !== 'number') problems.push(`${prefix}.step 必须为数字`);
    if (!allowedTypes.has(action.type)) problems.push(`${prefix}.type 非法：${action.type}`);
    if (!Array.isArray(action.assertions)) problems.push(`${prefix}.assertions 必须为数组`);
    (action.assertions || []).forEach((assertion, ai) => {
      if (!allowedAssertions.has(assertion.kind)) problems.push(`${prefix}.assertions[${ai}].kind 非法：${assertion.kind}`);
      if (!assertion.target) problems.push(`${prefix}.assertions[${ai}].target 不能为空`);
    });
  });

  return problems;
}
// 将技能 JSON 写入 replay/skills/<skillId>.json（契约 §5）；
// 技能文件结构以契约 §5 为准，内部使用的 path 字段不落盘
export function writeSkillFile(skill, skillPath) {
  fs.mkdirSync(skillsDir, { recursive: true });
  const { path: _excluded, ...fileSkill } = skill;
  fs.writeFileSync(skillPath, JSON.stringify(fileSkill, null, 2), 'utf8');
  return skillPath;
}

/**
 * 尽力调用 daemon POST /api/skills 注册索引；daemon 未启动则仅返回中文警告，不阻塞主流程
 * @returns {{ ok: boolean, message: string }}
 */
export async function registerSkill(skill) {
  const url = `${resolveDaemonUrl()}/api/skills`;
  const payload = {
    skillId: skill.skillId,
    name: skill.name,
    domain: skill.domain,
    description: skill.description,
    path: skill.path,
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return {
        ok: false,
        message: `daemon 返回 HTTP ${response.status}，索引注册未完成（不阻塞技能文件落盘）`,
      };
    }
    return { ok: true, message: '已注册到 daemon 技能索引' };
  } catch (error) {
    return {
      ok: false,
      message: `daemon 未启动或不可达（${error.name === 'AbortError' ? '请求超时' : error.message}），跳过索引注册，不阻塞本次蒸馏`,
    };
  }
}
