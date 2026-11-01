<#
.SYNOPSIS
    install-native-host.ps1 —— Windows 版 Native Messaging Host 一键注册脚本（模块B）
.DESCRIPTION
    对应 Linux 版 scripts/install-native-host.sh 的 Windows 实现：
      1. 根据扩展 manifest.json 的 key 字段自动计算 Chrome 扩展 ID（纯 PowerShell，SHA-256→a-p 映射）；
      2. 在 %LOCALAPPDATA%\BrowserBehaviorAgent\native-host\ 写入 host 清单 JSON；
      3. 写注册表 HKCU（Chrome 与 Edge，默认值 = 清单 JSON 绝对路径，免管理员）。
    幂等：可重复执行，New-Item / New-ItemProperty 全部带 -Force，直接覆盖旧值。
    全部写在 HKCU 与用户目录，不需要管理员权限。
.PARAMETER ExtensionId  手动指定扩展 ID（32 位 a-p 小写字母）
.PARAMETER Manifest     指定扩展 manifest.json 路径
.PARAMETER SkipEdge     跳过 Edge 变体注册
.PARAMETER Help         显示本帮助
#>