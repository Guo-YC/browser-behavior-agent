#!/usr/bin/env bash
# ============================================================================
# setup.sh —— 一键部署启动（把部署收敛为单条命令）
#
# 自动完成四件事：
#   1. 扩展构建检查（未构建时自动 pnpm build）
#   2. 注册 Chrome/Chromium Native Messaging Host（扩展 ID 自动计算或手动指定）
#   3. 安装并启动 systemd 守护进程（单元内 <PROJECT_ROOT>/<NODE_BIN> 占位符自动替换）
#   4. 打印 MCP 启动命令与链路验证入口
#
# 用法：
#   bash scripts/setup.sh                     # 全自动（扩展已构建且 manifest 含 key）
#   bash scripts/setup.sh --extension-id <ID> # 指定扩展 ID（manifest 无 key 时使用）
#   bash scripts/setup.sh --help              # 查看帮助
#
# 依赖： node >=20；构建扩展需要 pnpm。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---- 参数解析（透传扩展 ID 给 install-native-host.sh）----------------------
EXTENSION_ID=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      EXTENSION_ID="${2:?--extension-id 需要一个扩展 ID 参数}"
      EXTRA_ARGS+=(--extension-id "${EXTENSION_ID}")
      shift 2
      ;;
    --help|-h)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "错误：未知参数 $1"
      echo "用法：bash scripts/setup.sh [--extension-id <扩展ID>]"
      exit 1
      ;;
  esac
done

# ---- 0. 前置检查 ------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node，请先安装 Node.js 20+。"
  exit 1
fi

echo "================ 浏览器行为采集 · 一键部署 ================"

# ---- 1. 扩展构建检查 --------------------------------------------------------
MANIFEST="${ROOT_DIR}/extension/.output/chrome-mv3/manifest.json"
if [[ ! -f "${MANIFEST}" ]]; then
  echo "未检测到扩展构建产物，开始自动构建…"
  if command -v pnpm >/dev/null 2>&1; then
    ( cd "${ROOT_DIR}/extension" && pnpm install --frozen-lockfile=false && pnpm build )
    MANIFEST="${ROOT_DIR}/extension/.output/chrome-mv3/manifest.json"
  else
    echo "错误：未找到 pnpm，无法自动构建扩展。"
    echo "  请手动构建后重跑： cd extension && pnpm build"
    echo "  或指定已加载扩展 ID： bash scripts/setup.sh --extension-id <扩展ID>"
    exit 1
  fi
fi
echo "[1/3] 扩展构建产物已就绪：${MANIFEST}"

# ---- 2. 扩展 ID 准备 --------------------------------------------------------
# manifest 无 key 字段时无法自动计算 ID，需从 chrome://extensions 复制一次。
if [[ -z "${EXTENSION_ID}" ]]; then
  if ! grep -q '"key"' "${MANIFEST}" 2>/dev/null; then
    echo "[2/3] 扩展 manifest 不含 key，无法自动计算扩展 ID。"
    echo "      请在 chrome://extensions 开启「开发者模式」，复制本扩展的 32 位 ID，然后重跑："
    echo "      bash scripts/setup.sh --extension-id <扩展ID>"
    exit 1
  fi
fi
echo "[2/3] 扩展 ID 就绪：${EXTENSION_ID:-自动计算}"

# ---- 3. 注册 Native Host + 安装启动 systemd（占位符自动替换）---------------
echo "[3/3] 注册 Native Messaging Host 并安装启动 systemd 守护进程…"
bash "${ROOT_DIR}/scripts/install-native-host.sh" "${EXTRA_ARGS[@]}" --install-systemd

# ---- 4. 完成提示 ------------------------------------------------------------
echo
echo "================ 一键部署完成 ================"
echo "守护进程（已由 systemd 自动托管）："
echo "  状态： systemctl --user status browser-behavior-daemon.service"
echo "  API：  http://127.0.0.1:8756/api"
echo
echo "MCP 服务启动（供 DSH / OpenCode / Claude 等接入）："
echo "  stdio：  node ${ROOT_DIR}/mcp/index.js"
echo "  HTTP：   node ${ROOT_DIR}/mcp/index.js --http --port 8765"
echo
echo "端到端链路验证： bash ${ROOT_DIR}/scripts/verify-chain.sh"
echo "====================================================="
