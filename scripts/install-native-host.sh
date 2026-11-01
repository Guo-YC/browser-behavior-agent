#!/usr/bin/env bash
# ============================================================================
# install-native-host.sh —— 一键注册 Chrome / Chromium Native Messaging Host（模块B）
# ----------------------------------------------------------------------------
# 功能：
#   1. 根据扩展构建产物 manifest.json 的 key 字段自动计算 Chrome 扩展 ID；
#      计算规则：对 DER 公钥做 SHA-256，取前 32 个十六进制字符，
#      每位十六进制数 0-15 映射为字母 a-p（Chrome 官方算法）。
#   2. 在 Chrome / Chromium 各变体的 NativeMessagingHosts 目录写入 host 清单
#      com.browser.behavior.collector.json（type=stdio，path 指向 daemon/bin/host.js）。
#   3. 可选 --install-systemd：注册并启用 systemd 用户级守护进程单元。
#
# 用法：
#   bash scripts/install-native-host.sh [选项]
#
# 选项：
#   --extension-id <ID>      手动指定扩展 ID（跳过 key 计算；扩展尚未构建时使用）
#   --manifest <路径>        指定扩展 manifest.json 路径（默认自动查找 extension/.output/chrome-mv3/manifest.json）
#   --install-systemd        同时注册并启用 systemd 用户单元（browser-behavior-daemon.service）
#   --help, -h               显示本帮助
#
# 示例：
#   bash scripts/install-native-host.sh
#   bash scripts/install-native-host.sh --extension-id abcdefghijklmnopabcdefghijklmnop
#   bash scripts/install-native-host.sh --install-systemd
# ============================================================================

set -euo pipefail

# ---- 目录定位（脚本位于 <项目根>/scripts/）----------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DAEMON_DIR="${ROOT_DIR}/daemon"
HOST_JS="${DAEMON_DIR}/bin/host.js"
SERVICE_FILE="${DAEMON_DIR}/deploy/browser-behavior-daemon.service"

HOST_NAME="com.browser.behavior.collector"

# ---- 参数解析 --------------------------------------------------------------
EXTENSION_ID=""
INSTALL_SYSTEMD=0
MANIFEST_PATH=""

usage() {
  sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      EXTENSION_ID="${2:?--extension-id 需要一个扩展 ID 参数}"
      shift 2
      ;;
    --manifest)
      MANIFEST_PATH="${2:?--manifest 需要一个文件路径参数}"
      shift 2
      ;;
    --install-systemd)
      INSTALL_SYSTEMD=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "错误：未知参数 $1"
      usage
      exit 1
      ;;
  esac
done

# ---- 前置检查 --------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "错误：未在 PATH 中找到 node，请先安装 Node.js 20+。"
  exit 1
fi

if [[ ! -f "${HOST_JS}" ]]; then
  echo "错误：host 入口脚本不存在：${HOST_JS}"
  exit 1
fi

# host.js 需要可执行权限（Native Messaging 按 shebang 直接拉起）
chmod +x "${HOST_JS}"
chmod +x "${DAEMON_DIR}/bin/daemon.js" 2>/dev/null || true
chmod +x "${DAEMON_DIR}/bin/cli.js" 2>/dev/null || true

# ---- 计算扩展 ID ------------------------------------------------------------
# Chrome 扩展 ID 算法：DER 公钥（manifest.key，Base64）→ SHA-256 → 前 16 字节 →
# 32 个十六进制位；每位数值 n (0..15) 映射到字母表第 n 个字母 a..p。
compute_extension_id() {
  local manifest="$1"
  node -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const manifestPath = process.argv[1];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest.key) {
      console.error("manifest.json 缺少 key 字段（扩展构建后才会生成稳定公钥）。");
      process.exit(2);
    }
    const der = Buffer.from(manifest.key, "base64");
    const hash = crypto.createHash("sha256").update(der).digest("hex");
    const id = hash.slice(0, 32)
      .split("")
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join("");
    console.log(id);
  ' "${manifest}"
}

if [[ -z "${EXTENSION_ID}" ]]; then
  # 未手动指定 ID 时，自动查找扩展构建产物 manifest
  if [[ -z "${MANIFEST_PATH}" ]]; then
    for candidate in \
      "${ROOT_DIR}/extension/.output/chrome-mv3/manifest.json" \
      "${ROOT_DIR}/extension/.output/chrome/manifest.json" \
      "${ROOT_DIR}/extension/dist/manifest.json"; do
      if [[ -f "${candidate}" ]]; then
        MANIFEST_PATH="${candidate}"
        break
      fi
    done
  fi

  if [[ -n "${MANIFEST_PATH}" && -f "${MANIFEST_PATH}" ]]; then
    echo "正在从 manifest 计算扩展 ID：${MANIFEST_PATH}"
    EXTENSION_ID="$(compute_extension_id "${MANIFEST_PATH}")"
  else
    echo "错误：未找到扩展 manifest.json（扩展尚未构建完成）。"
    echo "      请先构建扩展，或使用 --extension-id <ID> 手动指定已加载扩展的 ID。"
    exit 1
  fi
