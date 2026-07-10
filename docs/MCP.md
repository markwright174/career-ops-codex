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
- `record_evaluation`
- `prepare_package`
- `build_quality_package_for_row`
- `prepare_application`
- `update_application_status`
- `update_inbox_item`

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
- optional OAuth resource-server mode for ChatGPT / remote MCP clients

Optional bearer token:

```powershell
$env:CAREER_OPS_MCP_TOKEN = 'replace-with-a-long-random-secret'
npm run mcp
```

Enable write tools only intentionally:

```powershell
$env:CAREER_OPS_MCP_ALLOW_WRITE = '1'
```

Or use the single reset script in this repo:

```powershell
powershell -ExecutionPolicy Bypass -File .\mcp\reset.ps1
```

## OAuth / Auth0 Mode

Career-Ops MCP can also act as an OAuth-protected resource server. When the
following environment variables are set, the MCP endpoint requires bearer
tokens and advertises authorization discovery metadata for MCP clients:

```powershell
$env:CAREER_OPS_MCP_PUBLIC_BASE_URL = 'https://mcp.example.com'
$env:CAREER_OPS_MCP_PUBLIC_PATH = '/mcp'
$env:CAREER_OPS_MCP_OAUTH_ISSUER = 'https://auth.example.com/'
$env:CAREER_OPS_MCP_OAUTH_AUDIENCE = 'https://mcp.example.com/mcp'
```

Optional scopes:

```powershell
$env:CAREER_OPS_MCP_READ_SCOPE = 'career_ops:read'
$env:CAREER_OPS_MCP_WRITE_SCOPE = 'career_ops:write'
```

What this enables:

- `/.well-known/oauth-protected-resource/...` metadata for MCP discovery
- bearer-token validation against the issuer's OpenID configuration and JWKS
- read-scope enforcement for read tools
- write-scope enforcement for write tools

This is designed to work well with Auth0 custom domains, for example:

```powershell
$env:CAREER_OPS_MCP_PUBLIC_BASE_URL = 'https://mcp.example.com'
$env:CAREER_OPS_MCP_PUBLIC_PATH = '/mcp'
$env:CAREER_OPS_MCP_OAUTH_ISSUER = 'https://auth.example.com/'
$env:CAREER_OPS_MCP_OAUTH_AUDIENCE = 'https://mcp.example.com/mcp'
```

## ChatGPT Compatibility Note

OpenAI’s current ChatGPT MCP/developer-mode docs require a **remote** MCP
server, not a local-only one. That means ChatGPT use still needs:

1. this MCP server running locally
2. an HTTPS tunnel
3. ChatGPT developer mode with a custom MCP connector

The OAuth-capable path now exists in this repo, but it still requires:

1. a stable remote hostname
2. an OAuth provider configured for ChatGPT
3. the MCP server running with the OAuth environment variables above

In practice, ChatGPT connector use can now be done in either of these modes:

1. no auth at the MCP layer for early read-only testing
2. OAuth at the MCP layer for stable, secure app use

The remaining work is app/provider wiring rather than missing server support.

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
- existing tracker statuses / notes
- pipeline inbox item states / notes

The write tools still reuse the repo’s normal flow:

- tracker additions via TSV
- `merge-tracker.mjs`
- `verify-pipeline.mjs`
- existing tracker row updates only for status/notes/PDF fields
- existing pipeline row updates only for state/note fields

## Hybrid Evaluation Mode

If you want ChatGPT to do the reasoning itself instead of relying on the
Gemini-backed repo evaluator, use the `record_evaluation` tool:

1. ChatGPT reads the job posting and writes the evaluation in-chat
2. ChatGPT calls `record_evaluation`
3. Career-Ops writes:
   - a report in `reports/`
   - a tracker TSV addition in `batch/tracker-additions/`
   - then runs `merge-tracker.mjs` and `verify-pipeline.mjs`

This keeps the repo canonical without forcing every evaluation through Gemini.

### Chat-aware evaluate/apply-prep bridge

`evaluate_role` and `prepare_application` now use a Chat-aware bridge when they
are called through the ChatGPT MCP frontend:

1. Career-Ops still performs the normal preflight steps:
   - URL fetch
   - Playwright page load and SPA hydration wait
   - final URL capture
   - page title capture
   - body-text extraction
   - JD text file creation in `output/`
2. Before any Gemini-only step, the pipeline returns a `hybrid-preflight`
   result to ChatGPT instead of failing on Gemini auth.
3. ChatGPT can then:
   - reason over the extracted JD text in conversation
   - persist the evaluation with `record_evaluation`
   - continue into package generation through the hybrid package tools

Typical `hybrid-preflight` payload fields include:

- `requested_url`
- `final_url`
- `page_title`
- `result`
- `reason`
- `apply_detected`
- `body_text`
- `body_text_chars`
- `jd_file`
- `next_step`

This keeps the useful extraction/liveness steps in the existing pipeline while
avoiding Gemini auth failures for the ChatGPT frontend path.

## Hybrid Package Mode

`prepare_package` now supports a hybrid path too:

1. ChatGPT authors the tailored CV brief JSON and cover-letter JSON
2. ChatGPT calls `prepare_package` with `brief` and `letter`
3. Career-Ops writes the JSON artifacts into `output/`
4. Career-Ops runs:
   - `build-tailored-cv.mjs`
   - `build-cover-letter.mjs`
   - PDF generation
   - tracker PDF-status update
   - `verify-pipeline.mjs`

This lets ChatGPT do the tailoring while the repo still owns artifact creation
and tracker updates, without depending on Gemini for package generation.
Package responses now include a `quality_gate` object plus `completion_status`
so Chat can distinguish between:

- `built` artifacts
- packages that still need Chat review
- packages that are fully ready to send

Treat a package as complete only when `completion_status` is `complete` or
after Chat has explicitly verified the artifact quality.
If Chat wants to bless a package after review, pass `chat_verified=true` on the
same package tool with the final payload.

For an existing tracker row, prefer `build_quality_package_for_row`:

1. call it with `num` only
2. it returns:
   - tracker row context
   - report content
   - CV chronology
   - profile context
   - built-in quality rules
3. ChatGPT drafts builder-ready `brief` and `letter` JSON
4. call `build_quality_package_for_row` again with the same `num` plus the JSON
5. Career-Ops runs:
   - structure validation
   - row-aware quality checks
   - cover-letter quality checks for role mention, company mention, role-specific themes, and generic-opening warnings
   - package build
   - tracker PDF update
   - `verify-pipeline.mjs`
   - returns `quality_gate` and `completion_status` so Chat can decide whether the artifact is actually ready

This is the preferred path when the user says things like "let's apply" for a
known tracker row and you want the repo to carry the package rubric instead of
repeating a long prompt every time.

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
