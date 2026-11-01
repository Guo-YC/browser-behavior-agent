/**
 * 技能加载器：按 skillId 从 replay/skills/ 读取，或按 --skill-file 指定路径读取。
 * 同时做 §5 顶层结构校验；动作级预检在 schema.js 中完成。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_TYPES, ASSERTION_KINDS } from './contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** runner 目录：replay/runner/；技能生产目录：replay/skills/ */
export const RUNNER_DIR = path.resolve(__dirname, '..');
export const SKILLS_DIR = path.resolve(RUNNER_DIR, '..', 'skills');

/**
 * 解析技能文件绝对路径。
 * @param {string} skillId 技能 ID（可带或不带 .json 后缀）
 * @param {string} [explicitFile] --skill-file 指定的路径（相对路径基于当前工作目录解析）
 * @returns {string} 技能 JSON 绝对路径
 */
export function resolveSkillPath(skillId, explicitFile) {
  if (explicitFile) {
    return path.resolve(process.cwd(), explicitFile);
  }
  if (!skillId) {
    throw new Error('缺少技能标识：请通过 --skill <skillId> 或 --skill-file <路径> 指定技能');
  }
  const fileName = skillId.endsWith('.json') ? skillId : `${skillId}.json`;
  return path.join(SKILLS_DIR, fileName);
}

/**
 * 读取并解析技能 JSON 文件。
 * @param {string} absPath 技能文件绝对路径
 * @returns {Promise<object>} 技能对象
 */
export async function readSkillFile(absPath) {
  if (!existsSync(absPath)) {
    throw new Error(`技能文件不存在：${absPath}`);
  }
  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err) {
    throw new Error(`读取技能文件失败：${absPath}，原因：${err.message}`);
  }
  let skill;
  try {
    skill = JSON.parse(raw);
  } catch (err) {
    throw new Error(`技能文件不是合法 JSON：${absPath}，原因：${err.message}`);
  }
  const validation = validateSkillSchema(skill);
  if (!validation.ok) {
    throw new Error(`技能结构不符合契约 §5：\n  - ${validation.errors.join('\n  - ')}`);
  }
  return skill;
}

/**
 * 顶层结构校验（§5）。动作级字段校验由预检器补充。
 * @param {any} skill 待校验对象
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateSkillSchema(skill) {
  const errors = [];
  if (!skill || typeof skill !== 'object') {
    errors.push('技能必须是 JSON 对象');
    return { ok: false, errors };
  }
  if (!skill.skillId || typeof skill.skillId !== 'string') {
    errors.push('缺少必填字段 skillId（字符串）');
  }
  if (!skill.name || typeof skill.name !== 'string') {
    errors.push('缺少必填字段 name（字符串）');
  }
  if (!skill.domain || typeof skill.domain !== 'string') {
    errors.push('缺少必填字段 domain（字符串）');
  }
  if (!Array.isArray(skill.actions) || skill.actions.length === 0) {
    errors.push('actions 必须是非空数组');
  }
  if (Array.isArray(skill.actions)) {
    skill.actions.forEach((action, idx) => {
      const where = `第 ${idx + 1} 个动作`;
      if (!action || typeof action !== 'object') {
        errors.push(`${where} 不是对象`);
        return;
      }
      if (typeof action.step !== 'number') {
        errors.push(`${where} 缺少数字字段 step`);
      }
      if (!ACTION_TYPES.includes(action.type)) {
        errors.push(`${where} 的动作类型 "${action.type}" 不在允许列表内（${ACTION_TYPES.join('/')}）`);
      }
      if (action.assertions !== undefined && !Array.isArray(action.assertions)) {
        errors.push(`${where} 的 assertions 必须是数组`);
      }
      if (Array.isArray(action.assertions)) {
        action.assertions.forEach((a, ai) => {
          if (!a || typeof a !== 'object') {
            errors.push(`${where} 第 ${ai + 1} 条断言不是对象`);
            return;
          }
          if (!ASSERTION_KINDS.includes(a.kind)) {
            errors.push(`${where} 第 ${ai + 1} 条断言类型 "${a.kind}" 不在允许列表内（${ASSERTION_KINDS.join('/')}）`);
          }
        });
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 组合入口：按 skillId 或文件路径加载技能。
 * @param {{skillId?: string, skillFile?: string}} params
 * @returns {Promise<{skill: object, filePath: string}>}
 */
export async function loadSkill({ skillId, skillFile }) {
  const filePath = resolveSkillPath(skillId, skillFile);
  const skill = await readSkillFile(filePath);
  return { skill, filePath };
}
