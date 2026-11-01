/**
 * 全局配置：读取环境变量，解析各模块路径。
 * 环境变量说明（详见 mcp/README.md）：
 *  - DAEMON_URL：本地守护进程 HTTP 地址，默认 http://127.0.0.1:8756
 *  - REPLAY_DIR：replay（蒸馏/回放）模块目录，默认 mcp/../replay
 *  - DB_PATH：数据库路径（保留，供后续扩展使用）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 当前文件位于 mcp/src/config.js，由此向上定位 mcp 目录与项目根目录
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MCP_DIR = path.resolve(__dirname, '..');
export const ROOT_DIR = path.resolve(MCP_DIR, '..');

/** 守护进程 HTTP 基址（去掉结尾斜杠） */
export const DAEMON_URL = (process.env.DAEMON_URL || 'http://127.0.0.1:8756').replace(/\/+$/, '');

/**
 * replay 目录：
 *  - 未设置 REPLAY_DIR 时默认解析为 mcp 目录下的 ../replay（即项目根目录 replay/）；
 *  - 设置了相对路径时，相对 mcp 目录解析；设置了绝对路径则原样使用。
 */
export const REPLAY_DIR = process.env.REPLAY_DIR
  ? path.isAbsolute(process.env.REPLAY_DIR)
    ? process.env.REPLAY_DIR
    : path.resolve(MCP_DIR, process.env.REPLAY_DIR)
  : path.resolve(MCP_DIR, '..', 'replay');

/** 数据库路径（保留项，契约 §4 列出，当前查询均走 daemon HTTP API） */
export const DB_PATH = process.env.DB_PATH || path.join(ROOT_DIR, 'daemon', 'data', 'behavior.db');

/** 调用 daemon 的超时时间（毫秒） */
export const DAEMON_TIMEOUT_MS = Number(process.env.DAEMON_TIMEOUT_MS || 8000);
