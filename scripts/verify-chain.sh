#!/usr/bin/env bash
# ============================================================================
# verify-chain.sh — 端到端最小链路验证：模拟事件→入库→查询→MCP→蒸馏→回放 dry-run
# 用法：bash scripts/verify-chain.sh
# 依赖：node >=20（各模块已 npm install）；幂等可重复执行。
# ============================================================================
set -u
# 本地回环不走系统代理（Windows/内网常设 http_proxy，否则 127.0.0.1 会被转发导致 502）
export no_proxy="127.0.0.1,localhost" NO_PROXY="127.0.0.1,localhost"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_URL="http://127.0.0.1:8756"
DB_PATH="/tmp/browser-behavior-verify/behavior.db"
LOG_FILE="/tmp/browser-behavior-verify/daemon.log"
PASS=0; FAIL=0; STEP_NO=0
step() { STEP_NO=$((STEP_NO+1)); echo ""; echo "========================================================"; echo "[$STEP_NO] $1"; echo "========================================================"; }
ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
mkdir -p "$ROOT/daemon/data" /tmp/browser-behavior-verify
step "清理并启动守护进程"
# 跨平台停止已有 daemon：Linux 用 pkill，Windows(Git Bash) 用 taskkill 按监听端口 PID
if command -v pkill >/dev/null 2>&1; then
  pkill -f 'daemon/bin/daemon.js' 2>/dev/null && sleep 1
elif command -v taskkill >/dev/null 2>&1; then
  for pid in $(netstat -ano 2>/dev/null | grep LISTENING | grep ':8756' | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" >/dev/null 2>&1 && echo "  已停止占用 8756 的进程 pid=$pid"
  done
  sleep 1
fi
rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
nohup env DB_PATH="$DB_PATH" node "$ROOT/daemon/bin/daemon.js" > "$LOG_FILE" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 30); do curl -sf "$DAEMON_URL/health" > /dev/null 2>&1 && break; sleep 0.5; done
if curl -sf "$DAEMON_URL/health" > /dev/null 2>&1; then ok "daemon 已启动 (pid=$DAEMON_PID)"; else bad "daemon 启动失败，日志见 $LOG_FILE"; tail -20 "$LOG_FILE"; exit 1; fi
step "模拟扩展事件灌入（HTTP /api/events）"
MOCK_OUT=$(node "$ROOT/scripts/mock-events.js" --url "$DAEMON_URL" 2>&1); MOCK_CODE=$?
echo "$MOCK_OUT" | sed 's/^/    /'
[ $MOCK_CODE -eq 0 ] && ok "mock 事件发送成功" || bad "mock 事件发送失败"
step "数据库/API 查询（sites / behaviors / search / trajectory）"
SITES=$(curl -s "$DAEMON_URL/api/sites"); echo "    sites -> $(echo "$SITES" | head -c 400)"
echo "$SITES" | grep -q 'example.com' && echo "$SITES" | grep -q 'docs.example.org' && ok "按域名自动分表：sites 出现 2 个域名" || bad "sites 缺少预期域名"
BEHAVIORS=$(curl -s "$DAEMON_URL/api/behaviors?domain=example.com&limit=3"); echo "    behaviors -> $(echo "$BEHAVIORS" | head -c 300)"
echo "$BEHAVIORS" | grep -q '"items"' && echo "$BEHAVIORS" | grep -q '"click"' && ok "behaviors 查询命中 click 事件" || bad "behaviors 查询异常"
SEARCH=$(curl -s --get "$DAEMON_URL/api/search" --data-urlencode "q=提交订单" --data-urlencode "domain=example.com"); echo "    search -> $(echo "$SEARCH" | head -c 300)"
echo "$SEARCH" | grep -q '提交订单' && ok "FTS5 全文检索命中「提交订单」" || bad "FTS5 全文检索未命中"
TRAJ=$(curl -s "$DAEMON_URL/api/trajectory?domain=example.com&sessionId=s_mock_1"); echo "    trajectory(s_mock_1) 事件数: $(echo "$TRAJ" | grep -o '"type"' | wc -l)"
echo "$TRAJ" | grep -q '"sessionId"' && ok "轨迹导出正常" || bad "轨迹导出异常"
step "MCP Server（stdio）列出工具 + 调用"
TOOLS=$(node "$ROOT/mcp/index.js" --list 2>&1); TOOL_COUNT=$(echo "$TOOLS" | grep -oE 'list_sites|query_behaviors|query_sessions|query_requests|behavior_stats|fulltext_search|export_trajectory|distill_skill|list_skills|trigger_replay' | sort -u | wc -l)
echo "    列出工具数(去重): $TOOL_COUNT"; [ "$TOOL_COUNT" -ge 10 ] && ok "MCP 工具清单 >= 10 个" || bad "MCP 工具清单不足"
if [ -f "$ROOT/mcp/test-client.js" ]; then
  LS=$(node "$ROOT/mcp/test-client.js" call list_sites 2>&1); echo "    list_sites -> $(echo "$LS" | head -c 300)"; echo "$LS" | grep -q 'example.com' && ok "MCP list_sites 返回真实数据" || bad "MCP list_sites 异常"
  QB=$(node "$ROOT/mcp/test-client.js" call query_behaviors --domain example.com --limit 2 2>&1); echo "    query_behaviors -> $(echo "$QB" | head -c 300)"; echo "$QB" | grep -q '"items"' && ok "MCP query_behaviors 返回行为数据" || bad "MCP query_behaviors 异常"