fi

# 校验扩展 ID 格式：32 位小写字母 a-p
if ! [[ "${EXTENSION_ID}" =~ ^[a-p]{32}$ ]]; then
  echo "警告：扩展 ID 格式异常（应为 32 位 a-p 小写字母）：${EXTENSION_ID}"
fi

echo "使用扩展 ID：${EXTENSION_ID}"
echo "Host 入口：${HOST_JS}"

# ---- 写入各浏览器的 Native Messaging 清单 ------------------------------------
# Chrome 稳定版、Chromium、Chrome Beta、Chrome Unstable 分别注册；
# 目录不存在时自动创建；清单内容保持一致，仅 allowed_origins 限定本扩展。
BROWSER_CONFIG_DIRS=(
  "${HOME}/.config/google-chrome/NativeMessagingHosts"
  "${HOME}/.config/chromium/NativeMessagingHosts"
  "${HOME}/.config/google-chrome-beta/NativeMessagingHosts"
  "${HOME}/.config/google-chrome-unstable/NativeMessagingHosts"
)

HOST_MANIFEST="${HOME}/.config/google-chrome/NativeMessagingHosts/${HOST_NAME}.json"

for dir in "${BROWSER_CONFIG_DIRS[@]}"; do
  mkdir -p "${dir}"
  cat > "${dir}/${HOST_NAME}.json" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "浏览器行为采集本地守护进程 Native Messaging Host（模块B）",
  "path": "${HOST_JS}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF
  chmod 644 "${dir}/${HOST_NAME}.json"
  echo "已注册：${dir}/${HOST_NAME}.json"
done

# ---- 可选：注册 systemd 用户单元 --------------------------------------------
if [[ "${INSTALL_SYSTEMD}" -eq 1 ]]; then
  USER_UNIT_DIR="${HOME}/.config/systemd/user"
  mkdir -p "${USER_UNIT_DIR}"

  if [[ ! -f "${SERVICE_FILE}" ]]; then
    echo "错误：systemd 单元文件不存在：${SERVICE_FILE}"
    exit 1
  fi

  # 自动探测 node 绝对路径，并把单元内的 <PROJECT_ROOT>/<NODE_BIN> 占位符替换为实际路径，
  # 安装后开箱即用，无需手动修改占位符。
  NODE_BIN="$(command -v node || true)"
  if [[ -z "${NODE_BIN}" ]]; then
    echo "错误：未找到 node，无法生成 systemd 单元（ExecStart 需要 node 绝对路径）。"
    exit 1
  fi
  sed -e "s|<PROJECT_ROOT>|${ROOT_DIR}|g" \
      -e "s|<NODE_BIN>|${NODE_BIN}|g" \
      "${SERVICE_FILE}" > "${USER_UNIT_DIR}/browser-behavior-daemon.service"
  echo "已安装 systemd 用户单元（占位符已自动替换）：${USER_UNIT_DIR}/browser-behavior-daemon.service"

  if command -v systemctl >/dev/null 2>&1; then
    # 容器 / 无 systemd 用户会话环境下 daemon-reload / enable 可能失败；容错后给出手动命令
    if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now browser-behavior-daemon.service 2>/dev/null; then
      echo "已启用并启动守护进程（systemctl --user status browser-behavior-daemon.service 查看状态）"
    else
      echo "提示：当前环境未运行 systemd 用户会话，单元文件已复制；登录图形桌面后执行："
      echo "  systemctl --user daemon-reload"
      echo "  systemctl --user enable --now browser-behavior-daemon.service"
    fi
  else
    echo "提示：当前环境无 systemctl，单元文件已复制；登录图形桌面后执行："
    echo "  systemctl --user daemon-reload"
    echo "  systemctl --user enable --now browser-behavior-daemon.service"
  fi
fi

# ---- 完成提示 --------------------------------------------------------------
echo
echo "==== Native Messaging Host 注册完成 ===="
echo "Host 名称：${HOST_NAME}"
echo "扩展来源：chrome-extension://${EXTENSION_ID}/"
echo "清单主文件：${HOST_MANIFEST}"
echo
echo "下一步："
echo "  1. 重启 Chrome / Chromium，扩展通过 chrome.runtime.connectNative('${HOST_NAME}') 建立长连接。"
echo "  2. 手动启动 HTTP 调试服务：node ${DAEMON_DIR}/bin/daemon.js"
echo "  3. 查看已采集网站：node ${DAEMON_DIR}/bin/cli.js query sites"
