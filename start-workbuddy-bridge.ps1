# workbuddy-bridge launcher (ASCII-only so Windows PowerShell 5.1 reads it correctly)
#
# Exposes the locally logged-in WorkBuddy (Tencent coding assistant) subscription
# as a local OpenAI-compatible endpoint for DSH's custom provider "workbuddy".
#
# Usage:
#   start-workbuddy-bridge.ps1              # run in foreground, Ctrl+C to stop
#   start-workbuddy-bridge.ps1 -Background  # run hidden, logs to bridge.log
#   start-workbuddy-bridge.ps1 -Check       # preflight only, do not start
#
# Optional environment variables:
#   WORKBUDDY_PORT          listen port, default 8790
#   WORKBUDDY_LOCAL_TOKEN   require this Bearer token on the local endpoint
#   CODEBUDDY_API_KEY       use an API key (ck_xxx) instead of the desktop login
#   WORKBUDDY_LOG=1         verbose per-request logging
#   WORKBUDDY_HOST          bind address, default 127.0.0.1

[CmdletBinding()]
param(
    [switch]$Background,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $here 'workbuddy-bridge.mjs'
$logPath = Join-Path $here 'bridge.log'
$errPath = Join-Path $here 'bridge.error.log'
$port = if ($env:WORKBUDDY_PORT) { $env:WORKBUDDY_PORT } else { '8790' }
$base = "http://127.0.0.1:$port"

function Test-Health {
    try { return Invoke-RestMethod -Uri "$base/health" -TimeoutSec 3 } catch { return $null }
}

function Test-Prereqs {
    # Delegates to the bridge's own --check so auth-path resolution has one source of truth.
    & node $entry --check
    $code = $LASTEXITCODE

    if ($code -eq 0) {
        Write-Host "[ok] prerequisites satisfied" -ForegroundColor Green
    } else {
        Write-Host '[FAIL] prerequisites not satisfied (see above)' -ForegroundColor Red
    }

    $h = Test-Health
    if ($h) { Write-Host "[info] an instance is already running at $base ($($h.auth.userId))" -ForegroundColor Green }
    else { Write-Host "[info] nothing listening on $base yet" -ForegroundColor DarkGray }

    return ($code -eq 0)
}

if ($Check) {
    if (Test-Prereqs) { exit 0 } else { exit 1 }
}

if (-not (Test-Prereqs)) { exit 1 }

if (Test-Health) {
    Write-Host ''
    Write-Host "workbuddy-bridge is already running: $base/v1" -ForegroundColor Cyan
    exit 0
}

if ($Background) {
    Write-Host ''
    Write-Host "starting workbuddy-bridge in background; log: $logPath" -ForegroundColor Cyan
    # Background runs get per-request logging by default: it is what makes a blocked
    # upstream (code 11128) diagnosable after the fact. Set WORKBUDDY_LOG=0 to disable.
    if ($env:WORKBUDDY_LOG -ne '0') { $env:WORKBUDDY_LOG = '1' }
    $p = Start-Process -FilePath 'node' -ArgumentList @($entry) -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $logPath -RedirectStandardError $errPath
    Start-Sleep -Seconds 2

    $healthy = $false
    for ($i = 0; $i -lt 10; $i++) {
        if (Test-Health) { $healthy = $true; break }
        Start-Sleep -Milliseconds 700
    }
    if ($healthy) {
        Write-Host "[ok] started (pid $($p.Id)) -> $base/v1" -ForegroundColor Green
        Write-Host "     stop with: Stop-Process -Id $($p.Id)" -ForegroundColor DarkGray
        Write-Host "     log (UTF-8): Get-Content '$logPath' -Encoding UTF8 -Tail 40 -Wait" -ForegroundColor DarkGray
        exit 0
    }
    Write-Host '[FAIL] started but health check failed; see bridge.error.log' -ForegroundColor Red
    Get-Content $errPath -Tail 20 -ErrorAction SilentlyContinue
    exit 1
}

Write-Host ''
Write-Host "workbuddy-bridge running in foreground (Ctrl+C to stop) -> $base/v1" -ForegroundColor Cyan
& node $entry
