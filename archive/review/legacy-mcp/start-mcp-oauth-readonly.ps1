$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:CAREER_OPS_MCP_PORT) { $env:CAREER_OPS_MCP_PORT } else { '8790' }
$healthUrl = "http://127.0.0.1:$port/health"
$localConfigPath = Join-Path $repoRoot 'local\mcp-oauth-local.ps1'

if (Test-Path $localConfigPath) {
    . $localConfigPath
}

function Test-CareerOpsHealth {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $Url
        return ($response.StatusCode -eq 200 -and $response.Content -match '"service"\s*:\s*"career-ops-mcp"')
    } catch {
        return $false
    }
}

function Test-CareerOpsOAuthMetadata {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $Url
        return (
            $response.StatusCode -eq 200 -and
            $response.Content -match '"authorization_servers"\s*:'
        )
    } catch {
        return $false
    }
}

function Get-RequiredEnvValue {
    param(
        [string]$Name,
        [string]$Example
    )

    $value = [Environment]::GetEnvironmentVariable($Name)
    if (-not $value) {
        throw "Missing required environment variable $Name. Set it in the current session or in mcp-oauth-local.ps1 (example: $Example)."
    }
    return $value
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

if ((Test-CareerOpsHealth -Url $healthUrl) -and (Test-CareerOpsOAuthMetadata -Url $metadataUrl)) {
    Write-Output "career-ops OAuth MCP is already healthy at $healthUrl"
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
$env:CAREER_OPS_MCP_PUBLIC_BASE_URL = Get-RequiredEnvValue -Name 'CAREER_OPS_MCP_PUBLIC_BASE_URL' -Example 'https://mcp.example.com'
$env:CAREER_OPS_MCP_PUBLIC_PATH = Get-RequiredEnvValue -Name 'CAREER_OPS_MCP_PUBLIC_PATH' -Example '/mcp'
$env:CAREER_OPS_MCP_OAUTH_ISSUER = Get-RequiredEnvValue -Name 'CAREER_OPS_MCP_OAUTH_ISSUER' -Example 'https://auth.example.com/'
$env:CAREER_OPS_MCP_OAUTH_AUDIENCE = Get-RequiredEnvValue -Name 'CAREER_OPS_MCP_OAUTH_AUDIENCE' -Example 'https://mcp.example.com/mcp'
$env:CAREER_OPS_MCP_READ_SCOPE = '__none__'
$env:CAREER_OPS_MCP_WRITE_SCOPE = 'career_ops:write'
$publicPath = $env:CAREER_OPS_MCP_PUBLIC_PATH.TrimStart('/')
$metadataUrl = "http://127.0.0.1:$port/.well-known/oauth-protected-resource/$publicPath"

$nodeProc = Start-Process powershell `
    -WindowStyle Hidden `
    -PassThru `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "cd '$repoRoot'; npm run mcp"

for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Seconds 1
    if ((Test-CareerOpsHealth -Url $healthUrl) -and (Test-CareerOpsOAuthMetadata -Url $metadataUrl)) {
        Write-Output "career-ops OAuth MCP started on $($env:CAREER_OPS_MCP_PUBLIC_BASE_URL)$($env:CAREER_OPS_MCP_PUBLIC_PATH) (local PID $($nodeProc.Id))"
        exit 0
    }
}

Write-Error "career-ops OAuth MCP did not start successfully on port $port"
