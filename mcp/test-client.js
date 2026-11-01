#!/usr/bin/env node
/**
 * 最小 stdio MCP 自检/演示客户端（使用同一套 SDK 的 Client）。
 *
 * 用法：
 *   node mcp/test-client.js list                        列出服务端全部工具
 *   node mcp/test-client.js call list_sites              调用 list_sites（无入参）
 *   node mcp/test-client.js call query_behaviors --domain example.com --limit 20
 *   node mcp/test-client.js call fulltext_search --query 购物车
 *
 * 参数类型自动识别：纯数字转 Number，true/false 转布尔，JSON 字符串转对象，其余按字符串。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, 'index.js');

/** 把命令行字符串值转成合适的类型 */
function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^[\[{].*[\]}]$/.test(value)) {
    try { return JSON.parse(value); } catch { /* 保持字符串 */ }
  }
  return value;
}

/** 解析 `--key value` 形式参数为 arguments 对象 */
function parseCliArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result[key] = coerce(next);
        i += 1;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

function usage() {
  console.log([
    '用法：',
    '  node test-client.js list',
    '  node test-client.js call <工具名> [--参数 值] ...',
    '',
    '示例：',
    '  node test-client.js call list_sites',
    '  node test-client.js call query_sessions --domain example.com --limit 20',
    '  node test-client.js call fulltext_search --query 购物车 --domain example.com',
  ].join('\n'));
}

async function main() {
  const [, , command, toolName, ...rest] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }

  // 以 stdio 子进程方式拉起本模块服务端
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: process.env,
  });
  const client = new Client(
    { name: 'behavior-mcp-test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    if (command === 'list') {
      const { tools } = await client.listTools();
      console.log(`服务端共注册 ${tools.length} 个工具：\n`);
      tools.forEach((tool, i) => {
        console.log(`${String(i + 1).padStart(2, ' ')}. ${tool.name}`);
        console.log(`    ${tool.description}\n`);
      });
    } else if (command === 'call') {
      if (!toolName) {
        usage();
        throw new Error('缺少要调用的工具名。');
      }
      const callArgs = parseCliArgs(rest);
      console.log(`> 调用工具：${toolName}`);
      if (Object.keys(callArgs).length) console.log(`> 入参：${JSON.stringify(callArgs, null, 2)}`);
      console.log('> 返回：');
      const result = await client.callTool({ name: toolName, arguments: callArgs });
      for (const item of result.content || []) {
        if (item.type === 'text') console.log(item.text);
        else console.log(JSON.stringify(item));
      }
      if (result.isError) process.exitCode = 1;
    } else {
      usage();
      throw new Error(`未知命令：${command}（支持 list / call）`);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[test-client] ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
