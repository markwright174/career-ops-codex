# MCP Server

Career-Ops now includes a narrow MCP server for exposing repo operations to
ChatGPT developer mode or any other MCP client.

It does **not** invent a second workflow. It maps named MCP tools onto the
existing `chat-ops.mjs` command surface and the existing Career-Ops scripts.

## Purpose

Use this server when you want ChatGPT to act like a frontend over the repo
instead of reasoning from raw files every turn.

The MCP layer exposes named tools such as:

- `scan_safe_shortlist`
- `show_inbox`
- `show_applied`
- `show_evaluated`
- `show_tracker`
- `show_patterns`
- `show_quick_apply`
- `verify_pipeline`
- `check_liveness`
- `show_project_profile`
- `show_repo_summary`
- `show_attention_report`
- `evaluate_role`
- `prepare_package`
- `prepare_application`

## Local Startup

```powershell
npm run mcp
```

Default endpoint:

```text
http://127.0.0.1:8790/mcp
```

Health endpoint:

```text
http://127.0.0.1:8790/health
```

If you already run Apache/XAMPP every day, you can front the local MCP server
through Apache instead of tunneling the raw Node port directly. See
[docs/APACHE_MCP_SETUP.md](/G:/My%20Drive/career-ops/docs/APACHE_MCP_SETUP.md).

## Security Defaults

- binds to `127.0.0.1` by default
- write tools are disabled unless you explicitly enable them
- optional bearer token support for manual/private clients
- in-memory request rate limiting

Optional bearer token:

```powershell
$env:CAREER_OPS_MCP_TOKEN = 'replace-with-a-long-random-secret'
npm run mcp
```

Enable write tools only intentionally:

```powershell
$env:CAREER_OPS_MCP_ALLOW_WRITE = '1'
```

## ChatGPT Compatibility Note

OpenAI’s current ChatGPT MCP/developer-mode docs require a **remote** MCP
server, not a local-only one. That means ChatGPT use still needs:

1. this MCP server running locally
2. an HTTPS tunnel
3. ChatGPT developer mode with a custom MCP connector

Important caveat: this server currently supports **optional bearer-token auth**
for manual clients, but it does **not** yet implement OAuth. In practice, that
means direct ChatGPT connector use will likely need one of these setups:

1. no auth at the MCP layer, with security handled by a trusted tunnel boundary
2. a future OAuth upgrade

That is the main remaining gap between “works locally” and “clean ChatGPT
connector setup.”

## Protocol Notes

- endpoint path: `POST /mcp`
- health: `GET /health`
- supported protocol versions:
  - `2025-11-25`
  - `2025-06-18`
  - `2025-03-26`
  - `2024-11-05`
  - `2024-10-07`

The implementation is intentionally tool-focused:

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

## Write Tool Discipline

Write-capable tools remain guarded because they can create or update:

- reports
- tracker TSV additions
- merged tracker rows
- generated CV / cover letter artifacts

The write tools still reuse the repo’s normal flow:

- tracker additions via TSV
- `merge-tracker.mjs`
- `verify-pipeline.mjs`

## Recommended Use

For the safest day-to-day setup:

1. keep the MCP server localhost-bound
2. leave write tools off by default
3. turn on write tools only during intentional apply-prep sessions
4. expose the server through HTTPS only when you are ready to connect ChatGPT

## Related Docs

- [docs/CHATGPT_FRONTEND.md](/G:/My%20Drive/career-ops/docs/CHATGPT_FRONTEND.md)
- [docs/BRIDGE.md](/G:/My%20Drive/career-ops/docs/BRIDGE.md)
- [docs/CODEX_HANDOFF.md](/G:/My%20Drive/career-ops/docs/CODEX_HANDOFF.md)
