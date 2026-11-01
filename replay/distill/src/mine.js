// 模块D：重复动作链挖掘（契约 §7 第4、5步）
// 思路：Browser-BC 风格的前缀树（Trie）公共子序列挖掘。
//  1. 每条清洗后的轨迹截断到上限动作数，控制 LCS/前缀树复杂度（已知坑③）；
//  2. 把每条轨迹的所有长度 ≤ maxSteps 的子串插入前缀树，树节点记录经过它的会话集合；
//  3. 节点会话数 ≥ minOccurrences、路径深度 ≥3 即为候选重复链；
//  4. 评分 = 出现次数 × 链长 × 动作多样性；按评分排序并剔除已被长链包含的嵌套子链。

/**
 * @typedef {object} CandidateChain
 * @property {object[]} actions  链上代表动作（来自前缀树节点样本，键一致）
 * @property {string[]} keys     链上匹配键序列
 * @property {number} occurrences 出现该链的会话数
 * @property {string[]} sessionIds 出现该链的会话 id 列表
 * @property {number} length     链长
 * @property {number} diversity 动作多样性（不同匹配键个数）
 * @property {number} score      评分：次数 × 链长 × 多样性
 */

/**
 * 挖掘候选重复动作链
 * @param {Map<string, object[]>} cleaned 清洗后的会话动作序列
 * @param {object} opts
 * @param {number} opts.minOccurrences 最小出现会话数（默认 2）
 * @param {number} opts.maxSteps 链长上限（默认 20）
 * @param {number} [opts.maxActionsPerSession] 单条轨迹截断动作数（性能保护）
 * @returns {{ candidates: CandidateChain[], totalSessions: number, rawCandidateCount: number }}
 */
export function mineChains(cleaned, { minOccurrences, maxSteps, maxActionsPerSession = 200 }) {
  const entries = [...cleaned.entries()].map(([sid, actions]) => [
    sid,
    actions.slice(0, maxActionsPerSession),
  ]);
  const totalSessions = entries.length;

  // 前缀树根节点
  const root = { children: new Map(), sessions: new Set(), sample: null };

  for (const [sid, actions] of entries) {
    // 从每个起点插入后缀，覆盖所有长度 ≤ maxSteps 的连续子串
    for (let i = 0; i < actions.length; i++) {
      let node = root;
      const upper = Math.min(actions.length, i + maxSteps);
      for (let j = i; j < upper; j++) {
        const action = actions[j];
        let child = node.children.get(action.key);
        if (!child) {
          child = { children: new Map(), sessions: new Set(), sample: action };
          node.children.set(action.key, child);
        }
        if (!child.sessions.has(sid)) {
          child.sessions.add(sid);
          if (!child.sample) child.sample = action;
        }
        node = child;
      }
    }
  }

  const candidates = [];

  /**
   * 深度优先遍历前缀树，收集满足支持度与长度要求的路径
   * @param {object} node 当前节点
   * @param {Array<{key:string, sample:object}>} path 当前路径
   */
  function dfs(node, path) {
    if (path.length >= 3 && node.sessions.size >= minOccurrences) {
      const keys = path.map((n) => n.key);
      const actions = path.map((n) => n.sample);
      const diversity = new Set(keys).size;
      candidates.push({
        actions,
        keys,
        occurrences: node.sessions.size,
        sessionIds: [...node.sessions],
        length: path.length,
        diversity,
        score: node.sessions.size * path.length * diversity,
      });
    }
    // 达到链长上限不再下钻
    if (path.length >= maxSteps) return;
    for (const child of node.children.values()) {
      dfs(child, [...path, child]);
    }
  }
  dfs(root, []);

  // 评分降序
  candidates.sort((a, b) => b.score - a.score);

  // 剔除嵌套子链：候选链的键序列是某条已入选链连续子串（前缀/后缀/中段）时，不再重复生成技能
  const accepted = [];
  for (const candidate of candidates) {
    const isSubsumed = accepted.some((acc) => acc.keys.join('›').includes(candidate.keys.join('›')));
    if (!isSubsumed) accepted.push(candidate);
  }

  return {
    candidates: accepted,
    totalSessions,
    rawCandidateCount: candidates.length,
  };
}
