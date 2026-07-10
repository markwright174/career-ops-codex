$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$localConfigPath = Join-Path $repoRoot 'local\mcp-oauth-local.ps1'

if (Test-Path $localConfigPath) {
    . $localConfigPath
}

$token = [Environment]::GetEnvironmentVariable('CAREER_OPS_CLOUDFLARED_TUNNEL_TOKEN')
if (-not $token) {
    throw 'Missing CAREER_OPS_CLOUDFLARED_TUNNEL_TOKEN. Set it in local\mcp-oauth-local.ps1 first.'
}

$cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source
& $cloudflared tunnel run --token $token
