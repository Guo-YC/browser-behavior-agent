// 模块E：技能 JSON 结构校验（依据 CONTRACTS.md §5）
import { isActionType, isAssertionKind } from './contract.js';

/**
 * 校验技能 JSON，返回问题清单（空数组表示通过）
 * @param {object} skill
 * @returns {string[]}
 */
export function validateSkill(skill) {
  const problems = [];
  if (!skill || typeof skill !== 'object') return ['技能根节点必须是对象'];

  const required = ['skillId', 'name', 'domain', 'description', 'targetUrlPattern', 'createdAt', 'version', 'sourceSessions', 'evidence', 'actions'];
  for (const field of required) {
    if (skill[field] === undefined || skill[field] === null) problems.push(`缺少必填字段：${field}`);
  }

  if (skill.skillId && !/^skl_[0-9a-f]{16}$/.test(skill.skillId)) problems.push(`skillId 格式不符合契约 §5：${skill.skillId}`);
  if (typeof skill.createdAt !== 'number') problems.push('createdAt 必须为时间戳数字');
  if (skill.version !== 1) problems.push('version 必须为 1');
  if (!Array.isArray(skill.sourceSessions)) problems.push('sourceSessions 必须为数组');
  if (!skill.evidence || typeof skill.evidence.matchRate !== 'number') problems.push('evidence.matchRate 必须为数字');
  if (!Array.isArray(skill.actions) || skill.actions.length === 0) problems.push('actions 必须为非空数组');

  (skill.actions || []).forEach((action, index) => {
    const prefix = `actions[${index}]`;
    if (typeof action.step !== 'number') problems.push(`${prefix}.step 必须为数字`);
    if (!isActionType(action.type)) problems.push(`${prefix}.type 非法：${action.type}`);
    if (!Array.isArray(action.assertions)) problems.push(`${prefix}.assertions 必须为数组`);
    (action.assertions || []).forEach((assertion, ai) => {
      const ap = `${prefix}.assertions[${ai}]`;
      if (!isAssertionKind(assertion.kind)) problems.push(`${ap}.kind 非法：${assertion.kind}`);
      if (typeof assertion.timeoutMs !== 'number' || assertion.timeoutMs <= 0) problems.push(`${ap}.timeoutMs 必须为正数`);
    });
  });

  return problems;
}
