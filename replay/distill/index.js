#!/usr/bin/env node
// 模块D：技能蒸馏 CLI 入口 + ESM 导出（契约 §4 distill_skill 工具、§7 全流程、§8 模块D验收）
// 用法：node replay/distill/index.js --domain <域名> [选项]
import { openReadOnlyDb, loadTrajectories } from './src/db.js';
import { cleanAllSessions } from './src/clean.js';
import { mineChains } from './src/mine.js';
import { assembleSkill, writeSkillFile, registerSkill, validateSkillJson } from './src/skill.js';
import { printReport } from './src/report.js';
import { resolveDbPath } from './src/paths.js';
import { pathToFileURL } from 'node:url';

/** 中文帮助文本 */
const HELP_TEXT = `
浏览器行为采集系统 · 模块D 技能蒸馏工具

用法：
  node replay/distill/index.js --domain <域名> [选项]

必填参数：
  --domain <域名>          要蒸馏的网站域名（小写 hostname，如 example.com）

可选参数：
  --name <技能名>          技能名称；不传则按动作链自动生成
  --session-ids <a,b,c>    仅使用指定会话 id（逗号分隔）；不传则取该站点全部会话
  --min-occurrences <数>   动作链最少出现会话数，默认 2
  --max-steps <数>         动作链最大长度，默认 20
  --top-n <数>             按评分保留前 N 条链生成技能，默认 5
  --db-path <路径>         指定 daemon 数据库文件路径；缺省读环境变量 DB_PATH，再缺省用项目默认路径
  --help, -h               显示本帮助

环境变量：
  DB_PATH                  daemon 数据库路径（默认 <项目根>/daemon/data/behavior.db）
  DAEMON_URL              daemon HTTP 地址（默认 http://127.0.0.1:8756）

说明：
  1. 本工具以只读模式直连 daemon 数据库，不修改采集数据；
  2. 蒸馏结果写入 replay/skills/<skillId>.json，并尽力调用 daemon POST /api/skills 注册索引；
  3. daemon 未启动时仅打印中文警告，不阻塞技能文件落盘。
`;

/** 解析命令行参数 */
function parseArgs(argv) {
  const opts = {
    domain: undefined,
    name: undefined,
    sessionIds: undefined,
    minOccurrences: 2,
    maxSteps: 20,
    topN: 5,
    dbPath: undefined,
    help: false,
  };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--domain':
        opts.domain = args[++i];
        break;
      case '--name':
        opts.name = args[++i];
        break;
      case '--session-ids':
        opts.sessionIds = String(args[++i] || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--min-occurrences':
        opts.minOccurrences = Number(args[++i]);
        break;
      case '--max-steps':
        opts.maxSteps = Number(args[++i]);
        break;
      case '--top-n':
        opts.topN = Number(args[++i]);
        break;
      case '--db-path':
        opts.dbPath = args[++i];
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`未知参数：${arg}；使用 --help 查看完整参数说明。`);
        }
        throw new Error(`无法识别的命令行内容：${arg}；使用 --help 查看完整参数说明。`);
    }
  }
  return opts;
}

/**
 * 技能蒸馏主流程（供 MCP 模块C 通过 import 调用，契约 §4 distill_skill）
 * @param {object} opts
 * @param {string} opts.domain 必填，域名
 * @param {string} [opts.name] 技能名
 * @param {string[]} [opts.sessionIds] 指定会话列表
 * @param {number} [opts.minOccurrences] 最小出现会话数，默认 2
 * @param {number} [opts.maxSteps] 链长上限，默认 20
 * @param {number} [opts.topN] 保留前 N 条，默认 5
 * @param {string} [opts.dbPath] 数据库路径覆盖
 * @returns {Promise<{skillId?:string, path?:string, skills:object[], report:object}>}
 */
export async function distillSkill(opts = {}) {
  if (!opts.domain) {
    throw new Error('缺少必填参数 domain（域名），请通过 --domain <域名> 传入。');
  }
  const minOccurrences = Number(opts.minOccurrences ?? 2);
  const maxSteps = Number(opts.maxSteps ?? 20);
  const topN = Number(opts.topN ?? 5);

  if (!Number.isFinite(minOccurrences) || minOccurrences < 1) {
    throw new Error('minOccurrences 必须是 ≥1 的整数。');
  }
  if (!Number.isFinite(maxSteps) || maxSteps < 3) {
    throw new Error('maxSteps 必须是 ≥3 的整数。');
  }

  // 1. 只读打开 daemon 数据库并读取轨迹（契约 §7 第1步）
  const db = openReadOnlyDb(opts.dbPath);
  let loaded;
  try {
    loaded = loadTrajectories(db, { domain: opts.domain, sessionIds: opts.sessionIds });
  } finally {
    db.close();
  }

  const rawSessions = loaded.sessions;

  // 2. 轨迹清洗 + 动作序列化（契约 §7 第2、3步）
  const { cleaned, droppedSessionIds } = cleanAllSessions(rawSessions);
  if (cleaned.size === 0) {
    throw new Error('清洗后没有可分析的动作序列，无法蒸馏技能。');
  }

  // 3. 前缀树挖掘重复动作链 + 评分（契约 §7 第4、5步）
  const { candidates, totalSessions, rawCandidateCount } = mineChains(cleaned, {
    minOccurrences,
    maxSteps,
  });
  const selected = candidates.slice(0, topN);

  // 4. 逐条组装技能、落盘、注册索引（契约 §5、§3）
  const timestamp = Date.now();
  const skills = [];
  for (const chain of selected) {
    const { skill, skillPath } = assembleSkill({
      chain,
      cleaned,
      rawSessions,
      totalSessions,
      domain: opts.domain,
      name: opts.name,
      timestamp,
    });
    skill.path = skillPath;

    // 落盘前按契约 §5 自检结构；结构不合法时记录问题并跳过注册
    const problems = validateSkillJson(skill);
    if (problems.length > 0) {
      throw new Error(`技能结构校验未通过：\n  - ${problems.join('\n  - ')}`);
    }

    writeSkillFile(skill, skillPath);
    const registerResult = await registerSkill(skill);
    skills.push({ skill, registerResult, score: chain.score });
  }

  const report = {
    domain: opts.domain,
    dbPath: resolveDbPath(opts.dbPath),
    sessionCount: rawSessions.size,
    cleanedSessionCount: cleaned.size,
    droppedCount: droppedSessionIds.length,
    eventCount: loaded.eventCount,
    candidateCount: rawCandidateCount,
    chainCount: candidates.length,
    minOccurrences,
    maxSteps,
    topN,
    skills,
  };

  // 返回 MCP 所需的主技能标识，同时保留完整报告供上层使用
  const primary = skills[0];
  return {
    skillId: primary?.skill.skillId,
    path: primary?.skill.path,
    skills,
    report,
  };
}

/** CLI 主入口 */
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (error) {
    console.error(`参数错误：${error.message}`);
    process.exit(1);
  }

  if (opts.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (!opts.domain) {
    console.log(HELP_TEXT);
    console.error('错误：缺少必填参数 --domain <域名>。');
    process.exit(1);
  }

  try {
    const result = await distillSkill(opts);
    printReport(result.report);
  } catch (error) {
    console.error(`蒸馏失败：${error.message}`);
    process.exit(1);
  }
}

// 仅在被 CLI 直接执行时启动主流程；被 import 时不自动运行
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
