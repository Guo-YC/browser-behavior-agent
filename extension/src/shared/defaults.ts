/**
 * 扩展配置模型与默认值（契约 §1.4 #6：规则在扩展内做成可配置列表，默认全部开启）。
 * 配置持久化于 chrome.storage.local 的 `behavior.collector.config` 键。
 */

/** 扩展整体配置 */
export interface ExtensionConfig {
  /** 采集总开关：false 时 content 与 background 都不产出事件 */
  enabled: boolean;
  redaction: RedactionConfig;
  /** 是否采集 mousemove（高噪声事件，options 页可关） */
  sampleMousemove: boolean;
  /** 是否采集 scroll（高噪声事件，options 页可关） */
  sampleScroll: boolean;
  /** 心跳间隔（毫秒）：空闲期保持会话不被守护进程按 30min 回收，默认 5 分钟 */
  heartbeatIntervalMs: number;
  /** 空闲会话超时（毫秒）：超过后发 session_end(reason='idle')，默认 30 分钟（契约 §1.2 / §2.3） */
  idleTimeoutMs: number;
  /** 批量发送：攒满该条数立即发送（契约 §1.1：50 条） */
  batchSize: number;
  /** 批量发送：定时刷新间隔（契约 §1.1：500ms） */
  batchIntervalMs: number;
  /** 单条 Native 消息字节上限（契约 §1.1：≤1MB，留 100KB 余量用于拆包边界） */
  maxBatchBytes: number;
  /** 断连后 Native 桥队列上限：超出后丢弃最旧事件，避免内存膨胀 */
  maxQueuedEvents: number;
}

/** 敏感字段规则（可在 options 页增删改） */
export interface RedactionConfig {
  /** 脱敏总开关：false 时不执行 §1.4 规则（仅调试用，默认开启） */
  enabled: boolean;
  /**
   * 敏感属性正则源文本列表。元素的 type / name / id / autocomplete /
   * aria-label / placeholder 任一命中即视为敏感元素（契约 §1.4 #1、#2）。
   * 每条为正则表达式字面量文本（不含首尾斜杠），options 页一行一条。
   */
  sensitivePatterns: string[];
  /** 剥离的请求头名（小写匹配，契约 §1.4 #5），命中则整头不放入事件 */
  dropHeaders: string[];
  /** 剥离的 URL 查询参数名（小写匹配，契约 §1.4 #4），命中后参数值置 **** */
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
