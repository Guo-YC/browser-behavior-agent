#!/usr/bin/env node
// daemon.js —— 守护进程 server 模式入口（契约 §3）。
// 启动 HTTP API（默认 127.0.0.1:8756，前缀 /api），并按周期执行会话超时整理与 WAL checkpoint。
// 日志一律走 stderr（stdout 不输出任何日志文本，避免被 Native Messaging 通道误读）。

import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { createHttpServer } from '../src/httpServer.js';

// 中文日志（stderr）
function log(...args) {
  process.stderr.write(`[behavior-daemon ${new Date().toISOString()}] ${args.join(' ')}\n`);
}

// 初始化存储层
const store = new Store(config.dbPath);
store.init();
store.setIdleTimeout(config.idleTimeoutMs);

// 启动 HTTP API 服务
const server = createHttpServer(store, config);

// 监听失败（端口占用/权限不足等）：打印中文原因并退出，避免空转
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`端口 ${config.port} 已被占用：${err.message}。请检查是否已有 daemon 在运行，或通过环境变量 PORT 指定其他端口。`);
  } else {
    log(`HTTP 服务启动失败：${err.message}`);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log(`HTTP API 已启动：http://${config.host}:${config.port}/api`);
  log(`数据库路径：${config.dbPath}`);
  log(`会话空闲超时：${config.idleTimeoutMs}ms；定期整理间隔：${config.maintenanceIntervalMs}ms`);
});

// 定期整理：关闭超时会话、清理空会话、wal_checkpoint(TRUNCATE)（契约 §2.3）
const maintenanceTimer = setInterval(() => {
  try {
    store.maintenance();
    log('定期整理完成：空闲会话已关闭，空会话已清理，WAL 已 checkpoint(TRUNCATE)');
  } catch (err) {
    log(`定期整理失败：${err.message}`);
  }
}, config.maintenanceIntervalMs);

// 优雅退出
function shutdown(signal) {
  log(`收到 ${signal}，正在退出…`);
  clearInterval(maintenanceTimer);
  server.close(() => {
    try {
      store.compact();
      store.close();
    } catch {
      // 关闭阶段忽略异常
    }
    process.exit(0);
  });
  // 兜底：10 秒内未退出则强制结束
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log(`未捕获异常：${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log(`未处理的 Promise 拒绝：${String(reason)}`);
});
