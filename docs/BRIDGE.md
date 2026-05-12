# Bridge Mode

This repo now includes a local bridge layer for exposing Career-Ops actions to
an external frontend such as ChatGPT through a narrow JSON API.

## Purpose

The bridge exists so a conversational frontend can operate the repo through a
small set of explicit actions instead of:
- inventing a parallel workflow
- reading arbitrary files ad hoc
- running arbitrary shell commands

## Local Server

Start the local bridge:

```bash
set CAREER_OPS_BRIDGE_TOKEN=replace-with-a-long-random-secret
npm run bridge
```

Default endpoint:

```text
http://127.0.0.1:8787/action
```

Health endpoint:

```text
http://127.0.0.1:8787/health
```

## Security

The bridge is now locked down by default:

- binds to `127.0.0.1` unless you explicitly override `CAREER_OPS_BRIDGE_HOST`
- refuses to start without `CAREER_OPS_BRIDGE_TOKEN`
- rate-limits requests in memory
- hides raw child-process stdout/stderr from remote callers unless debug mode is enabled
- keeps write actions disabled unless you explicitly opt in

Required bearer token:

```bash
set CAREER_OPS_BRIDGE_TOKEN=your-secret-token
npm run bridge
```

Then send:

```text
Authorization: Bearer your-secret-token
```

Write actions stay disabled until you explicitly allow them:

```bash
set CAREER_OPS_BRIDGE_ALLOW_WRITE=1
```

Use that only when you are ready for ChatGPT or another frontend to trigger
evaluation, package generation, and tracker-writing behavior.

The bridge only allows a fixed whitelist of actions and does **not** allow
arbitrary shell commands.

Optional debug mode for local troubleshooting:

```bash
set CAREER_OPS_BRIDGE_DEBUG=1
```

This re-enables raw stdout/stderr in error responses, so it should stay off for
any tunneled or remote-access setup.

## Payload Shape

POST `/action`

```json
{
  "action": "scan-safe",
  "flags": {
    "shortlist": true
  }
}
```

The bridge converts this into the equivalent `chat-ops` action and returns the
JSON result.

## Allowed Actions

Read/triage:
- `help`
- `scan`
- `scan-safe`
- `inbox`
- `shortlist`
- `tracker`
- `applied`
- `evaluated`
- `verify`
- `sync-check`
- `project-profile`
- `patterns`
- `quick-apply`
- `reports`
- `liveness`

Write/evaluate/package:
- `evaluate`
- `package`
- `apply-prep`

If `CAREER_OPS_BRIDGE_ALLOW_WRITE` is not set to `1`, write actions return
`403`.

## Action Semantics

### `evaluate`

Gemini-backed evaluation pipeline:
- extracts or reads a JD
- runs evaluation
- saves report
- writes tracker TSV
- merges tracker additions
- verifies pipeline

Example flags:

```json
{
  "action": "evaluate",
  "flags": {
    "url": "https://example.com/job/123"
  }
}
```

### `package`

Generates tailored CV + cover letter package from a JD and optional report
context.

Example flags:

```json
{
  "action": "package",
  "flags": {
    "jd-file": "output/jd-example.txt",
    "report": "reports/074-oracle-2026-05-07.md",
    "company": "Oracle",
    "role": "Instructional Designer & Learning Developer"
  }
}
```

### `apply-prep`

Runs evaluation and package generation in one step.

Example flags:

```json
{
  "action": "apply-prep",
  "flags": {
    "url": "https://example.com/job/123"
  }
}
```

## Logging

Actions are logged to:

```text
data/chat-actions.ndjson
```

This creates an audit trail for both frontend reads and repo-changing actions.

## Recommended Architecture

1. ChatGPT frontend
2. MCP or connector wrapper
3. Local HTTPS tunnel
4. `bridge-server.mjs`
5. `chat-ops.mjs`
6. Existing Career-Ops scripts and files

This keeps the repo as the backend and the chat product as the conversation
layer.

## Public Exposure Guidance

Do not expose the bridge publicly in its default development shape. Before
putting a tunnel in front of it, keep these guardrails in place:

1. strong `CAREER_OPS_BRIDGE_TOKEN`
2. localhost binding unless the tunnel specifically needs another host
3. write actions off unless you actively need them
4. MCP wrapper or named-tool layer instead of a generic public endpoint

For personal use, the safer pattern is:

1. run the bridge locally
2. expose it only through an authenticated HTTPS tunnel
3. put an MCP wrapper in front of the bridge
4. keep write actions disabled except during intentional apply-prep sessions
