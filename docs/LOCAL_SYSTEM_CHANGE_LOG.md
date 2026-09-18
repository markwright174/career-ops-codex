# Local System Change Log

This file records local changes that alter how this career-ops repo operates.
It is intentionally tracked as curated, non-sensitive repo communication so it
can live in GitHub rather than only in the local Google Drive workspace.

This is not an application tracker and not a profile history. Use it to make
local operating changes visible before and after upstream updates.

## What To Log

Log changes that affect:

- Persistent workflow rules in `modes/_custom.md`
- Repo structure, local scripts, validation, QA gates, or automations
- Scanner/search behavior, portal/source configuration patterns, or filters
- Update/merge safety procedures
- Tracker/status semantics, packet-generation process, or file naming conventions
- Local Drive/GitHub workflow decisions
- Blacklist/filtering rules or other operating policies

Do not log:

- Individual evaluations, applications, reports, JDs, PDFs, cover letters, or resumes
- Ordinary tracker status updates
- Profile, CV, article-digest, or portfolio-content changes unless they change how the repo operates
- Private details from `cv.md`, `config/profile.yml`, `modes/_profile.md`, `data/`, `reports/`, `jds/`, or `output/`
- Upstream release notes; those belong in the upstream `CHANGELOG.md`

## Maintenance Rule

When making a retained local operational change, add an entry here in the same
turn whenever possible. If a change is exploratory and not kept, no entry is
needed. If the change affects how future agents should behave, put the actual
enforcement rule in the appropriate local instruction file or tracked workflow
doc and summarize it here.

## Entry Format

### YYYY-MM-DD - Short Title

- **Type:** workflow | structure | script | config | update-safety | QA | policy
- **Changed:** What changed.
- **Reason:** Why it changed.
- **Files:** Affected files.
- **Backout:** How to undo or retire the change if needed.

## Entries

### 2026-09-18 - Create Local System Change Log

- **Type:** update-safety, workflow
- **Changed:** Added this tracked local changelog and added a maintenance rule to `modes/_custom.md` so future operational changes are recorded here.
- **Reason:** Mark observed that upstream updates can still obscure or alter local workflow changes, even after careful diff review. This gives us a durable audit trail for repo behavior changes.
- **Files:** `docs/LOCAL_SYSTEM_CHANGE_LOG.md`, `modes/_custom.md`
- **Backout:** Remove the changelog maintenance rule from `modes/_custom.md`; keep or delete this file depending on whether historical notes are still useful.

### 2026-09-18 - Clarify GitHub-First Operating Boundary

- **Type:** workflow, update-safety
- **Changed:** Clarified that stable instructions, workflow notes, and repo communication should live in GitHub-tracked docs, while Google Drive-backed files remain for profile data, application artifacts, generated/private storage, and sensitive source material.
- **Reason:** Mark wants agents to avoid repeatedly relying on slow or partially synced Google Drive files for routine instruction/context loading, while preserving the privacy boundary for candidate and application data.
- **Files:** `docs/LOCAL_SYSTEM_CHANGE_LOG.md`, `docs/DRIVE_GITHUB_WORKFLOW.md`, `modes/_custom.md`
- **Backout:** Revert the GitHub-first wording in `docs/DRIVE_GITHUB_WORKFLOW.md` and remove or revise this entry.
