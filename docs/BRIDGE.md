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

Optional bearer token:

```bash
set CAREER_OPS_BRIDGE_TOKEN=your-secret-token
npm run bridge
```

Then send:

```text
Authorization: Bearer your-secret-token
```

The bridge only allows a fixed whitelist of actions.

It does **not** allow arbitrary shell commands.

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
