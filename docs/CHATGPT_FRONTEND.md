# ChatGPT Frontend Mode

This repo now includes a thin command surface for ChatGPT or any other
conversational frontend that should operate the repo without re-deriving the
workflow from raw files every turn.

For bridge/MCP-oriented setups, see [docs/BRIDGE.md](/G:/My%20Drive/career-ops/docs/BRIDGE.md).

## Goal

Use ChatGPT as the conversation layer.

Use the repo as the operational backend.

That means:
- ChatGPT should call `chat-ops.mjs` for routine state reads and safe actions
- ChatGPT should summarize the command output for the user
- ChatGPT should NOT invent a parallel tracker, scan loop, or resume pipeline

## Entry Point

Use:

```bash
npm run chat -- <action> [flags]
```

Equivalent:

```bash
node chat-ops.mjs <action> [flags]
```

All actions return structured JSON to stdout.

## Supported Actions

### `help`

Show the available action set.

```bash
npm run chat -- help
```

### `scan`

Run the existing scanner and return a compact summary plus any newly added inbox
items.

```bash
npm run chat -- scan
npm run chat -- scan --company WGU
```

### `scan-safe`

Run the scanner, then Playwright-liveness-check newly added URLs. This is the
best default for broad scans when stale ATS shells are common.

```bash
npm run chat -- scan-safe
npm run chat -- scan-safe --mark-expired
npm run chat -- scan-safe --shortlist
```

If `--mark-expired` is present, expired new inbox items are converted from
`- [ ]` to `- [!]` in `data/pipeline.md` with a short note.

If `--shortlist` is present, the command also returns heuristic triage for the
newly added items so ChatGPT can default to stronger candidates.

### `inbox`

Show pending and issue items from `data/pipeline.md`.

```bash
npm run chat -- inbox
```

### `shortlist`

Heuristic triage for inbox items. Uses title fit, level signals, and
tracker/scan-history overlap to bucket roles into:
- `shortlist`
- `review`
- `reject`

```bash
npm run chat -- shortlist
npm run chat -- shortlist --include-issues
```

### `tracker`

Show a compact tracker summary. Supports filtering by status and score.

```bash
npm run chat -- tracker
npm run chat -- tracker --status Applied --limit 8
npm run chat -- tracker --status Evaluated --min-score 4.0
```

### `applied`

Alias for:

```bash
npm run chat -- tracker --status Applied
```

### `evaluated`

Alias for:

```bash
npm run chat -- tracker --status Evaluated
```

### `verify`

Run pipeline verification and return pass/fail plus captured output.

```bash
npm run chat -- verify
```

### `sync-check`

Run the CV/profile consistency check.

```bash
npm run chat -- sync-check
```

### `project-profile`

Generate the markdown profile mirror intended for ChatGPT Projects when direct
YAML files are inconvenient to attach as sources.

```bash
npm run chat -- project-profile
npm run project-profile
```

### `patterns`

Return structured output from `analyze-patterns.mjs`.

```bash
npm run chat -- patterns
```

### `evaluate`

Run the Gemini-backed evaluation pipeline for a JD URL or JD file. This is a
repo-changing action: it creates a report and tracker update through the normal
TSV merge flow.

```bash
npm run chat -- evaluate --url https://example.com/job/123
npm run chat -- evaluate --jd-file output/jd-example.txt
```

### `package`

Generate a tailored CV + cover letter package from a JD and optional report
context.

```bash
npm run chat -- package --jd-file output/jd-example.txt --report reports/074-oracle-2026-05-07.md --company Oracle --role "Instructional Designer & Learning Developer"
```

### `apply-prep`

Run evaluation and package generation in one step.

```bash
npm run chat -- apply-prep --url https://example.com/job/123
```

### `quick-apply`

Return the current general-use resume and cover-letter artifact paths from
`output/`.

```bash
npm run chat -- quick-apply
```

### `reports`

Show recent reports.

```bash
npm run chat -- reports
npm run chat -- reports --limit 5
```

### `liveness`

Run Playwright liveness checks against one or more URLs.

```bash
npm run chat -- liveness https://example.com/job/123
```

## Recommended ChatGPT Behavior

For normal operation, ChatGPT should prefer these actions instead of reading the
repo raw unless deeper context is needed:

1. `scan-safe` for broad scans
2. `shortlist` to see what actually looks worth escalating
3. `inbox` to inspect the raw pending and issue items
4. `tracker --status Applied` for active applications
5. `tracker --status Evaluated` for evaluated-but-undecided roles
6. `quick-apply` when the user asks for the current default CV or cover letter
7. `project-profile` when the user needs the current attachable profile mirror
8. `verify` after meaningful pipeline edits

## Suggested Prompt For ChatGPT

Paste this into ChatGPT if you want it to operate as the frontend:

```text
You are the conversational frontend for my career-ops repo.

Do not invent a parallel workflow.
Do not reason from memory when the repo can answer directly.

For routine repo actions, use:
- `npm run chat -- scan-safe`
- `npm run chat -- shortlist`
- `npm run chat -- inbox`
- `npm run chat -- tracker --status Applied`
- `npm run chat -- tracker --status Evaluated`
- `npm run chat -- quick-apply`
- `npm run chat -- project-profile`
- `npm run chat -- verify`
- `npm run chat -- patterns`
- `npm run chat -- liveness <url>`

When you need repo state, call `npm run chat -- <action>` first and summarize the JSON result.
Only fall back to raw file reading when the structured command output is not enough.

Keep all writes inside the existing repo flow.
Never create a second tracker, scanner, or resume pipeline.
Never submit applications on my behalf.
```

## Boundaries

This command layer is intentionally thin.

It is good for:
- scans
- tracker summaries
- inbox inspection
- liveness checks
- quick-apply artifact lookup
- verification
- pattern summaries
- Gemini-backed evaluation orchestration
- package generation orchestration

It does NOT replace the full AI evaluation pipeline for:
- running application strategy autonomously

Those still need an agent that can operate the repo and reason carefully over
the existing modes, profile, CV, and reports.
