<#
.SYNOPSIS
    install-native-host.ps1 —— Windows 版 Native Messaging Host 一键注册脚本（模块B）

.DESCRIPTION
    对应 Linux 版 scripts/install-native-host.sh 的 Windows 实现，业务逻辑完全一致：
      1. 根据扩展构建产物 manifest.json 的 key 字段自动计算 Chrome 扩展 ID（纯 PowerShell 实现，
         算法：Base64 DER 公钥 → SHA-256 → 前 16 字节 → 每字节高低半字节映射 a-p → 32 字符 ID）；
      2. 在 %LOCALAPPDATA%\BrowserBehaviorAgent\native-host\ 写入 host 清单
         com.browser.behavior.collector.json（免管理员，用户目录可写）；
      3. 写注册表 HKCU（普通用户权限即可，无需管理员）：
           - Chrome：HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.browser.behavior.collector
           - Edge ：HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.browser.behavior.collector
         注册表键的默认值 = host 清单 JSON 的绝对路径。

    Windows 与 Linux 的关键差异：清单里的 path 必须是可执行文件，因此写 node.exe 的绝对路径
    （从 PATH 用 Get-Command node 解析），并用 args 数组传入 daemon\bin\host.js。

    幂等性：可重复执行，New-Item / New-ItemProperty 全部带 -Force，直接覆盖旧值，不会重复累积。
    管理员说明：全部写在 HKCU 与用户目录，**不需要管理员权限**；如需为所有用户安装到 HKLM，
    请自行以管理员身份运行并把脚本内注册表路径改为 HKLM:\（不推荐）。

.PARAMETER ExtensionId
    手动指定扩展 ID（32 位小写字母 a-p）；指定后跳过 manifest.key 计算。

.PARAMETER Manifest
    指定扩展 manifest.json 路径；默认自动查找 <项目根>\extension\.output\chrome-mv3\manifest.json。

.PARAMETER SkipEdge
    跳过 Edge 变体注册（默认 Chrome 与 Edge 都会注册）。

.PARAMETER Help
    显示本帮助。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1 -Help

.EXAMPLE
    # 扩展已构建且 manifest 含 key：自动计算扩展 ID
    powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1

.EXAMPLE
    # 扩展尚未构建：从 chrome://extensions 复制 ID 后手动传入
    powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop

.EXAMPLE
    # 只注册 Chrome，不注册 Edge
    powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1 -ExtensionId <ID> -SkipEdge
#>

