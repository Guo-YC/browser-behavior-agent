// 模块E：后端抽象基类。各后端实现同一接口，供 executor 无差别调用。

/**
 * 后端基类：定义契约接口与默认能力表。
 * 子类需实现 precheck / run / getUrl / getText / isPresent / close。
 */
export class Backend {
  constructor() {
    this.mode = 'base';
    // 能力表：标识当前后端支持哪些动作类型（optional 动作在能力缺失时跳过）
    this.capabilities = {
      navigate: true,
      click: true,
      dblclick: true,
      input: true,
      scroll: true,
      hover: true,
      wait: true,
      assert: true,
    };
  }

  /** 连接到浏览器/初始化（可选实现） */
  async connect() {}

  /** 关闭连接/释放资源（可选实现） */
  async close() {}

  /** 预检单个动作（dry-run 的核心；真机后端做基础合法性检查） */
  async precheck(action) {
    return { pass: true, message: '' };
  }

  /** 执行单个动作（子类实现） */
  async run(action) {
    throw new Error(`后端 ${this.mode} 未实现动作执行。`);
  }

  /** 获取当前页面 URL */
  async getUrl() {
    throw new Error(`后端 ${this.mode} 未实现 getUrl。`);
  }

  /** 获取指定选择器内的文本 */
  async getText(selector) {
    throw new Error(`后端 ${this.mode} 未实现 getText。`);
  }

  /** 判断指定选择器是否命中且可见 */
  async isPresent(selector) {
    throw new Error(`后端 ${this.mode} 未实现 isPresent。`);
  }
}
