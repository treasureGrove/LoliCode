param([ValidateSet('dev','build')][string]$Mode)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCargoBin = Join-Path $env:USERPROFILE '.cargo/bin'
if (Test-Path -LiteralPath (Join-Path $taskCargoBin 'cargo.exe')) {
    $env:Path = $taskCargoBin + ';' + $env:Path
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Install the Rust MSVC toolchain before building TAI Switch.'
}
Push-Location (Join-Path $taskRoot 'apps/desktop')
try {
    & (Join-Path $taskRoot 'node_modules/.bin/tauri.cmd') $Mode @args
    exit $LASTEXITCODE
} finally { Pop-Location }