else bad "mcp/test-client.js 不存在"; fi
step "技能蒸馏（example.com，min-occurrences=2）"
DISTILL_OUT=$(DB_PATH="$DB_PATH" node "$ROOT/replay/distill/index.js" --domain example.com --name "下单流程" --min-occurrences 2 2>&1); DISTILL_CODE=$?
echo "$DISTILL_OUT" | tail -25 | sed 's/^/    /'
SKILL_FILE=$(echo "$DISTILL_OUT" | grep -oE 'replay[\\/]skills[\\/][^ "]+\.json' | head -1 | tr '\\' '/')
if [ $DISTILL_CODE -eq 0 ] && [ -n "$SKILL_FILE" ] && [ -f "$ROOT/$SKILL_FILE" ]; then ok "蒸馏产出技能: $SKILL_FILE"; SKILL_ID=$(node -e "const s=require('$ROOT/$SKILL_FILE');process.stdout.write(s.skillId||'')" 2>/dev/null || echo ""); else bad "蒸馏未产出技能（输出见上）"; SKILL_FILE=""; fi
step "确定性回放 dry-run（对蒸馏出的技能）"
if [ -n "$SKILL_FILE" ]; then
  REPLAY_OUT=$(node "$ROOT/replay/runner/index.js" --skill-file "$ROOT/$SKILL_FILE" --mode dry_run 2>&1); REPLAY_CODE=$?
  echo "$REPLAY_OUT" | tail -30 | sed 's/^/    /'
  [ $REPLAY_CODE -eq 0 ] && ok "回放 dry-run 全部 PASS（退出码 0）" || bad "回放 dry-run 存在 FAIL 或异常（退出码 $REPLAY_CODE）"
else
  SAMPLE=$(ls "$ROOT"/replay/runner/test/*.json 2>/dev/null | head -1)
  if [ -n "$SAMPLE" ]; then node "$ROOT/replay/runner/index.js" --skill-file "$SAMPLE" --mode dry_run >/dev/null 2>&1 && ok "回放 dry-run（样例技能）PASS" || bad "回放 dry-run（样例技能）FAIL"; else bad "无技能可回放"; fi
fi
step "技能索引（daemon /api/skills）"
SKILLS=$(curl -s "$DAEMON_URL/api/skills"); echo "    skills -> $(echo "$SKILLS" | head -c 300)"
echo "$SKILLS" | grep -q 'skillId' && ok "daemon 已注册技能索引" || bad "技能索引为空"
echo ""; echo "========================================================"; echo "验证汇总：PASS=$PASS  FAIL=$FAIL"; echo "========================================================"; echo "daemon 仍在运行（pid=$DAEMON_PID，日志 $LOG_FILE）；如需停止：kill $DAEMON_PID"; [ $FAIL -eq 0 ]
