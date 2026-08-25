$ErrorActionPreference = 'Stop'

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Error '未找到 Node.js。请先安装 Node.js 18+；团队模式需要 20.18.1+。'
  exit 1
}

$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCommand) {
  Write-Error '未找到 Git。请先安装 Git for Windows，并重新打开 PowerShell。'
  exit 1
}

$setupScript = Join-Path $PSScriptRoot 'setup.mjs'
& $nodeCommand.Path $setupScript @args
exit $LASTEXITCODE
