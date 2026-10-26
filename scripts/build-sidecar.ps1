# 编译 AssetWorker sidecar，输出到 Tauri 的 externalBin 目录。
#
# binaries/ 下的内容都是构建产物，不纳入版本控制（见 .gitignore）。
# 新 clone 仓库、或清理过 binaries/ 之后，构建 Tauri 应用前必须先跑本脚本，
# 否则 tauri build 会因为找不到 binaries/AssetWorker-<target>.exe 而失败。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build-sidecar.ps1
param(
    [string]$Configuration = "Release",
    [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "AssetWorker"
$out = Join-Path $root "SoraTrans/src-tauri/binaries"

Write-Host "[1/2] dotnet publish -> $out"
dotnet publish $project -c $Configuration -r win-x64 --self-contained true -p:PublishSingleFile=true -o $out
if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败（exit $LASTEXITCODE）" }

# Tauri 的 externalBin 按 {name}-{target-triple}.exe 定位可执行文件
Write-Host "[2/2] 生成 Tauri 需要的文件名 AssetWorker-$TargetTriple.exe"
Copy-Item (Join-Path $out "AssetWorker.exe") (Join-Path $out "AssetWorker-$TargetTriple.exe") -Force

Write-Host "完成。现在可以执行 npm run tauri build。"
