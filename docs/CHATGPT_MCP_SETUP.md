# ChatGPT MCP Setup

This is the practical setup path for using ChatGPT as a frontend over the
Career-Ops repo through the MCP server in [mcp-server.mjs](/G:/My%20Drive/career-ops/mcp-server.mjs).

## What This Solves

Without MCP, ChatGPT tends to:

- fall back to web search
- reason from stale memory
- improvise a parallel workflow

With MCP, ChatGPT can call named repo tools such as:

- `scan_safe_shortlist`
- `show_inbox`
- `show_applied`
- `show_evaluated`
- `show_tracker`
- `show_quick_apply`
- `verify_pipeline`
- `evaluate_role`
- `prepare_package`
- `build_quality_package_for_row`
- `prepare_application`

## Current Reality

Per OpenAI’s current docs:

- ChatGPT developer mode supports custom MCP apps/connectors
- only **remote** MCP servers are supported in ChatGPT
- ChatGPT can present an OAuth flow when your remote MCP app is configured for OAuth

That means your local server must be exposed remotely before ChatGPT can use it.

For public-repo hygiene, keep your real MCP/Auth hostnames in an ignored local
file instead of hardcoding them into tracked scripts. This repo includes
[mcp-oauth-local.example.ps1](/G:/My%20Drive/career-ops/mcp-oauth-local.example.ps1)
as the template for that local config.

## Recommended Rollout

Use this in phases instead of going straight to full write-enabled remote use.

### Phase 1: Local read-only validation

Start the MCP server locally:

```powershell
npm run mcp
```

Or with an optional local bearer token:

```powershell
$env:CAREER_OPS_MCP_TOKEN = 'replace-with-a-long-random-secret'
npm run mcp
```

Run the smoke test:

```powershell
npm run mcp:smoke
```

This confirms:

- `initialize`
- `tools/list`
- `tools/call`

### Phase 2: Remote read-only ChatGPT test

For the first remote test, keep it conservative:

- leave write tools disabled
- do not rely on bearer-token auth at the MCP layer for ChatGPT
- use a temporary HTTPS tunnel

Start the local MCP server:

```powershell
npm run mcp
```

Tunnel it with one of these examples:

```powershell
cloudflared tunnel --url http://127.0.0.1:8790
```

or:

```powershell
ngrok http http://127.0.0.1:8790
```

Use the tunnel URL with the `/mcp` path when configuring the app in ChatGPT.

Example:

```text
https://your-random-subdomain.trycloudflare.com/mcp
```

### Phase 3: ChatGPT developer mode app setup

Based on OpenAI’s current setup flow:

1. Enable developer mode in ChatGPT
2. Go to `Settings -> Apps -> Create` or the workspace Apps settings
3. Provide the remote MCP endpoint URL
4. Choose authentication
5. Save as a draft app
6. Test in chat

For this repo today, the practical auth choices are:

1. **No auth at MCP layer for initial testing**
2. **OAuth for the stable production-like setup**

ChatGPT developer mode supports OAuth, No Authentication, and Mixed
Authentication for remote MCP apps. For Career-Ops, OAuth is the intended
long-term setup because it gives you a stable app URL and a cleaner path to a
safe write layer.

### Phase 4: Intentional write-enabled sessions

Only after read-only testing feels solid:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-mcp-oauth-write.ps1
```

Then reconnect or restart the remote session.

This enables:

- `evaluate_role`
- `record_evaluation`
- `prepare_package`
- `prepare_application`
- `update_application_status`
- `update_inbox_item`

For OAuth-based write sessions, make sure the ChatGPT app requests
`career_ops:write` in addition to the normal identity scopes.

### Hybrid evaluation flow

If Gemini quota is unavailable or you prefer ChatGPT to do the actual reasoning,
use this pattern:

1. ChatGPT reads and evaluates the role in conversation
2. ChatGPT calls `record_evaluation` with the structured result
3. Career-Ops persists the report and tracker row through the normal merge and
   verify flow

### Hybrid package flow

If Gemini package generation is unavailable or you prefer ChatGPT to do the
tailoring itself, use this pattern:

1. ChatGPT reads the JD and the saved evaluation report
2. ChatGPT writes the tailored CV brief JSON and cover-letter JSON in chat
3. ChatGPT calls `prepare_package` with `brief` and `letter`
4. Career-Ops builds the HTML/PDF artifacts and updates tracker PDF status

For an already-evaluated tracker row, prefer `build_quality_package_for_row`.
It lets ChatGPT fetch row/report/CV/profile context and then run the package
through built-in quality checks without repeating a long package prompt.
Those checks now cover both the CV and the cover letter, including role-aware
letter requirements such as clear role mention, direct company reference, and
report-derived theme coverage.

## Suggested First ChatGPT Tests

After the app is connected, use prompts like:

```text
Run show_project_profile and verify_pipeline, then summarize the current repo state.
```

```text
Run scan_safe_shortlist and show me only shortlist and review roles.
```

```text
Run show_applied and tell me which applications need attention.
```

Only after that:

```text
Run prepare_application for this URL and summarize what artifacts were created.
```

## Safety Guidance

For first remote use:

- keep write tools off
- keep scans and evaluations intentional
- do not expose the tunnel longer than needed
- prefer fresh tunnel sessions rather than a permanently exposed endpoint

Longer-term hardening still worth doing:

- OAuth
- tunnel/domain restrictions
- usage monitoring
- maybe a narrower published read-only app plus a separate write-capable private app

## Local Commands

Start MCP server:

```powershell
npm run mcp
```

Smoke test:

```powershell
npm run mcp:smoke
```

Smoke test with token:

```powershell
npm run mcp:smoke -- --token your-secret
```

Smoke test a specific tool:

```powershell
npm run mcp:smoke -- --tool show_tracker --args "{\"status\":\"Applied\",\"limit\":5}"
```

## Sources

- OpenAI Help Center: ChatGPT developer mode and MCP apps says local MCP servers are not currently supported, only remote ones.
- OpenAI MCP docs: custom remote MCP servers connected in ChatGPT can use OAuth flows, and app setup happens through ChatGPT settings with a server URL.
