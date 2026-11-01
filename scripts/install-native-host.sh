#!/usr/bin/env bash
# ============================================================================
# install-native-host.sh —— 一键注册 Chrome / Chromium Native Messaging Host（模块B）
# ----------------------------------------------------------------------------
# 功能：
#   1. 根据扩展构建产物 manifest.json 的 key 字段自动计算 Chrome 扩展 ID
#      （DER 公钥 SHA-256 前 32 位映射 a-p，Chrome 官方算法）；
#   2. 在 Chrome / Chromium 各变体的 NativeMessagingHosts 目录写入 host 清单
#      com.browser.behavior.collector.json（type=stdio，path 指向 daemon/bin/host.js）；
#   3. 可选 --install-systemd：注册并启用 systemd 用户级守护进程单元。
# 用法：
#   bash scripts/install-native-host.sh [选项]
#   选项：--extension-id <ID> / --manifest <路径> / --install-systemd / --help
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DAEMON_DIR="${ROOT_DIR}/daemon"
HOST_JS="${DAEMON_DIR}/bin/host.js"
SERVICE_FILE="${DAEMON_DIR}/deploy/browser-behavior-daemon.service"
HOST_NAME="com.browser.behavior.collector"
EXTENSION_ID=""
INSTALL_SYSTEMD=0
MANIFEST_PATH=""
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id) EXTENSION_ID="${2:?--extension-id 需要一个扩展 ID 参数}"; shift 2 ;;
    --manifest) MANIFEST_PATH="${2:?--manifest 需要一个文件路径参数}"; shift 2 ;;
    --install-systemd) INSTALL_SYSTEMD=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "错误：未知参数 $1"; usage; exit 1 ;;
  esac
done
if ! command -v node >/dev/null 2>&1; then echo "错误：未在 PATH 中找到 node，请先安装 Node.js 20+。"; exit 1; fi
if [[ ! -f "${HOST_JS}" ]]; then echo "错误：host 入口脚本不存在：${HOST_JS}"; exit 1; fi
chmod +x "${HOST_JS}"; chmod +x "${DAEMON_DIR}/bin/daemon.js" 2>/dev/null || true; chmod +x "${DAEMON_DIR}/bin/cli.js" 2>/dev/null || true
compute_extension_id() {
  local manifest="$1"
  node -e '
    const fs=require("fs"),crypto=require("crypto");
    const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(!m.key){console.error("manifest.json 缺少 key 字段（构建后才会生成稳定公钥）。");process.exit(2);}
    const der=Buffer.from(m.key,"base64");
    const hash=crypto.createHash("sha256").update(der).digest("hex");
    console.log(hash.slice(0,32).split("").map(c=>String.fromCharCode(97+parseInt(c,16))).join(""));
  ' "${manifest}"
}
if [[ -z "${EXTENSION_ID}" ]]; then
  if [[ -z "${MANIFEST_PATH}" ]]; then
    for candidate in "${ROOT_DIR}/extension/.output/chrome-mv3/manifest.json" "${ROOT_DIR}/extension/.output/chrome/manifest.json" "${ROOT_DIR}/extension/dist/manifest.json"; do
      [[ -f "${candidate}" ]] && { MANIFEST_PATH="${candidate}"; break; }
    done
  fi
  if [[ -n "${MANIFEST_PATH}" && -f "${MANIFEST_PATH}" ]]; then
    echo "正在从 manifest 计算扩展 ID：${MANIFEST_PATH}"; EXTENSION_ID="$(compute_extension_id "${MANIFEST_PATH}")"
  else
    echo "错误：未找到扩展 manifest.json（扩展尚未构建完成）。请先构建扩展，或使用 --extension-id <ID> 手动指定。"; exit 1
  fi
fi
if ! [[ "${EXTENSION_ID}" =~ ^[a-p]{32}$ ]]; then echo "警告：扩展 ID 格式异常（应为 32 位 a-p 小写字母）：${EXTENSION_ID}"; fi
echo "使用扩展 ID：${EXTENSION_ID}"; echo "Host 入口：${HOST_JS}"
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
  "allowed_origins": ["chrome-extension://${EXTENSION_ID}/"]
}
EOF
  chmod 644 "${dir}/${HOST_NAME}.json"; echo "已注册：${dir}/${HOST_NAME}.json"
done
if [[ "${INSTALL_SYSTEMD}" -eq 1 ]]; then
  USER_UNIT_DIR="${HOME}/.config/systemd/user"; mkdir -p "${USER_UNIT_DIR}"
  if [[ ! -f "${SERVICE_FILE}" ]]; then echo "错误：systemd 单元文件不存在：${SERVICE_FILE}"; exit 1; fi
  cp "${SERVICE_FILE}" "${USER_UNIT_DIR}/browser-behavior-daemon.service"
  echo "已安装 systemd 用户单元：${USER_UNIT_DIR}/browser-behavior-daemon.service"
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now browser-behavior-daemon.service 2>/dev/null; then
      echo "已启用并启动守护进程"
    else
      echo "提示：当前环境未运行 systemd 用户会话，单元文件已复制；登录图形桌面后执行："; echo "  systemctl --user daemon-reload"; echo "  systemctl --user enable --now browser-behavior-daemon.service"
    fi
  else
    echo "提示：当前环境无 systemctl，单元文件已复制；登录图形桌面后执行上述命令"
  fi
fi
echo; echo "==== Native Messaging Host 注册完成 ===="; echo "Host 名称：${HOST_NAME}"; echo "扩展来源：chrome-extension://${EXTENSION_ID}/"; echo "清单主文件：${HOST_MANIFEST}"; echo; echo "下一步："; echo "  1. 重启 Chrome / Chromium，扩展通过 chrome.runtime.connectNative 建立长连接。"; echo "  2. 手动启动 HTTP 调试服务：node ${DAEMON_DIR}/bin/daemon.js"; echo "  3. 查看已采集网站：node ${DAEMON_DIR}/bin/cli.js query sites"