[CmdletBinding()]
param(
    [string]$ExtensionId,
    [string]$Manifest,
    [switch]$SkipEdge,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 基础路径：脚本位于 <项目根>\scripts\，项目根即上一级目录
# ---------------------------------------------------------------------------
$Root = Split-Path -Parent $PSScriptRoot
$HostJs = Join-Path $Root 'daemon\bin\host.js'
$HostName = 'com.browser.behavior.collector'

function Write-Info($msg)  { Write-Host "[install-host] $msg" }
function Write-Warn($msg)  { Write-Host "[提示] $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "[错误] $msg" -ForegroundColor Red }

function Show-Help {
    Write-Host @'
============================================================================
install-native-host.ps1 —— Windows 版 Native Messaging Host 一键注册（模块B）
----------------------------------------------------------------------------
功能：
  1. 从扩展 manifest.json 的 key 字段自动计算 Chrome 扩展 ID（SHA-256 → a-p 映射）；
  2. 在 %LOCALAPPDATA%\BrowserBehaviorAgent\native-host\ 写入 host 清单 JSON；
  3. 写注册表 HKCU（Chrome + Edge，默认值 = 清单 JSON 绝对路径，免管理员）。

用法（建议在项目根目录的 PowerShell 中执行）：
  powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1 [选项]

选项：
  -ExtensionId <ID>   手动指定扩展 ID（32 位 a-p 小写字母；扩展尚未构建时使用）
  -Manifest <路径>    指定扩展 manifest.json（默认 extension\.output\chrome-mv3\manifest.json）
  -SkipEdge           跳过 Edge 变体注册（默认 Chrome/Edge 都注册）
  -Help               显示本帮助

示例：
  powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop
  powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1 -Manifest extension\.output\chrome-mv3\manifest.json -SkipEdge

说明：
  * 幂等：可重复执行，自动覆盖旧值；
  * 全部写入 HKCU 与用户目录，不需要管理员权限；
  * 若未装 Node：请先安装 Node.js 20+（https://nodejs.org/）。
============================================================================
'@
}

if ($Help) {
    Show-Help
    exit 0
}

# ---------------------------------------------------------------------------
# 1) 前置检查：host.js 与 node.exe
# ---------------------------------------------------------------------------
if (-not (Test-Path $HostJs)) {
    Write-Err "未找到 host 入口脚本：$HostJs"
    Write-Err "请确认在完整工程目录中运行本脚本（scripts\ 与 daemon\bin\host.js 同级结构）。"
    exit 1
}

try {
    $NodeCmd = Get-Command node -ErrorAction Stop
    $NodePath = $NodeCmd.Source
} catch {
    Write-Err "未在 PATH 中找到 node，请先安装 Node.js 20+（https://nodejs.org/）并重新打开 PowerShell。"
    exit 1
}
Write-Info "Node 可执行文件：$NodePath"
Write-Info "Host 入口脚本：$HostJs"

# ---------------------------------------------------------------------------
# 2) 纯 PowerShell 计算扩展 ID（与 bash 版 node 算法一致）
# ---------------------------------------------------------------------------
function Get-ExtensionIdFromManifest {
    param([string]$ManifestPath)
    # 返回值：扩展 ID 字符串 / $null（文件不存在）/ 'NO_KEY'（manifest 无 key 字段）
    if (-not (Test-Path $ManifestPath)) { return $null }
    try {
        $manifestObj = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Warn "manifest.json 不是合法 JSON：$ManifestPath"
        return $null
    }
    if (-not $manifestObj.key) { return 'NO_KEY' }

    $der = [Convert]::FromBase64String($manifestObj.key)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($der)
    } finally {
        $sha.Dispose()
    }

    # 取前 16 字节；每字节拆成高/低两个半字节（4 位），0-15 映射到 'a'..'p'
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $hash[0..15]) {
        $hi = [int](($b -band 0xF0) / 16)   # 兼容 Windows PowerShell 5.1（无 -shr 运算符）
        $lo = [int]($b -band 0x0F)
        [void]$sb.Append([char]([int][char]'a' + $hi))
        [void]$sb.Append([char]([int][char]'a' + $lo))
    }
    return $sb.ToString()
}

if (-not $ExtensionId) {
    if ($Manifest) {
        $ManifestPath = $Manifest
    } else {
        $ManifestPath = Join-Path $Root 'extension\.output\chrome-mv3\manifest.json'
    }
    Write-Info "未指定 -ExtensionId，尝试读取扩展 manifest：$ManifestPath"
    $computed = Get-ExtensionIdFromManifest -ManifestPath $ManifestPath

    if ($null -eq $computed) {
        Write-Err "未找到扩展 manifest.json（$ManifestPath）。"
        Write-Err "请先在 extension 目录执行 pnpm build，或打开 chrome://extensions 复制该扩展的 ID，然后运行："
        Write-Err "  powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1 -ExtensionId <你的扩展ID>"
        exit 1
    }
    if ($computed -eq 'NO_KEY') {
        Write-Err "manifest.json 缺少 key 字段（扩展尚未配置稳定公钥）。"
        Write-Err "请打开 chrome://extensions 复制该扩展的 ID，然后运行："
        Write-Err "  powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1 -ExtensionId <你的扩展ID>"
        exit 1
    }
    $ExtensionId = $computed
    Write-Info "从 manifest.key 计算得到扩展 ID：$ExtensionId"
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
    Write-Warn "扩展 ID 格式异常（应为 32 位 a-p 小写字母）：$ExtensionId"
}

