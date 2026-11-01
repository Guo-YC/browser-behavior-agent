// 模块D：控制台中文蒸馏报告（契约 §7 第7步、§8 模块D验收输出要求）

/** 取动作上的文本断言目标，便于报告展示 */
function textTarget(action) {
  const hit = action.assertions.find((a) => a.kind === 'text_present');
  return hit ? hit.target : '';
}

/** 单条动作在报告中的一行摘要 */
function actionLine(action) {
  const parts = [`${action.step}. ${action.type}`];
  if (action.selector) parts.push(action.selector);
  if (action.value !== undefined && action.value !== '') parts.push(`→ “${action.value}”`);
  const text = textTarget(action);
  if (text) parts.push(`文本“${text}”`);
  parts.push(`[断言 ${action.assertions.length} 条]`);
  return `    ${parts.join('  ')}`;
}

/**
 * 打印完整中文蒸馏报告
 * @param {object} result distillSkill 返回结果
 */
export function printReport(result) {
  console.log('==================== 技能蒸馏报告 ====================');
  console.log(`域名：${result.domain}`);
  console.log(`数据库：${result.dbPath}`);
  console.log(
    `参与会话：${result.sessionCount} 条（清洗后 ${result.cleanedSessionCount} 条，丢弃空轨迹 ${result.droppedCount} 条）；事件总数：${result.eventCount}`
  );
  console.log(`挖掘到候选动作链：${result.chainCount} 条（前缀树原始命中 ${result.candidateCount} 条）`);
  console.log(`生成技能：${result.skills.length} 个`);
  console.log('======================================================');
  console.log('');

  if (result.skills.length === 0) {
    console.log(
      `未挖掘到满足条件（出现会话数 ≥ ${result.minOccurrences}、链长 ≥ 3）的重复动作链，未生成技能。`
    );
    console.log('建议：提高 --min-occurrences 阈值，或先在该站点重复完成若干次相同操作后再蒸馏。');
    return;
  }

  result.skills.forEach((item, index) => {
    const skill = item.skill;
    console.log(`【技能 ${index + 1}】${skill.skillId}`);
    console.log(`  名称：${skill.name}`);
    console.log(`  描述：${skill.description}`);
    console.log(
      `  匹配率：${(skill.evidence.matchRate * 100).toFixed(1)}%（${skill.evidence.trajectoryCount}/${result.sessionCount} 条会话出现该链）`
    );
    console.log(`  来源会话：${skill.sourceSessions.join('、')}`);
    console.log(`  动作序列（${skill.actions.length} 步）：`);
    for (const action of skill.actions) console.log(actionLine(action));
    console.log(`  技能文件：${skill.path}`);
    console.log(`  索引注册：${item.registerResult.message}`);
    console.log('');
  });
}
