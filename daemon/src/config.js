// config.js —— 守护进程配置项（环境变量可覆盖，契约 §3 末尾）
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 当前文件位于 daemon/src/，上两级即为 daemon 根目录
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DAEMON_ROOT = path.resolve(__dirname, '..');

const defaultDbPath = path.join(DAEMON_ROOT, 'data', 'behavior.db');

export const config = {
  // HTTP API 监听地址与端口（契约 §3：127.0.0.1:8756，前缀 /api）
  host: '127.0.0.1',
  port: Number(process.env.PORT || 8756),
  // SQLite 数据库路径（WAL 模式）
  dbPath: process.env.DB_PATH || defaultDbPath,
  // 会话空闲超时：超过该时长无事件则自动关闭会话（契约 §2.3，默认 30 分钟）
  idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS || 30 * 60 * 1000),
  // 定期整理间隔：关闭超时会话、清理空会话、wal_checkpoint(TRUNCATE)（默认 30 分钟）
  maintenanceIntervalMs: Number(process.env.MAINTENANCE_INTERVAL_MS || 30 * 60 * 1000),
};
