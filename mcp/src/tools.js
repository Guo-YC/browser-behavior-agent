/**
 * MCP 工具集定义（契约 §4：共 10 个工具，名称/入参/中文描述严格对齐契约表格）。
 * 设计要点：
 *  - 查询类工具走 daemon HTTP API（daemonClient.js）；
 *  - distill_skill / trigger_replay 通过动态 import() 调用 replay 模块（replayBridge.js）；
 *  - 所有工具返回 JSON 字符串；任何异常都包装为含中文错误信息的 isError 结果，不向客户端抛未捕获异常；
 *  - 必填参数由工具内部手工校验，确保缺失时返回中文错误 JSON。
 */
import { z } from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { daemonGet, daemonHealth } from './daemonClient.js';
import { callDistillSkill, readSkillFile, callRunSkill } from './replayBridge.js';

/* ------------------------- 通用结果与校验辅助 ------------------------- */

/** 成功结果：把数据序列化为 JSON 文本返回 */
function okResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** 错误结果：中文错误信息包成 JSON，标记 isError 供客户端识别 */
function errResult(message) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/** 必填参数校验：空字符串/undefined/null 均视为缺失 */
function requireArg(args, key, label) {
  const value = args[key];
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: false, message: `缺少必填参数「${label}」（${key}），请补充后重试。` };
  }
  return { ok: true, value: String(value).trim() };
}

