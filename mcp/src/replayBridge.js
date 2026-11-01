/**
 * replay 模块动态导入桥接层（契约 §4、§6、§7）。
 *  - 蒸馏（模块D）：replay/distill/index.js 导出 `distillSkill(opts)`，
 *    入参 { domain, name, sessionIds, minOccurrences, maxSteps }，返回 { skillId, path }。
 *  - 回放（模块E）：replay/runner/index.js 导出 `runSkill(skill, opts)`，
 *    opts = { mode, headless, targetUrl }。
 * 模块尚未编译/部署、导出缺失或调用抛错时，统一转成中文错误，供工具层包装为 JSON 返回。
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REPLAY_DIR } from './config.js';

/** 蒸馏模块文件绝对路径 */
const DISTILL_ENTRY = path.join(REPLAY_DIR, 'distill', 'index.js');
/** 回放模块文件绝对路径 */
const RUNNER_ENTRY = path.join(REPLAY_DIR, 'runner', 'index.js');

/** 模块缺失/导出缺失的中文提示 */
function moduleNotReadyError(entryPath, exportName) {
  return new Error(
    `回放/蒸馏模块尚未就绪：无法加载 ${entryPath}（目录 REPLAY_DIR=${REPLAY_DIR}）。` +
    `请先完成模块D（replay/distill）或模块E（replay/runner）的开发与部署；` +
    `若 replay 目录不在默认位置，请设置环境变量 REPLAY_DIR 指向正确的 replay 目录。` +
    (exportName ? `该模块应导出函数「${exportName}」。` : '')
  );
}

/**
 * 调用蒸馏模块生成技能。
 * @param {{ domain: string, name?: string, sessionIds?: string[], minOccurrences?: number, maxSteps?: number }} opts
 * @returns {Promise<{ skillId: string, path: string }>}
 */
export async function callDistillSkill(opts) {
  let mod;
  try {
    mod = await import(pathToFileURL(DISTILL_ENTRY).href);
  } catch {
    throw moduleNotReadyError(DISTILL_ENTRY, 'distillSkill');
  }
  if (typeof mod.distillSkill !== 'function') {
    throw new Error(`蒸馏模块 ${DISTILL_ENTRY} 缺少导出函数 distillSkill(opts)，请检查模块D 实现是否符合契约 §7。`);
  }
  try {
    return await mod.distillSkill(opts);
  } catch (err) {
    throw new Error(`技能蒸馏执行失败：${err && err.message ? err.message : String(err)}`);
  }
}

/**
 * 读取技能 JSON 文件（契约 §5 格式）。
 * @param {string} skillPath 技能文件绝对路径（来自 daemon /api/skills 索引）
 * @returns {Promise<object>} 技能对象
 */
export async function readSkillFile(skillPath) {
  let absPath = skillPath;
  if (!path.isAbsolute(absPath)) absPath = path.resolve(REPLAY_DIR, 'skills', skillPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`技能文件不存在：${absPath}，请确认技能已正确导出到 replay/skills/ 目录。`);
  }
  let text;
  try {
    text = await fs.promises.readFile(absPath, 'utf8');
  } catch (err) {
    throw new Error(`技能文件读取失败（${absPath}）：${err && err.message ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`技能文件 JSON 格式错误（${absPath}）：请检查契约 §5 格式。`);
  }
}

/**
 * 调用回放执行器执行技能。
 * @param {object} skill 契约 §5 技能对象
 * @param {{ mode?: string, headless?: boolean, targetUrl?: string }} opts
 * @returns {Promise<unknown>} 回放结果（执行报告 JSON）
 */
export async function callRunSkill(skill, opts) {
  let mod;
  try {
    mod = await import(pathToFileURL(RUNNER_ENTRY).href);
  } catch {
    throw moduleNotReadyError(RUNNER_ENTRY, 'runSkill');
  }
  if (typeof mod.runSkill !== 'function') {
    throw new Error(`回放模块 ${RUNNER_ENTRY} 缺少导出函数 runSkill(skill, opts)，请检查模块E 实现是否符合契约 §6。`);
  }
  try {
    return await mod.runSkill(skill, opts);
  } catch (err) {
    throw new Error(`确定性回放执行失败：${err && err.message ? err.message : String(err)}`);
  }
}
