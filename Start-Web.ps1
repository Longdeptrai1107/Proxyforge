param(
    [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 8787 }),
    [switch]$NoBrowser
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) { throw "Run Run-Python.cmd to set up Python first." }
if ($Port -lt 1 -or $Port -gt 65535) { throw "PORT must be between 1 and 65535." }
$origin = "http://127.0.0.1:$Port"

# Reopening the launcher must load the current backend before opening its UI.
# Only replace a listener whose process (or venv parent) belongs to this project.
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $listener.OwningProcess)
    $launcher = $owner
    $expected = '^"?' + [regex]::Escape($python) + '"?\s+-m\s+proxyforge\.web(?:\s|$)'
    if ($owner.CommandLine -notmatch $expected) {
        $launcher = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $owner.ParentProcessId)
    }
    if (-not $launcher -or $launcher.CommandLine -notmatch $expected) {
        throw "Port $Port is used by another application. Set PORT to a free port."
    }
    $state = Invoke-RestMethod "$origin/api/state" -TimeoutSec 10
    if (-not $state.token) { throw "Could not identify the running ProxyForge API." }
    Write-Host "Saving and restarting this project's existing backend on port $Port..."
    Invoke-RestMethod "$origin/api/stop" -Method Post -ContentType "application/json" -Body '{}' `
        -Headers @{ "X-Proxy-Forge-Token" = $state.token } -TimeoutSec 30 | Out-Null
    & taskkill.exe /PID $launcher.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not stop the previous backend." }
    Wait-Process -Id $listener.OwningProcess -Timeout 10 -ErrorAction SilentlyContinue
}

$env:PORT = [string]$Port
$backend = Start-Process -FilePath $python -ArgumentList '-m', 'proxyforge.web' -WorkingDirectory $root -NoNewWindow -PassThru
$ready = $false
try {
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ($backend.HasExited) { throw "Python backend exited before startup completed." }
        try {
            $state = Invoke-RestMethod "$origin/api/state" -TimeoutSec 2
            $ready = $null -ne $state.automation -and $state.automation.enabled
        } catch [System.Net.WebException] { }
        if ($ready) { break }
        Start-Sleep -Milliseconds 150
    }
    if (-not $ready) { throw "Backend did not start its automatic collector." }
    Write-Host "Backend auto is running: $origin (every 60 seconds, 10,000 checks, 3-second timeout)"
    if (-not $NoBrowser) { Start-Process $origin }
    Wait-Process -Id $backend.Id
} finally {
    if (-not $ready -and -not $backend.HasExited) { & taskkill.exe /PID $backend.Id /T /F | Out-Null }
}