/** 可选数值参数转数字；空值返回 undefined */
function toNum(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 把工具执行体统一包一层 try/catch，异常转中文错误结果 */
function wrap(handler) {
  return async (args) => {
    try {
      return await handler(args || {});
    } catch (err) {
      return errResult(err && err.message ? err.message : `工具执行异常：${String(err)}`);
    }
  };
}

/* ------------------------- 公共可选参数 schema 片段 ------------------------- */

const strOpt = (label) => z.string().optional().describe(label);
const numOpt = (label) => z.number().int().optional().describe(label);
const boolOpt = (label) => z.boolean().optional().describe(label);

/* ------------------------- 10 个工具的内部实现 ------------------------- */

/** 1. list_sites：列出已采集的网站（域名）及事件量 */
async function handleListSites() {
  const sites = await daemonGet('/api/sites');
  return okResult({ count: Array.isArray(sites) ? sites.length : 0, sites: Array.isArray(sites) ? sites : [] });
}

/** 2. query_behaviors：按网站查询行为记录 */
async function handleQueryBehaviors(args) {
  const domain = requireArg(args, 'domain', '网站域名');
  if (!domain.ok) return errResult(domain.message);
  const data = await daemonGet('/api/behaviors', {
    domain: domain.value,
    sessionId: args.sessionId,
    type: args.type,
    from: toNum(args.from),
    to: toNum(args.to),
    urlContains: args.urlContains,
    limit: toNum(args.limit),
    offset: toNum(args.offset),
  });
  return okResult(data);
}

/** 3. query_sessions：查询某网站的浏览会话列表 */
async function handleQuerySessions(args) {
  const domain = requireArg(args, 'domain', '网站域名');
  if (!domain.ok) return errResult(domain.message);
  const data = await daemonGet('/api/sessions', {
    domain: domain.value,
    from: toNum(args.from),
    to: toNum(args.to),
    limit: toNum(args.limit),
  });
  return okResult(data);
}

/** 4. query_requests：查询采集到的网络请求（已脱敏） */
async function handleQueryRequests(args) {
  const domain = requireArg(args, 'domain', '网站域名');
  if (!domain.ok) return errResult(domain.message);
  const data = await daemonGet('/api/requests', {
    domain: domain.value,
    method: args.method,
    urlContains: args.urlContains,
    status: toNum(args.status),
    from: toNum(args.from),
    to: toNum(args.to),
    limit: toNum(args.limit),
  });
  return okResult(data);
}

/** 5. behavior_stats：行为链路统计（按类型/页面/小时聚合） */
async function handleBehaviorStats(args) {
  const domain = requireArg(args, 'domain', '网站域名');
  if (!domain.ok) return errResult(domain.message);
  const data = await daemonGet('/api/stats', {
    domain: domain.value,
    from: toNum(args.from),
    to: toNum(args.to),
    groupBy: args.groupBy,
  });
  return okResult(data);
}

/** 6. fulltext_search：全文检索行为记录（URL/选择器/元素文本/详情） */
async function handleFulltextSearch(args) {
  const query = requireArg(args, 'query', '检索关键词');
  if (!query.ok) return errResult(query.message);
  const data = await daemonGet('/api/search', {
    q: query.value,
    domain: args.domain,
    limit: toNum(args.limit),
  });
  return okResult({ query: query.value, items: Array.isArray(data) ? data : [] });
}

/** 7. export_trajectory：导出某会话/时间段的行为轨迹（json 或 markdown） */
async function handleExportTrajectory(args) {
  const domain = requireArg(args, 'domain', '网站域名');
  if (!domain.ok) return errResult(domain.message);
  const format = (args.format || 'json').toLowerCase();
  const data = await daemonGet('/api/trajectory', {
    domain: domain.value,
    sessionId: args.sessionId,
    from: toNum(args.from),
    to: toNum(args.to),
  });

  if (format === 'markdown') {
    return okResult({ format: 'markdown', markdown: trajectoryToMarkdown(data) });
  }
  if (format !== 'json') {
    return errResult(`参数 format 仅支持 json 或 markdown，当前取值：${args.format}`);
  }
  return okResult({ format: 'json', ...data });
}

/** 把轨迹事件转成易读 Markdown 时间线 */
function trajectoryToMarkdown(data) {
  const events = (data && Array.isArray(data.events) ? data.events : []);
  const header = [
    `# 行为轨迹导出`,
    ``,
    `- 网站域名：${data && data.domain ? data.domain : '-'}`,
    `- 会话 ID：${data && data.sessionId ? data.sessionId : '（按时间范围聚合，未指定会话）'}`,
    `- 事件总数：${events.length}`,
    ``,
    `| # | 时间(毫秒) | 类型 | 页面 URL | 选择器 | 摘要 |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  const rows = events.map((ev, i) => {
    const summary = summarizeEvent(ev);
    const url = String(ev.url || '').replace(/\|/g, '\\|');
    const selector = String(ev.selector || '').replace(/\|/g, '\\|');
    return `| ${i + 1} | ${ev.ts ?? ''} | ${ev.type ?? ''} | ${url} | ${selector} | ${summary} |`;
  });
  return [...header, ...rows].join('\n');
}

/** 提取单条事件的可读摘要（截断 120 字符） */
function summarizeEvent(ev) {
  const bits = [];
  if (ev.element && typeof ev.element === 'object' && ev.element.text) bits.push(`文本：${ev.element.text}`);
  if (ev.detail && typeof ev.detail === 'object') {
    if (ev.detail.value) bits.push(`输入：${ev.detail.value}`);
    if (ev.detail.method) bits.push(`方法：${ev.detail.method} ${ev.detail.requestUrl || ''}`);
    if (ev.detail.status !== undefined && ev.detail.status !== null) bits.push(`状态：${ev.detail.status}`);
  }
  return bits.join('；').slice(0, 120) || '-';
}

/** 8. distill_skill：从重复行为轨迹中蒸馏可复用技能 */
async function handleDistillSkill(args) {
  const domain = requireArg(args, 'domain', '网站域名');
  if (!domain.ok) return errResult(domain.message);

  // 蒸馏需要读取 daemon 中的轨迹，先确认 daemon 在线，便于给出明确中文引导
  const health = await daemonHealth();
  if (!health.ok) return errResult(health.message);

  const result = await callDistillSkill({
    domain: domain.value,
    name: args.name,
    sessionIds: Array.isArray(args.sessionIds) ? args.sessionIds : undefined,
    minOccurrences: toNum(args.minOccurrences),
    maxSteps: toNum(args.maxSteps),
  });
  return okResult({
    message: '技能蒸馏完成',
    skillId: result && result.skillId,
    path: result && result.path,
  });
}

/** 9. list_skills：列出已蒸馏的技能 */
async function handleListSkills(args) {
  const data = await daemonGet('/api/skills', args.domain ? { domain: args.domain } : undefined);
  return okResult({ count: Array.isArray(data) ? data.length : 0, skills: Array.isArray(data) ? data : [] });
}

/** 10. trigger_replay：按技能执行确定性回放 */
async function handleTriggerReplay(args) {
  const skillId = requireArg(args, 'skillId', '技能 ID');
  if (!skillId.ok) return errResult(skillId.message);

  // 第一步：从 daemon 技能索引中定位技能文件路径
  const skills = await daemonGet('/api/skills');
  const meta = Array.isArray(skills) ? skills.find((s) => s.skillId === skillId.value) : undefined;
  if (!meta) {
    return errResult(`未在守护进程技能索引中找到技能「${skillId.value}」。请先执行 distill_skill 蒸馏技能，或确认 skillId 拼写正确。`);
  }

  // 第二步：读取技能 JSON 文件（契约 §5）
  const skill = await readSkillFile(meta.path);

  // 第三步：调用回放执行器（模式 dry_run / cdp / playwright）
  const mode = (args.mode || 'dry_run');
  if (!['dry_run', 'cdp', 'playwright'].includes(mode)) {
    return errResult(`参数 mode 仅支持 dry_run、cdp、playwright，当前取值：${mode}`);
  }
  const report = await callRunSkill(skill, {
    mode,
    headless: args.headless === true,
    targetUrl: args.targetUrl,
  });
  return okResult({
    message: `回放执行完成（模式：${mode}）`,
    skillId: skillId.value,
    report,
  });
}

/* ------------------------- 工具注册表（供 --list 与双传输共用） ------------------------- */

/**
 * 工具元数据：name + 完整中文 description（给 AI 看，含参数含义与示例）。
 * --list 模式直接输出本表；服务端注册时按本表逐个挂载 handler。
 */
export const TOOL_DEFS = [
  {
    name: 'list_sites',
    description:
      '列出本地已采集行为数据的全部网站（域名），返回每个域名的首次采集时间、最近采集时间、事件总量与状态。无入参。示例：直接调用即可得到 sites 列表，供后续按 domain 过滤查询。',
    schema: z.object({}),
    handler: handleListSites,
  },
  {
    name: 'query_behaviors',
    description:
      '按网站域名查询行为记录（点击 click、双击 dblclick、输入 input、滚动 scroll、导航 navigation、页面加载 page_load 等）。必填参数 domain（小写域名，如 example.com）；可选参数：sessionId（限定某一会话）、type（限定事件类型，如 click/input/scroll）、from（起始时间，毫秒时间戳数字）、to（结束时间，毫秒时间戳数字）、urlContains（URL 包含的子串）、limit（返回条数上限，默认 200）、offset（分页偏移，默认 0）。示例：domain="example.com", type="click", from=1730000000000, limit=50。',
    schema: z.object({
      domain: strOpt('网站域名（必填），小写主机名，如 example.com'),
      sessionId: strOpt('会话 ID（可选），限定只查该 tab 会话的事件'),
      type: strOpt('事件类型（可选），如 click、input、scroll、navigation、page_load'),
      from: numOpt('起始时间（可选），Unix 毫秒时间戳，如 1730000000000'),
      to: numOpt('结束时间（可选），Unix 毫秒时间戳，如 1730000600000'),
      urlContains: strOpt('URL 子串过滤（可选），如 /cart'),
      limit: numOpt('返回条数上限（可选），默认 200'),
      offset: numOpt('分页偏移量（可选），默认 0'),
    }),
    handler: handleQueryBehaviors,
  },
  {
    name: 'query_sessions',
    description:
      '查询某网站的浏览会话（tab 级会话）列表，返回会话 ID、起止时间、页面数、事件数、User-Agent、屏幕尺寸。必填参数 domain；可选参数：from（毫秒时间戳）、to（毫秒时间戳）、limit（默认 100）。示例：domain="example.com", from=1729900000000, limit=20。',
    schema: z.object({
      domain: strOpt('网站域名（必填），小写主机名，如 example.com'),
      from: numOpt('起始时间（可选），Unix 毫秒时间戳'),
      to: numOpt('结束时间（可选），Unix 毫秒时间戳'),
      limit: numOpt('返回条数上限（可选），默认 100'),
    }),
    handler: handleQuerySessions,
  },
  {
    name: 'query_requests',
    description:
      '查询该网站采集到的网络请求记录（请求头、Cookie、令牌等敏感字段已在采集层脱敏，不会返回原文）。必填参数 domain；可选参数：method（HTTP 方法 GET/POST 等）、urlContains（URL 子串）、status（HTTP 状态码数字）、from（毫秒时间戳）、to（毫秒时间戳）、limit（默认 200）。示例：domain="example.com", method="GET", status=200, urlContains="/api/"。',
    schema: z.object({
      domain: strOpt('网站域名（必填），小写主机名'),
      method: strOpt('HTTP 方法（可选），如 GET、POST'),
      urlContains: strOpt('URL 子串过滤（可选）'),
      status: numOpt('HTTP 状态码（可选），如 200、404、500'),
      from: numOpt('起始时间（可选），Unix 毫秒时间戳'),
      to: numOpt('结束时间（可选），Unix 毫秒时间戳'),
      limit: numOpt('返回条数上限（可选），默认 200'),
    }),
    handler: handleQueryRequests,
  },
  {
    name: 'behavior_stats',
    description:
      '行为链路聚合统计：按事件类型、页面或小时分组计数。必填参数 domain；可选参数：from（毫秒时间戳）、to（毫秒时间戳）、groupBy（分组维度：type 按事件类型 / page 按页面 URL / hour 按小时，默认 type）。返回 [{key, count}]。示例：domain="example.com", groupBy="type", from=1730000000000。',
    schema: z.object({
      domain: strOpt('网站域名（必填），小写主机名'),
      from: numOpt('起始时间（可选），Unix 毫秒时间戳'),
      to: numOpt('结束时间（可选），Unix 毫秒时间戳'),
      groupBy: strOpt('分组维度（可选）：type=事件类型，page=页面，hour=小时；默认 type'),
    }),
    handler: handleBehaviorStats,
  },
  {
    name: 'fulltext_search',
    description:
      '基于 FTS5 的全文检索，匹配行为记录中的 URL、CSS 选择器、元素文本、事件详情文本。必填参数 query（检索关键词）；可选参数：domain（限定网站域名）、limit（命中条数上限，默认 50）。返回命中记录及高亮片段 snippet。示例：query="加入购物车", domain="example.com", limit=10。',
    schema: z.object({
      query: strOpt('检索关键词（必填），可匹配 URL、选择器、元素文本、详情'),
      domain: strOpt('限定网站域名（可选）'),
      limit: numOpt('命中条数上限（可选），默认 50'),
    }),
    handler: handleFulltextSearch,
  },
  {
    name: 'export_trajectory',
    description:
      '导出某会话或某时间段内按时间升序排列的完整行为轨迹。必填参数 domain；可选参数：sessionId（指定单个会话；不传则按时间范围聚合该域名下所有会话）、from（毫秒时间戳）、to（毫秒时间戳）、format（导出格式：json 默认原始事件数组；markdown 生成便于阅读的 Markdown 时间线表格）。示例：domain="example.com", sessionId="s_abc123", format="markdown"。',
    schema: z.object({
      domain: strOpt('网站域名（必填），小写主机名'),
      sessionId: strOpt('会话 ID（可选）；不传时按时间范围聚合'),
      from: numOpt('起始时间（可选），Unix 毫秒时间戳'),
      to: numOpt('结束时间（可选），Unix 毫秒时间戳'),
      format: strOpt('导出格式（可选）：json（默认）或 markdown'),
    }),
    handler: handleExportTrajectory,
  },
  {
    name: 'distill_skill',
    description:
      '从指定网站的重复行为轨迹中蒸馏出可复用技能（示范学习：在 ≥minOccurrences 条轨迹中挖掘重复动作链，生成契约 §5 格式的技能 JSON 并写入 replay/skills/ 目录、注册到 daemon 技能索引）。必填参数 domain；可选参数：name（技能名称，如「下单流程」）、sessionIds（指定参与蒸馏的会话 ID 数组；不传则使用该域名全部会话）、minOccurrences（重复次数阈值，默认 2）、maxSteps（单条动作链最大步数，默认 20）。示例：domain="example.com", name="加入购物车并下单", minOccurrences=2, maxSteps=15。返回 skillId 与技能文件路径。注意：执行前请确保 daemon 已启动。',
    schema: z.object({
      domain: strOpt('网站域名（必填），小写主机名'),
      name: strOpt('技能名称（可选），如「下单流程」'),
      sessionIds: z.array(z.string()).optional().describe('参与蒸馏的会话 ID 数组（可选）；不传则用全部会话'),
      minOccurrences: numOpt('重复出现次数阈值（可选），默认 2'),
      maxSteps: numOpt('动作链最大步数（可选），默认 20'),
    }),
    handler: handleDistillSkill,
  },
  {
    name: 'list_skills',
    description:
      '列出本地已蒸馏的全部技能（技能 ID、名称、域名、描述、文件路径、版本、创建/更新时间）。可选参数 domain（按域名过滤）。示例：domain="example.com"；不传则列出全部技能。',
    schema: z.object({
      domain: strOpt('按域名过滤（可选）'),
    }),
    handler: handleListSkills,
  },
  {
    name: 'trigger_replay',
    description:
      '按已蒸馏技能执行确定性回放。必填参数 skillId（技能 ID，可先用 list_skills 查询）；可选参数：mode（回放模式：dry_run 默认，不连浏览器只做动作校验并输出执行计划；cdp 通过 Chrome 远程调试端口 9222 真实操作；playwright 使用本机 Chrome 真实点击输入）、headless（是否无头运行，布尔值，默认 false）、targetUrl（回放目标 URL，覆盖技能内 targetUrlPattern）。示例：skillId="skl_xxxxxxxx", mode="dry_run", headless=false。返回逐步 PASS/FAIL/SKIP 中文报告。注意：cdp/playwright 模式需要本机浏览器与回放模块（replay/runner）就绪。',
    schema: z.object({
      skillId: strOpt('技能 ID（必填），来自 list_skills 或 distill_skill 返回值'),
      mode: strOpt('回放模式（可选）：dry_run（默认）/ cdp / playwright'),
      headless: boolOpt('是否无头模式运行浏览器（可选），默认 false'),
      targetUrl: strOpt('回放目标 URL（可选），覆盖技能内目标 URL 匹配规则'),
    }),
    handler: handleTriggerReplay,
  },
];

/**
 * 创建一个注册完全部 10 个工具的 McpServer 实例。
 * stdio 与 Streamable HTTP 每个会话各持一份独立实例（SDK 会话化部署惯例）。
 * @returns {McpServer}
 */
export function createBehaviorServer() {
  const server = new McpServer(
    { name: 'browser-behavior-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.schema },
      wrap(def.handler)
    );
  }
  return server;
}
