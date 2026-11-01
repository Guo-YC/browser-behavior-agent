#!/usr/bin/env node
// 模块D 自检脚本（契约 §8 模块D 验收标准）
// 流程：构造临时 mock 数据库 → 执行蒸馏 → 逐条校验技能 JSON 格式、动作类型覆盖、断言非空、匹配率合法、报告完整
// 用法：node replay/distill/selfcheck.js

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { seedMockDb } from './seed-mock-db.js';
import { distillSkill } from './index.js';
import { validateSkillJson } from './src/skill.js';
import { skillsDir } from './src/paths.js';

/** 自检清单项 */
const checks = [];
function addCheck(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail || '' });
}

async function main() {
  // 临时数据库（不污染 daemon 默认库）；技能 JSON 仍按契约落盘到项目 replay/skills/
  const tmpDir = path.join(os.tmpdir(), 'behavior-distill-selfcheck');
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'behavior.db');

  let result = null;

  try {
    // 1. 构造 mock 轨迹（契约 §2 Schema，3 条相似会话）
    const seeded = seedMockDb(dbPath);
    addCheck(
      'mock 数据库构造成功（≥2 条相似会话）',
      seeded.sessionCount >= 2 && seeded.behaviorCount > 0,
      `写入 ${seeded.sessionCount} 条会话、${seeded.behaviorCount} 条行为记录；临时库：${dbPath}`
    );

    // 2. 执行蒸馏（契约 §8 D：--domain example.com --min-occurrences 2）
    result = await distillSkill({
      domain: 'example.com',
      dbPath,
      minOccurrences: 2,
      maxSteps: 20,
      topN: 5,
    });

    addCheck('蒸馏流程成功产出技能', result.skills.length >= 1, `共生成 ${result.skills.length} 个技能`);

    // 3. 每个技能：契约 §5 结构校验 + 文件落盘 + JSON 可解析
    let formatOk = true;
    const formatDetails = [];
    for (const item of result.skills) {
      const skill = item.skill;
      const problems = validateSkillJson(skill);
      if (problems.length > 0) {
        formatOk = false;
        formatDetails.push(`${skill.skillId}：${problems.join('；')}`);
      }
      if (!fs.existsSync(skill.path)) {
        formatOk = false;
        formatDetails.push(`${skill.skillId}：技能文件未落盘`);
      } else {
        JSON.parse(fs.readFileSync(skill.path, 'utf8'));
      }
    }
    addCheck('技能 JSON 全部符合契约 §5 格式', formatOk, formatDetails.length ? formatDetails.join('；') : '结构校验全部通过');

    // 4. 动作类型覆盖：navigate / click / input（任务自检要求）
    const typeSet = new Set();
    for (const item of result.skills) {
      for (const action of item.skill.actions) typeSet.add(action.type);
    }
    for (const requiredType of ['navigate', 'click', 'input']) {
      addCheck(
        `动作类型覆盖「${requiredType}」`,
        typeSet.has(requiredType),
        `本次技能动作类型并集：${[...typeSet].join('、')}`
      );
    }

    // 5. 断言字段非空：每个技能至少包含一条断言（text_present / element_present / url_contains / url_change）
    for (const item of result.skills) {
      const assertionCount = item.skill.actions.reduce((sum, a) => sum + a.assertions.length, 0);
      const kinds = [...new Set(item.skill.actions.flatMap((a) => a.assertions.map((x) => x.kind)))];
      addCheck(
        `技能 ${item.skill.skillId} 断言字段非空`,
        assertionCount > 0,
        `共 ${assertionCount} 条断言，类型：${kinds.join('、')}`
      );
    }

    // 6. 匹配率合法且 ≥ minOccurrences / 会话数 方向一致
    for (const item of result.skills) {
      const mr = item.skill.evidence.matchRate;
      addCheck(
        `技能 ${item.skill.skillId} matchRate ∈ [0,1]`,
        typeof mr === 'number' && mr >= 0 && mr <= 1,
        `matchRate=${mr}，trajectoryCount=${item.skill.evidence.trajectoryCount}`
      );
    }

    // 7. 报告完整性：候选链数、技能数、每条技能动作摘要与匹配率均已生成
    const report = result.report;
    const reportOk =
      Number.isInteger(report.candidateCount) &&
      report.skills.length >= 1 &&
      report.skills.every((s) => Number.isFinite(s.skill.evidence.matchRate) && s.skill.actions.length > 0);
    addCheck(
      '中文蒸馏报告字段完整（候选链数 / 技能数 / 动作摘要 / matchRate）',
      reportOk,
      `候选链 ${report.candidateCount} 条，技能 ${report.skills.length} 个，参与会话 ${report.sessionCount} 条`
    );
  } catch (error) {
    addCheck('蒸馏流程未抛出未捕获异常', false, error.message);
  }

  // 打印自检清单
  console.log('================ 模块D 自检清单（对照契约 §8 模块D） ================');
  let allPass = true;
  for (const check of checks) {
    if (!check.pass) allPass = false;
    console.log(`${check.pass ? '[通过]' : '[失败]'} ${check.name}`);
    if (check.detail) console.log(`        ${check.detail}`);
  }
  console.log('==================================================================');

  // 打印产物清单
  if (result && result.skills.length > 0) {
    console.log('\n蒸馏产物清单：');
    for (const item of result.skills) {
      const s = item.skill;
      const actionSummary = s.actions.map((a) => a.type).join(' → ');
      console.log(`  - ${s.skillId}｜${s.name}｜匹配率 ${(s.evidence.matchRate * 100).toFixed(1)}%`);
      console.log(`    动作链：${actionSummary}`);
      console.log(`    文件：${s.path}`);
      console.log(`    索引注册：${item.registerResult.message}`);
    }
  }
  console.log(`\n技能输出目录：${skillsDir}`);
  console.log(allPass ? '\n自检结论：全部通过 ✔' : '\n自检结论：存在未通过项 ✘');

  process.exit(allPass ? 0 : 1);
}

main();
