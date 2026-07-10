param(
    [switch]$AllowWrite
)

$ErrorActionPreference = 'Stop'

$mcpDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $mcpDir
$localConfigPath = Join-Path $repoRoot 'local\mcp-oauth-local.ps1'

if (-not (Test-Path $localConfigPath)) {
    throw "Missing local config at $localConfigPath. Copy local\mcp-oauth-local.example.ps1 first."
}

. $localConfigPath

function Get-PortOwnerPids {
    param([int]$LocalPort)

    $lines = netstat -ano | Select-String "(:|\\.)$LocalPort\s+.*LISTENING"
    $pids = @()
    foreach ($line in $lines) {
        $parts = ($line.ToString() -split '\s+') | Where-Object { $_ }
        if ($parts.Count -gt 0 -and $parts[-1] -match '^\d+$') {
            $pids += [int]$parts[-1]
        }
    }
    return $pids | Select-Object -Unique
}

function Stop-ProcessByName {
    param([string]$Name)

    Get-Process -Name $Name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Stop-ListeningPort {
    param([int]$LocalPort)

    foreach ($ownerPid in Get-PortOwnerPids -LocalPort $LocalPort) {
        try {
            Stop-Process -Id $ownerPid -Force -ErrorAction Stop
        } catch {
            Write-Output "Could not stop PID $ownerPid on port ${LocalPort}: $($_.Exception.Message)"
        }
    }
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
        return ($response.StatusCode -eq 200 -and $response.Content -match '"authorization_servers"\s*:') 
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
        throw "Missing required environment variable $Name. Set it in local\mcp-oauth-local.ps1 (example: $Example)."
    }
    return $value
}

$port = if ($env:CAREER_OPS_MCP_PORT) { [int]$env:CAREER_OPS_MCP_PORT } else { 8790 }
$healthUrl = "http://127.0.0.1:$port/health"
$metadataPath = [Environment]::GetEnvironmentVariable('CAREER_OPS_MCP_PUBLIC_PATH')
if (-not $metadataPath) { $metadataPath = '/mcp' }
$metadataUrl = "http://127.0.0.1:$port/.well-known/oauth-protected-resource/$($metadataPath.TrimStart('/'))"

Write-Output "Stopping any existing MCP/tunnel processes..."
Stop-ProcessByName -Name 'cloudflared'
Stop-ListeningPort -LocalPort $port
Start-Sleep -Seconds 2

$env:CAREER_OPS_MCP_HOST = '127.0.0.1'
$env:CAREER_OPS_MCP_PORT = "$port"
$env:CAREER_OPS_MCP_ALLOW_WRITE = $(if ($AllowWrite) { '1' } else { '0' })
$env:CAREER_OPS_MCP_TOKEN = ''
$env:CAREER_OPS_MCP_PUBLIC_BASE_URL = Get-RequiredEnvValue -Name 'CAREER_OPS_MCP_PUBLIC_BASE_URL' -Example 'https://mcp.example.com'
$env:CAREER_OPS_MCP_PUBLIC_PATH = Get-RequiredEnvValue -Name 'CAREER_OPS_MCP_PUBLIC_PATH' -Example '/mcp'
$env:CAREER_OPS_MCP_OAUTH_ISSUER = Get-RequiredEnvValue -Name 'CAREER_OPS_MCP_OAUTH_ISSUER' -Example 'https://auth.example.com/'
$env:CAREER_OPS_MCP_OAUTH_AUDIENCE = Get-RequiredEnvValue -Name 'CAREER_OPS_MCP_OAUTH_AUDIENCE' -Example 'https://mcp.example.com/mcp'
$env:CAREER_OPS_MCP_READ_SCOPE = '__none__'
$env:CAREER_OPS_MCP_WRITE_SCOPE = 'career_ops:write'

Write-Output "Starting MCP server..."
$nodeProc = Start-Process powershell `
    -WindowStyle Hidden `
    -PassThru `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Set-Location -LiteralPath '$repoRoot'; npm run mcp"

for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 1
    if ((Test-CareerOpsHealth -Url $healthUrl) -and (Test-CareerOpsOAuthMetadata -Url $metadataUrl)) {
        break
    }
}

if (-not ((Test-CareerOpsHealth -Url $healthUrl) -and (Test-CareerOpsOAuthMetadata -Url $metadataUrl))) {
    throw "MCP did not become healthy on $healthUrl"
}

if (-not ($env:CAREER_OPS_CLOUDFLARED_TUNNEL_TOKEN)) {
    throw 'Missing CAREER_OPS_CLOUDFLARED_TUNNEL_TOKEN in local\mcp-oauth-local.ps1.'
}

Write-Output "Starting Cloudflare tunnel..."
$cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source
$tunnelProc = Start-Process -FilePath $cloudflared -WindowStyle Hidden -PassThru -ArgumentList 'tunnel', 'run', '--token', $env:CAREER_OPS_CLOUDFLARED_TUNNEL_TOKEN

Start-Sleep -Seconds 3

Write-Output "career-ops reset complete."
Write-Output "  MCP PID: $($nodeProc.Id)"
Write-Output "  Tunnel PID: $($tunnelProc.Id)"
Write-Output "  Health: $healthUrl"
Write-Output "  Metadata: $metadataUrl"
