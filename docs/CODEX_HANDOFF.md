# Codex Handoff

This note is the short operational handoff for the next Codex session.

## Current Shape

Career-Ops now has a stable MCP-based ChatGPT frontend with:

- a local MCP server
- an OAuth-capable auth layer
- a reverse-proxy front door
- a persistent public entrypoint
- broad structured reads
- narrow bounded writes

The important product goal is unchanged: ChatGPT should act like a safe
frontend for the repo, not like a shell user with git access.

## Working Pieces

- `chat-ops.mjs` provides the repo command surface
- `mcp/server.mjs` serves the MCP tool layer
- `mcp/oauth.mjs` validates OAuth/OIDC tokens for the MCP server
- `mcp/reset.ps1` starts or resets the public MCP + tunnel from the shared local config

## Read Surface

High-signal summary tools:

- `show_repo_summary`
- `show_attention_report`
- `show_project_profile`
- `show_tracker`
- `show_applied`
- `show_evaluated`
- `show_reports`
- `show_quick_apply`
- `verify_pipeline`
- `check_liveness`

Broader structured repo reads:

- `show_base_cv`
- `show_cv_chronology`
- `show_profile_context`
- `show_tracker_row`
- `show_report`
- `show_pipeline_item`
- `list_repo_dir`
- `read_repo_file`
- `search_repo_text`

## Write Surface

Bounded status/update tools:

- `update_application_status`
- `update_inbox_item`
- `mark_application_applied`
- `mark_inbox_stale`

Hybrid write flows:

- `record_evaluation`
- `build_package_from_json`

Legacy Gemini-backed write paths still exist in the repo, but the preferred
frontend direction is hybrid:

- ChatGPT does the reasoning
- Career-Ops persists the result through the existing repo flow

## What Was Solved

### Stable frontend

The original quick-tunnel churn problem is solved. The frontend now uses a
stable MCP endpoint and no longer depends on rebuilding the ChatGPT app after
every backend restart.

### OAuth

The MCP server supports OAuth and validates tokens through standard OIDC
discovery + JWKS. Read and write access can be separated cleanly.

### Hybrid evaluation

`record_evaluation` lets ChatGPT evaluate a role in conversation and then:

- write a report to `reports/`
- write a TSV addition to `batch/tracker-additions/`
- run `merge-tracker.mjs`
- run `verify-pipeline.mjs`

This path has already been tested successfully against a real row.

### Hybrid packaging

`build_package_from_json` lets ChatGPT author builder-ready package JSON while
the repo:

- writes the JSON artifacts to `output/`
- runs the existing CV and cover-letter builders
- generates PDFs
- updates tracker PDF state
- runs `verify-pipeline.mjs`

Validation was tightened so the tool now rejects:

- planning metadata instead of render-ready fields
- synthetic fake experience entries
- missing cover-letter date
- duplicated-signoff style closings

### Repo-noise cleanup

Recent cleanup reduced churn from normal frontend use:

- `data/chat-actions.ndjson` is ignored
- generated project-profile output no longer rewrites just because the date line changed
- merged TSV audit artifacts remain intentionally trackable

## Current Quality Notes

The frontend is now good enough for day-to-day use, but package quality still
depends on prompt quality. The most common weak point is conservative tailoring
that leaves too much baseline resume text untouched.
Package responses now carry `quality_gate` and `completion_status`, so treat a
successful build as only "built" unless the response says the package is
complete or Chat has explicitly verified it.

When rebuilding packages, prefer prompts that push ChatGPT to:

- tailor through real work-history bullet refinement
- avoid synthetic or umbrella experience entries
- use projects only when they add credible evidence
- keep AI/tool language outcome-focused rather than brand-name heavy

## Operating Rules

- Reuse existing modes, scripts, templates, tracker flow, and scanner logic
- Never create a parallel tracker or workflow
- Never submit applications on the user's behalf
- For new tracker rows, use TSV addition flow plus `merge-tracker.mjs`
- Run `verify-pipeline.mjs` after meaningful pipeline edits

## Practical Next Moves

If resuming active development, the most likely good next tasks are:

1. keep using the broadened read surface and only add tools if real friction shows up
2. refine package prompts and builders for sharper tailoring quality
3. continue keeping remote writes narrow even if reads remain broad
4. sanity-check public-push hygiene before pushing repo changes upstream

## Private Infrastructure Reminder

Machine-local deployment details, credentials, tunnel configuration, and auth
provider wiring should stay in local environment variables, local config files,
or private notes rather than this repo.
