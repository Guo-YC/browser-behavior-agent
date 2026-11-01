/**
 * 默认敏感字段脱敏配置（契约 §1.4）。
 * 规则列表可在扩展 options 页开关/追加；默认全部开启。
 */
export const DEFAULT_REDACTION = {
  /** 元素 name/id/autocomplete/aria-label/placeholder 命中即脱敏 */
  fieldPattern: /(passw|pwd|token|secret|api[_-]?key|apikey|credit|card|cvv|cvc|pin|auth|session[_-]?id|ssn)/i,
  /** 请求 URL 查询参数名命中即把值置 **** */
  urlQueryPattern: /(token|access_token|signature|key|secret)/i,
  /** 请求头整头剥离 */
  strippedHeaders: [
    'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
    'x-api-key', 'x-auth-token', 'x-csrf-token',
  ],
  /** 是否开启采集总开关 */
  enabled: true,
};
