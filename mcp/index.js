#!/usr/bin/env node
/**
 * 浏览器行为采集系统模块C：MCP Server 入口。
 *
 * 传输方式（契约 §4、§8）：
 *  - 默认 stdio：        node mcp/index.js
 *  - Streamable HTTP：  node mcp/index.js --http --port 8765（端点 /mcp）
 *  - 仅列出工具后退出：  node mcp/index.js --list
 *
 * 环境变量：
 *  - DAEMON_URL：本地 daemon HTTP 地址，默认 http://127.0.0.1:8756
 *  - REPLAY_DIR：replay（蒸馏/回放）模块目录，默认 mcp/../replay
 *  - DB_PATH：数据库路径（保留项）
 */
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBehaviorServer, TOOL_DEFS } from './src/tools.js';
import { DAEMON_URL, REPLAY_DIR } from './src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------- 命令行参数解析 ------------------------- */

const args = parseArgs({
  options: {
    http: { type: 'boolean', default: false, description: '启用 Streamable HTTP 传输（默认 stdio）' },
    port: { type: 'string', default: process.env.PORT || '8765', description: 'HTTP 端口号，默认 8765' },
    host: { type: 'string', default: '127.0.0.1', description: 'HTTP 监听地址，默认 127.0.0.1' },
    list: { type: 'boolean', default: false, description: '仅列出全部工具后退出' },
    help: { type: 'boolean', default: false, description: '打印中文帮助' },
  },
  allowPositionals: false,
});

/** 中文帮助文本 */
function printHelp() {
  console.log([
    '浏览器行为采集 MCP Server（模块C）',
    '',
    '用法：',
    '  node index.js                          以 stdio 传输启动（默认，供 MCP 客户端接入）',
    '  node index.js --http [--port 8765]    以 Streamable HTTP 传输启动，端点 /mcp',
    '  node index.js --list                   列出全部工具名称与描述后退出',
    '  node index.js --help                   打印本帮助',
    '',
    '环境变量：',
    `  DAEMON_URL  本地守护进程 HTTP 地址（默认 http://127.0.0.1:8756）`,
    `  REPLAY_DIR  replay 模块目录（默认 ${path.resolve(__dirname, '..', 'replay')}）`,
    '  DB_PATH     数据库路径（保留项）',
    '',
    '工具清单：',
    ...TOOL_DEFS.map((t, i) => `  ${i + 1}. ${t.name}：${t.description.split('。')[0]}。`),
  ].join('\n'));
}

/* ------------------------- --list：仅列出工具后退出 ------------------------- */

function runList() {
  console.log(`共注册 ${TOOL_DEFS.length} 个 MCP 工具：\n`);
  TOOL_DEFS.forEach((tool, i) => {
    console.log(`${String(i + 1).padStart(2, ' ')}. ${tool.name}`);
    console.log(`    ${tool.description}\n`);
  });
  console.log(`当前 daemon 地址：${DAEMON_URL}`);
  console.log(`当前 replay 目录：${REPLAY_DIR}`);
}

/* ------------------------- stdio 模式 ------------------------- */

async function runStdio() {
  const server = createBehaviorServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 提示信息一律走 stderr，避免污染 stdio JSON-RPC 通道
  console.error('[browser-behavior-mcp] 已通过 stdio 传输启动，等待客户端连接…');
  console.error(`[browser-behavior-mcp] daemon：${DAEMON_URL}；replay：${REPLAY_DIR}`);
}

/* ------------------------- Streamable HTTP 模式 ------------------------- */

/** 会话表：sessionId -> { transport, server, lastActive } */
const sessions = new Map();
/** 会话空闲超时（30 分钟），与契约会话生命周期保持一致 */
const SESSION_IDLE_MS = 30 * 60 * 1000;

/** 读取请求体为原始字符串 */
async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** 统一中文错误响应（JSON） */
function sendJsonError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}

/** 启动 Streamable HTTP 服务 */
async function runHttp() {
  const port = Number(args.values.port) || 8765;
  const host = args.values.host || '127.0.0.1';

  const httpServer = http.createServer(async (req, res) => {
    try {
      const urlPath = (req.url || '').split('?')[0];
      if (urlPath !== '/mcp') {
        sendJsonError(res, 404, `仅提供 /mcp 端点，当前路径：${urlPath}`);
        return;
      }

      const sid = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : undefined;

      /* GET：建立独立 SSE 发现流（契约：正确处理 GET） */
      if (req.method === 'GET') {
        const session = sid ? sessions.get(sid) : undefined;
        if (!session) {
          sendJsonError(res, sid ? 404 : 400, sid ? '会话不存在或已过期，请重新发起 initialize 连接。' : '缺少 mcp-session-id 请求头。');
          return;
        }
        session.lastActive = Date.now();
        await session.transport.handleRequest(req, res);
        return;
      }

      /* DELETE：关闭会话（契约：正确处理 DELETE） */
      if (req.method === 'DELETE') {
        const session = sid ? sessions.get(sid) : undefined;
        if (session) {
          await session.transport.close();
          sessions.delete(sid);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, message: '会话已关闭。' }));
        return;
      }

      /* POST：初始化新建会话，后续消息复用会话传输 */
      if (req.method === 'POST') {
        const raw = await readRequestBody(req);
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }

        let session = sid ? sessions.get(sid) : undefined;

        if (!session) {
          // 无会话 ID：只接受 initialize 请求，其余按规范拒绝
          if (!body || body.method !== 'initialize') {
            sendJsonError(res, sid ? 404 : 400, sid ? '会话不存在或已过期。' : '缺少会话 ID；请先发送 initialize 请求建立会话。');
            return;
          }
          // 每个会话一份独立 McpServer + Transport（SDK 会话化部署惯例）
          const server = createBehaviorServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (newSid) => {
              sessions.set(newSid, { transport, server, lastActive: Date.now() });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        session.lastActive = Date.now();
        await session.transport.handleRequest(req, res, body);
        return;
      }

      sendJsonError(res, 405, `不支持的 HTTP 方法：${req.method}（仅支持 GET / POST / DELETE）。`);
    } catch (err) {
      if (!res.headersSent) sendJsonError(res, 500, `服务端内部错误：${err && err.message ? err.message : String(err)}`);
      else res.end();
    }
  });

  /* 定时清理空闲会话 */
  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [sid, session] of sessions.entries()) {
      if (session.lastActive < cutoff) {
        session.transport.close().catch(() => {});
        sessions.delete(sid);
      }
    }
  }, SESSION_IDLE_MS).unref();

  httpServer.listen(port, host, () => {
    console.error(`[browser-behavior-mcp] Streamable HTTP 已启动：http://${host}:${port}/mcp`);
    console.error(`[browser-behavior-mcp] daemon：${DAEMON_URL}；replay：${REPLAY_DIR}`);
  });

  httpServer.on('error', (err) => {
    console.error(`[browser-behavior-mcp] HTTP 服务启动失败：${err.message}`);
    process.exit(1);
  });
}

/* ------------------------- 入口分发 ------------------------- */

async function main() {
  if (args.values.help) {
    printHelp();
    return;
  }
  if (args.values.list) {
    runList();
    return;
  }
  if (args.values.http) {
    await runHttp();
    return;
  }
  await runStdio();
}

main().catch((err) => {
  console.error(`[browser-behavior-mcp] 启动失败：${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
