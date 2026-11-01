// httpServer.js —— HTTP API 层（契约 §3）。仅使用 Node 内置 http 模块，
// 前缀 /api；除 /health 外均返回 JSON；错误统一 {"error":"中文描述"}。
import http from 'node:http';

// 单条消息体积上限 1MB（契约 §1.1：单条消息 ≤1MB，超限由扩展拆包）
const MAX_BODY_BYTES = 1024 * 1024;

// 发送 JSON 响应
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 读取并解析 POST JSON 请求体；超限或非法 JSON 返回错误信息
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 1MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 从 URL 查询串取可选参数
function q(params, name) {
  return params.get(name) ?? undefined;
}

/**
 * 创建 HTTP 服务实例
 * @param {import('./store.js').Store} store 存储层实例
 * @param {{port:number, host:string}} config 配置
 * @returns {http.Server}
 */
export function createHttpServer(store, config) {
  const startTime = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const params = url.searchParams;

    try {
      // ---- GET /health（契约 §3：无需前缀，无需鉴权）----
      if (req.method === 'GET' && pathname === '/health') {
        const health = store.health(Math.floor((Date.now() - startTime) / 1000));
        return sendJson(res, 200, health);
      }

      // ---- POST /api/events：调试/批量事件通道（信封与 Native batch 一致，契约 §1.1）----
      if (req.method === 'POST' && pathname === '/api/events') {
        const body = await readJsonBody(req);
        const events = Array.isArray(body.events) ? body.events : [];
        const result = store.ingestBatch(events);
        return sendJson(res, 200, { ok: true, ...result });
      }

      // ---- GET /api/sites ----
      if (req.method === 'GET' && pathname === '/api/sites') {
        return sendJson(res, 200, store.querySites());
      }

      // ---- GET /api/sessions（domain 必填）----
      if (req.method === 'GET' && pathname === '/api/sessions') {
        const domain = q(params, 'domain');
        if (!domain) return sendJson(res, 400, { error: '缺少必填参数 domain' });
        const rows = store.querySessions({
          domain,
          from: q(params, 'from'),
          to: q(params, 'to'),
          limit: q(params, 'limit') ?? 100,
        });
        return sendJson(res, 200, rows);
      }

      // ---- GET /api/behaviors（domain 必填）----
      if (req.method === 'GET' && pathname === '/api/behaviors') {
        const domain = q(params, 'domain');
        if (!domain) return sendJson(res, 400, { error: '缺少必填参数 domain' });
        const result = store.queryBehaviors({
          domain,
          sessionId: q(params, 'sessionId'),
          type: q(params, 'type'),
          from: q(params, 'from'),
          to: q(params, 'to'),
          urlContains: q(params, 'urlContains'),
          limit: q(params, 'limit') ?? 200,
          offset: q(params, 'offset') ?? 0,
        });
        return sendJson(res, 200, result);
      }

      // ---- GET /api/requests（domain 必填）----
      if (req.method === 'GET' && pathname === '/api/requests') {
        const domain = q(params, 'domain');
        if (!domain) return sendJson(res, 400, { error: '缺少必填参数 domain' });
        const result = store.queryRequests({
          domain,
          method: q(params, 'method'),
          urlContains: q(params, 'urlContains'),
          status: q(params, 'status'),
          from: q(params, 'from'),
          to: q(params, 'to'),
          limit: q(params, 'limit') ?? 200,
        });
        return sendJson(res, 200, result);
      }

      // ---- GET /api/stats（domain 必填；groupBy = type|page|hour）----
      if (req.method === 'GET' && pathname === '/api/stats') {
        const domain = q(params, 'domain');
        if (!domain) return sendJson(res, 400, { error: '缺少必填参数 domain' });
        const groupBy = q(params, 'groupBy') || 'type';
        if (!['type', 'page', 'hour'].includes(groupBy)) {
          return sendJson(res, 400, { error: 'groupBy 仅支持 type、page、hour' });
        }
        const rows = store.queryStats({
          domain,
          from: q(params, 'from'),
          to: q(params, 'to'),
          groupBy,
        });
        return sendJson(res, 200, rows);
      }

      // ---- GET /api/search：q 必填 ----
      if (req.method === 'GET' && pathname === '/api/search') {
        const queryText = q(params, 'q');
        if (!queryText) return sendJson(res, 400, { error: '缺少必填参数 q' });
        const rows = store.search(queryText, q(params, 'domain'), q(params, 'limit') ?? 50);
        return sendJson(res, 200, rows);
      }

      // ---- GET /api/trajectory（domain 必填）----
      if (req.method === 'GET' && pathname === '/api/trajectory') {
        const domain = q(params, 'domain');
        if (!domain) return sendJson(res, 400, { error: '缺少必填参数 domain' });
        const result = store.trajectory({
          domain,
          sessionId: q(params, 'sessionId'),
          from: q(params, 'from'),
          to: q(params, 'to'),
        });
        return sendJson(res, 200, result);
      }

      // ---- GET /api/skills ----
      if (req.method === 'GET' && pathname === '/api/skills') {
        return sendJson(res, 200, store.listSkills(q(params, 'domain')));
      }

      // ---- POST /api/skills：注册/更新技能索引 ----
      if (req.method === 'POST' && pathname === '/api/skills') {
        const body = await readJsonBody(req);
        store.upsertSkill(body);
        return sendJson(res, 200, { ok: true });
      }

      // ---- POST /api/sessions/close：手动关闭会话 ----
      if (req.method === 'POST' && pathname === '/api/sessions/close') {
        const body = await readJsonBody(req);
        if (!body.sessionId) return sendJson(res, 400, { error: '缺少必填字段 sessionId' });
        const result = store.closeSession(body.sessionId);
        return sendJson(res, 200, { ok: true, closed: result.closed });
      }

      // 未匹配路由
      return sendJson(res, 404, { error: `接口不存在：${req.method} ${pathname}` });
    } catch (err) {
      // 统一错误格式（契约 §3：错误统一 {"error":"中文描述"}）
      return sendJson(res, 500, { error: err.message || '服务器内部错误' });
    }
  });

  return server;
}
