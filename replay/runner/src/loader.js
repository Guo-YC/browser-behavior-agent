// 模块E：技能 JSON 加载器（依据 CONTRACTS.md §5 技能格式）
import fs from 'node:fs';
import path from 'node:path';
import { validateSkill } from './schema.js';

/**
 * 从单个 JSON 文件加载并校验技能
 * @param {{skillFile?: string}} opts
 * @returns {{ skill: object, source: string }}
 */
export function loadSkill({ skillFile } = {}) {
  if (!skillFile) throw new Error('缺少技能文件路径参数 skillFile。');
  const resolved = path.resolve(skillFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`技能文件不存在：${resolved}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`技能文件不是合法 JSON：${resolved}（${err.message}）`);
  }
  const problems = validateSkill(raw);
  if (problems.length > 0) {
    throw new Error(`技能结构校验未通过：\n  - ${problems.join('\n  - ')}`);
  }
  return { skill: raw, source: resolved };
}

/**
 * 从目录加载全部技能 JSON（仅 .json 文件，逐个校验；单个失败抛出并附文件名）
 * @param {{skillDir?: string}} opts
 * @returns {{ skills: object[], source: string }}
 */
export function loadSkillDir({ skillDir } = {}) {
  if (!skillDir) throw new Error('缺少技能目录参数 skillDir。');
  const resolved = path.resolve(skillDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`技能目录不存在：${resolved}`);
  }
  const files = fs
    .readdirSync(resolved)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const skills = [];
  for (const file of files) {
    const full = path.join(resolved, file);
    const { skill } = loadSkill({ skillFile: full });
    skills.push(skill);
  }
  return { skills, source: resolved };
}
