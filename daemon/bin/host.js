#!/usr/bin/env node
// host.js —— Native Messaging host 入口（契约 §1.1）。
// 帧格式：4 字节小端长度前缀 + UTF-8 JSON；收到 batch/ping 各回一帧 {ok:true,...}。
// 严禁向 stdout 写任何日志（日志一律走 stderr，否则会被 Chrome 当作消息帧）。
// 说明：host 进程被 Chrome 反复拉起/杀死是常态；写库逐消息独立事务，WAL + busy_timeout 支持并发写。

import { config } from '../src/config.js';
import { Store } from '../src/store.js';

// 打开同一套存储层核心（与 server 模式复用完全一致的入库与查询逻辑）
const store = new Store(config.dbPath);
store.init();
store.setIdleTimeout(config.idleTimeoutMs);

// 发送一帧：JSON → 4 字节小端长度前缀 + 负载，写入 stdout
function sendMessage(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0); // Chrome Native Messaging 固定小端
  process.stdout.write(Buffer.concat([header, payload]));
}

// 日志走 stderr，绝不进入 stdout
function log(...args) {
  process.stderr.write(`[behavior-host ${new Date().toISOString()}] ${args.join(' ')}\n`);
}

// 粘包拆包状态机：一次 data 可能含半帧/整帧/多帧
let buffer = Buffer.alloc(0);

function processBuffer() {
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break; // body 未到齐，等待下一块
    const body = buffer.slice(4, 4 + length);
    buffer = buffer.slice(4 + length);

    let msg;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch (err) {
      log(`非法 JSON 帧：${err.message}`);
      continue;
    }
    handleMessage(msg);
  }
}

// 消息分发：batch 入库；ping 回 pong；其余回未知类型错误
function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    sendMessage({ ok: false, error: '消息必须为 JSON 对象' });
    return;
  }
  switch (msg.type) {
    case 'ping':
      sendMessage({ ok: true, pong: true });
      return;
    case 'batch': {
      try {
        const result = store.ingestBatch(Array.isArray(msg.events) ? msg.events : []);
        sendMessage({ ok: true, ...result });
      } catch (err) {
        // 单条消息入库失败：回错误帧，host 进程保持存活等待后续消息
        log(`batch 入库失败：${err.message}`);
        sendMessage({ ok: false, error: `入库失败：${err.message}` });
      }
      return;
    }
    default:
      sendMessage({ ok: false, error: `未知消息类型：${String(msg.type)}` });
  }
}

log(`Native Messaging host 启动，pid=${process.pid}，数据库=${config.dbPath}`);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on('end', () => {
  // 扩展端口关闭，host 退出；所有消息均已在独立事务中落盘（WAL 模式）
  log('标准输入 EOF，host 正常退出');
  try {
    store.close();
  } catch {
    // 关闭阶段忽略异常
  }
  process.exit(0);
});

process.stdin.on('error', () => process.exit(0));

process.on('uncaughtException', (err) => {
  log(`未捕获异常：${err.stack || err.message}`);
});
