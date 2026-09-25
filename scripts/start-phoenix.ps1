$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:PHOENIX_WORKING_DIR = Join-Path $projectRoot '.phoenix'
$env:PHOENIX_HOST = '127.0.0.1'
$env:PHOENIX_PORT = '6006'
$env:PHOENIX_ALLOW_EXTERNAL_RESOURCES = 'false'
$env:PHOENIX_DISABLE_AGENT_ASSISTANT = 'true'
$env:PHOENIX_ALLOWED_SANDBOX_PROVIDERS = 'NONE'
$env:PHOENIX_ENABLE_MCP_SERVER = 'false'
$env:PHOENIX_LOG_MIGRATIONS = 'false'
$phoenixExe = Join-Path $projectRoot '.venv-phoenix\Scripts\phoenix.exe'
if (!(Test-Path -LiteralPath $phoenixExe)) {
    throw 'Install Phoenix first: uv venv .venv-phoenix; uv pip install --python .venv-phoenix\Scripts\python.exe -r requirements-phoenix.txt'
}
Write-Host 'Phoenix dashboard: http://127.0.0.1:6006 (Ctrl+C to stop)'
& $phoenixExe serve
exit $LASTEXITCODE
