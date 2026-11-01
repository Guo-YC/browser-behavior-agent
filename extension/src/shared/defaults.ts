/**
 * 扩展配置模型与默认值（契约 §1.4 #6：规则在扩展内做成可配置列表，默认全部开启）。
 * 配置持久化于 chrome.storage.local 的 `behavior.collector.config` 键。
 */

/** 扩展整体配置 */
export interface ExtensionConfig {
  enabled: boolean;
  redaction: RedactionConfig;
  sampleMousemove: boolean;
  sampleScroll: boolean;
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
  batchSize: number;
  batchIntervalMs: number;
  maxBatchBytes: number;
  maxQueuedEvents: number;
}

/** 敏感字段规则（可在 options 页增删改） */
export interface RedactionConfig {
  enabled: boolean;
  sensitivePatterns: string[];
  dropHeaders: string[];
  dropUrlParams: string[];
}

/** 契约 §1.4 #2 默认正则（大小写不敏感） */
export const DEFAULT_SENSITIVE_PATTERN =
  'passw|pwd|token|secret|api[_-]?key|apikey|credit|card|cvv|cvc|pin|auth|session[_-]?id|ssn';

/** 契约 §1.4 #5 默认剥离请求头 */
export const DEFAULT_DROP_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
];

/** 契约 §1.4 #4 默认脱敏 URL 查询参数 */
export const DEFAULT_DROP_URL_PARAMS = ['token', 'access_token', 'signature', 'key', 'secret'];

/** 配置存储键名 */
export const CONFIG_STORAGE_KEY = 'behavior.collector.config';

/** 配置默认值（默认全部开启） */
export const DEFAULT_CONFIG: ExtensionConfig = {
  enabled: true,
  redaction: {
    enabled: true,
    sensitivePatterns: [DEFAULT_SENSITIVE_PATTERN],
    dropHeaders: [...DEFAULT_DROP_HEADERS],
    dropUrlParams: [...DEFAULT_DROP_URL_PARAMS],
  },
  sampleMousemove: true,
  sampleScroll: true,
  heartbeatIntervalMs: 5 * 60 * 1000,
  idleTimeoutMs: 30 * 60 * 1000,
  batchSize: 50,
  batchIntervalMs: 500,
  maxBatchBytes: 900 * 1024,
  maxQueuedEvents: 2000,
};

/** 深度合并：用持久化配置覆盖默认配置，保证新增字段有兜底默认值 */
export function mergeConfig(stored: Partial<ExtensionConfig> | undefined): ExtensionConfig {
  const base: ExtensionConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!stored) return base;
  return {
    ...base,
    ...stored,
    redaction: { ...base.redaction, ...(stored.redaction ?? {}) },
  };
}
