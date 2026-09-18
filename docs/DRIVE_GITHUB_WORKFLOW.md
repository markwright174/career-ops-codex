# Google Drive and GitHub Working-Memory Workflow

Use GitHub as the main working-memory and repo-communication layer for stable, non-sensitive, curated project knowledge. Use the local Google Drive workspace for profile data, application artifacts, private/source storage, generated artifacts, and materials that should stay gitignored.

This keeps routine agent work fast and predictable while preserving the privacy boundary that career-ops depends on.

## Why

Google Drive-backed folders can be slow to enumerate, slow to open, and vulnerable to partial sync while an agent is reading or writing. Git-tracked text files are usually faster, smaller, versioned, and easier to review.

At the same time, many career-ops files are intentionally private or generated. Do not push private application records, raw job descriptions, tailored PDFs, source exports, personal profile details, transcripts, proprietary course assets, or other sensitive content just to make agent work easier.

## Storage Model

| Layer | Use For | Examples |
|---|---|---|
| GitHub / tracked repo | Stable, curated, non-sensitive working knowledge | Process rules, design decisions, source indexes, safe summaries, reusable project notes, templates, scripts |
| Local Google Drive / gitignored | Private, sensitive, large, generated, or source material | CV/profile details, applications tracker, reports, JDs, PDFs, raw exports, meeting transcripts, source zips, proprietary course materials |

## What To Track

Track concise files that help future agents work without repeatedly scanning Drive:

- Source inventories that describe what exists without exposing protected content.
- Safe summaries of large/private materials.
- Search/scanning decisions and workflow notes.
- Build packets that explain how to reproduce work while pointing to ignored local inputs.
- Architecture decisions and process rules.
- Templates and scripts that do not contain private data.

Keep tracked summaries factual and minimal. A summary should help an agent decide where to look next, not reproduce the private source.

## What To Keep Private

Keep these local and gitignored:

- `cv.md`, `config/profile.yml`, `modes/_profile.md`, and other personal profile files.
- `data/`, including applications, pipeline, scan history, contacts, and outcome logs.
- `reports/`, `jds/`, and `output/`.
- Raw source material, transcripts, exports, screenshots, and generated PDFs.
- Anything FERPA-sensitive, employer-sensitive, proprietary, or personally identifying beyond what is already intentionally public.

## Agent Workflow

Before doing broad file discovery in a Google Drive-backed workspace:

1. Read tracked docs and indexes first.
2. Use `rg` with narrow patterns instead of broad recursive listing.
3. Open ignored/private source files only when the task requires their contents.
4. When a private source is useful long-term, create or update a tracked safe summary instead of tracking the source.
5. Do not copy private/source material into tracked docs.
6. Commit only curated, non-sensitive files.

## Local Runtime Clone

Prefer running scripts and installing dependencies from `C:\Users\dntpa\career-ops-runtime`. That clone keeps code and `node_modules` on local disk, with a local-only `.career-ops-data` marker pointing back to the Drive-backed career-ops folder for private user data.

The Drive-backed checkout remains the private data workspace and can still be used for files that intentionally live there. Avoid installing or repairing `node_modules` inside the Drive checkout unless the runtime clone is unavailable.

## Default Operating Boundary

For routine career-ops work, operate from the GitHub repo and its tracked text
files first. Treat tracked docs, scripts, templates, and safe indexes as the
normal instruction and coordination layer.

Use Google Drive-backed or gitignored files only when the task requires private
candidate data, application records, generated artifacts, raw source materials,
or other sensitive inputs. Do not broaden Drive searches just to recover
instructions that should be stored in the repo.

Record retained operational changes in `docs/LOCAL_SYSTEM_CHANGE_LOG.md`.

When working with career-ops specifically:

- Use tracked docs for stable process knowledge.
- Use ignored user-layer files for personal facts and application artifacts.
- Keep JDs and generated application materials local unless Mark explicitly asks to publish or share them.
- Treat the website/portfolio as public, but do not infer unsupported claims from it unless the content has been explicitly added to an in-scope source file.

## Review Gate Before Commit

Before committing:

1. Run `git status --short`.
2. Inspect every file to be staged with `git diff --cached` or `git diff -- <file>`.
3. Confirm no ignored private material was force-added.
4. Prefer committing only tracked process docs, scripts, templates, or curated indexes.
5. Leave generated/private artifacts untracked unless there is an explicit reason and privacy review.