# ---------------------------------------------------------------------------
# 3) 写 host 清单 JSON（用户可写目录，免管理员）
# ---------------------------------------------------------------------------
# 正常 Windows 环境必有 LOCALAPPDATA；异常环境兜底到用户主目录
$LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $HOME }
$OutDir = Join-Path $LocalAppData 'BrowserBehaviorAgent\native-host'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$JsonPath = Join-Path $OutDir "$HostName.json"

# Windows 的 Native Messaging 清单只认 path，args 会被 Chrome 忽略；
# 且 Chrome 启动 host 时会追加「扩展 origin」和「--parent-window=<hwnd>」两个参数，
# 直接指向 node.exe 会因 bad option 立即退出（表现为 Native host has exited）。
# 因此生成一个 .cmd 启动器作为 path，node.exe 与 host.js 的路径写在启动器里。
$LauncherPath = Join-Path $OutDir 'run-host.cmd'
$LauncherText = "@echo off`r`n`"$NodePath`" `"$HostJs`" %*`r`n"
[System.IO.File]::WriteAllText($LauncherPath, $LauncherText, (New-Object System.Text.UTF8Encoding($false)))

$manifestObj = [ordered]@{
    name            = $HostName
    description     = '浏览器行为采集本地守护进程 Native Messaging Host（模块B，Windows 版）'
    type            = 'stdio'
    path            = $LauncherPath
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
# 以无 BOM 的 UTF-8 写入（Chrome 对带 BOM 的 JSON 兼容性差）
$jsonText = $manifestObj | ConvertTo-Json -Depth 10
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($JsonPath, $jsonText, $utf8NoBom)

Write-Info "Host 启动器已写入：$LauncherPath"
Write-Info "Host 清单已写入：$JsonPath"
Write-Info "  path            = $LauncherPath"
Write-Info "  node            = $NodePath"
Write-Info "  host.js         = $HostJs"
Write-Info "  allowed_origins = chrome-extension://$ExtensionId/"

# ---------------------------------------------------------------------------
# 4) 写注册表 HKCU（Chrome 默认 + Edge 可选）
# ---------------------------------------------------------------------------
function Register-NativeHost {
    param([string]$BrowserName, [string]$RegPath, [string]$JsonFile)
    try {
        if (-not (Test-Path $RegPath)) {
            New-Item -Path $RegPath -Force | Out-Null
        }
        # 设置注册表键的默认值（即未命名值）
        New-ItemProperty -Path $RegPath -Name '(default)' -Value $JsonFile -PropertyType String -Force | Out-Null
        Write-Info "已注册 $BrowserName：$RegPath  =>  (默认值) $JsonFile"
        return $true
    } catch {
        Write-Warn "$BrowserName 注册表写入失败（$RegPath）：$($_.Exception.Message)"
        return $false
    }
}

$ChromeReg = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
Register-NativeHost -BrowserName 'Chrome' -RegPath $ChromeReg -JsonFile $JsonPath | Out-Null

if (-not $SkipEdge) {
    $EdgeReg = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
    Register-NativeHost -BrowserName 'Edge' -RegPath $EdgeReg -JsonFile $JsonPath | Out-Null
} else {
    Write-Info "已按 -SkipEdge 跳过 Edge 注册"
}

# ---------------------------------------------------------------------------
# 5) 完成提示
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==== Native Messaging Host 注册完成（Windows）====" -ForegroundColor Green
Write-Host "Host 名称：$HostName"
Write-Host "清单文件：$JsonPath"
Write-Host "Chrome 注册表：HKCU\Software\Google\Chrome\NativeMessagingHosts\$HostName"
if (-not $SkipEdge) {
    Write-Host "Edge 注册表  ：HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
}
Write-Host ""
Write-Host "下一步："
Write-Host "  1. 重启 Chrome / Edge，扩展通过 chrome.runtime.connectNative('$HostName') 建立长连接。"
Write-Host "  2. 手动启动 HTTP 调试服务：node daemon\bin\daemon.js"
Write-Host "  3. 查看已采集网站：node daemon\bin\cli.js query sites"
