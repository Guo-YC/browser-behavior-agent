/**
 * 本地守护进程（daemon）HTTP API 客户端。
 * 契约 §3：除 /health 外均为 /api 前缀；错误统一 { "error": "中文描述" }。
 * 本模块只负责：拼参数、发 GET、解析 JSON、把网络故障/业务错误包装成中文 Error。
 */
import { DAEMON_URL, DAEMON_TIMEOUT_MS } from './config.js';

/**
 * 拼接带查询参数的完整 URL。
 * 规则：空值跳过；数组逐项追加；布尔转 true/false；其余转字符串。
 */
function buildUrl(apiPath, params) {
  const url = new URL(DAEMON_URL + apiPath);
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
      }
    }
  }
  return url;
}

/** 网络不通/超时统一提示中文排障建议 */
function networkError(err) {
  const reason = err && err.name === 'AbortError' ? '请求超时' : '网络连接失败';
  return new Error(
    `无法连接本地行为采集守护进程（daemon，地址：${DAEMON_URL}）。` +
    `请先在项目根目录执行「node daemon/bin/daemon.js」启动守护进程；` +
    `若 daemon 端口不同，请设置环境变量 DAEMON_URL=${DAEMON_URL}。底层原因：${reason}。`
  );
}

/**
 * 发起 GET 请求并解析 JSON。
 * @param {string} apiPath 契约 §3 中的路径，如 /api/sites
 * @param {Record<string, unknown>} params 查询参数（可选过滤项）
 * @returns {Promise<unknown>} daemon 返回的 JSON 主体
 */
export async function daemonGet(apiPath, params) {
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DAEMON_TIMEOUT_MS);
    response = await fetch(buildUrl(apiPath, params), {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
  } catch (err) {
    throw networkError(err);
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!response.ok || (body && typeof body === 'object' && body.error)) {
    const detail = body && body.error
      ? body.error
      : (typeof body === 'object' && body !== null ? JSON.stringify(body) : text);
    throw new Error(`守护进程返回错误（HTTP ${response.status}）：${detail || '无详细信息'}`);
  }
  return body;
}

/**
 * 探测 daemon 是否在线（GET /health）。
 * @returns {Promise<{ ok: boolean, health?: unknown, message?: string }>}
 */
export async function daemonHealth() {
  try {
    const health = await daemonGet('/health');
    return { ok: true, health };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
