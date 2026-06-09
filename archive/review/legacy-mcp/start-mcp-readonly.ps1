$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = $scriptDir
while ($repoRoot -and -not (Test-Path (Join-Path $repoRoot 'package.json'))) {
    $parent = Split-Path -Parent $repoRoot
    if ($parent -eq $repoRoot) {
        break
    }
    $repoRoot = $parent
}

if (-not (Test-Path (Join-Path $repoRoot 'package.json'))) {
    throw "Could not locate repo root from $scriptDir"
}

$port = if ($env:CAREER_OPS_MCP_PORT) { $env:CAREER_OPS_MCP_PORT } else { '8790' }
$healthUrl = "http://127.0.0.1:$port/health"

function Test-CareerOpsHealth {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $Url
        return ($response.StatusCode -eq 200 -and $response.Content -match '"service"\s*:\s*"career-ops-mcp"')
    } catch {
        return $false
    }
}

function Get-PortOwnerPid {
    param([string]$LocalPort)

    $match = netstat -ano | Select-String "127\.0\.0\.1:$LocalPort\s+.*LISTENING" | Select-Object -First 1
    if (-not $match) {
        $match = netstat -ano | Select-String ":$LocalPort\s+.*LISTENING" | Select-Object -First 1
    }
    if (-not $match) {
        return $null
    }

    $parts = ($match.ToString() -split '\s+') | Where-Object { $_ }
    if ($parts.Length -gt 0) {
        return [int]$parts[-1]
    }

    return $null
}

if (Test-CareerOpsHealth -Url $healthUrl) {
    Write-Output "career-ops MCP is already healthy at $healthUrl"
    exit 0
}

$existingPid = Get-PortOwnerPid -LocalPort $port
if ($existingPid) {
    try {
        $existingProc = Get-Process -Id $existingPid -ErrorAction Stop
        Write-Output "Port $port is occupied by $($existingProc.ProcessName) (PID $existingPid); stopping stale listener."
        Stop-Process -Id $existingPid -Force
        Start-Sleep -Seconds 2
    } catch {
        Write-Output "Port $port is occupied by PID $existingPid; could not inspect process details."
    }
}

$env:CAREER_OPS_MCP_HOST = '127.0.0.1'
$env:CAREER_OPS_MCP_ALLOW_WRITE = '0'
$env:CAREER_OPS_MCP_TOKEN = ''

$nodeProc = Start-Process powershell `
    -WindowStyle Hidden `
    -PassThru `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "cd '$repoRoot'; npm run mcp"

for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Seconds 1
    if (Test-CareerOpsHealth -Url $healthUrl) {
        Write-Output "career-ops MCP started on http://127.0.0.1:$port/mcp (PID $($nodeProc.Id))"
        exit 0
    }
}

Write-Error "career-ops MCP did not start successfully on port $port"
