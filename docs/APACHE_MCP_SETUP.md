# Apache MCP Setup

Career-Ops can sit behind your existing local Apache/XAMPP server so ChatGPT
connects to a stable local front door instead of directly to the Node MCP port.

## Local Architecture

- Apache/XAMPP listens on your normal local web ports.
- Apache proxies:
  - `/career-ops-mcp` -> `http://127.0.0.1:8790/mcp`
  - `/career-ops-health` -> `http://127.0.0.1:8790/health`
- The Node MCP server remains localhost-only and read-only by default.

## Current Local Paths

- Apache config root:
  `C:/Users/dntpa/OneDrive/PersonalWebsite/xampp/apache/conf`
- Apache include added:
  `C:/Users/dntpa/OneDrive/PersonalWebsite/xampp/apache/conf/extra/httpd-career-ops.conf`
- Career-Ops startup script:
  [start-mcp-readonly.ps1](/G:/My%20Drive/career-ops/start-mcp-readonly.ps1)

## One-Time Apache Changes

The local Apache config now:

- loads `mod_proxy_http`
- includes `conf/extra/httpd-career-ops.conf`
- proxies local-only requests to the MCP server

The proxy include restricts both paths with `Require local`, so Apache will
only serve them to requests originating on the same machine.

## Start The Read-Only MCP Server

```powershell
powershell -ExecutionPolicy Bypass -File .\start-mcp-readonly.ps1
```

Expected local backend endpoint:

```text
http://127.0.0.1:8790/mcp
```

Expected Apache front-door endpoints:

```text
http://127.0.0.1/career-ops-mcp
http://127.0.0.1/career-ops-health
```

## Optional Persistence

To register a per-user logon task that starts the read-only MCP server:

```powershell
powershell -ExecutionPolicy Bypass -File .\register-mcp-readonly-task.ps1
```

Task name:

```text
CareerOpsMcpReadOnly
```

## Apache Validation

Validate Apache config:

```powershell
& 'C:\Users\dntpa\OneDrive\PersonalWebsite\xampp\apache\bin\httpd.exe' -t -f 'C:\Users\dntpa\OneDrive\PersonalWebsite\xampp\apache\conf\httpd.conf'
```

## ChatGPT / Tunnel Use

If you expose Apache through Cloudflare or another HTTPS front door, point the
ChatGPT MCP app at:

```text
https://<your-public-host>/career-ops-mcp
```

That way Apache remains the stable shareable surface, while the Node MCP
process stays localhost-bound.

## OAuth Metadata Proxy Path

When OAuth mode is enabled on the MCP server, Apache should also expose the
protected-resource metadata path:

```text
/.well-known/oauth-protected-resource/career-ops-mcp
```

This repo's Apache include already proxies that path to the local Node server.
