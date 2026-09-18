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

### 2026-09-18 - Repair Fork GitHub Actions Hygiene

- **Type:** update-safety, config, structure
- **Changed:** Converted tracked skill entrypoint files from malformed symlink entries to regular files, added fork-appropriate Release Please configuration, added `.release-please-manifest.json`, gated Release Please so push-triggered release automation runs only on the upstream repository, and removed ignored Google Drive `desktop.ini` metadata files from the workspace and `.git` internals.
- **Reason:** GitHub Actions failed after a documentation push because Linux checkout could not materialize malformed skill symlinks, Release Please had a workflow without its required manifest/config files, and the release workflow is upstream publishing machinery that fails noisily in Mark's fork. Google Drive metadata files also caused local Git tag warnings and broke test fixture copying.
- **Files:** `.antigravitycli/skills/career-ops/SKILL.md`, `.claude/skills/career-ops/SKILL.md`, `.cursor/skills/career-ops/SKILL.md`, `.grok/skills/career-ops/SKILL.md`, `.kimi/skills/career-ops/SKILL.md`, `.opencode/skills/career-ops/SKILL.md`, `.qwen/skills/career-ops/SKILL.md`, `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json`, `docs/LOCAL_SYSTEM_CHANGE_LOG.md`
- **Backout:** Restore the prior symlink entries, remove the release config/manifest, and remove the Release Please repository guard, though that will reintroduce the observed checkout and Release Please failures.

### 2026-09-18 - Apply 1.33 Update With Local Runtime Clone

- **Type:** update-safety, structure
- **Changed:** Applied the upstream 1.33 system update while preserving local fork repairs and tracked workflow docs. Created a local runtime clone at `C:\Users\dntpa\career-ops-runtime` with GitHub remotes and a local-only `.career-ops-data` marker pointing back to the Drive-backed career-ops data folder.
- **Reason:** The updater now preserves locally changed system paths, but the Drive-backed checkout corrupted `node_modules` during dependency installation by leaving package files at 0 bytes. Running code and dependencies from a local disk clone while reading user data from Drive matches the GitHub-first / Drive-private boundary and avoids Google Drive write failures for npm packages.
- **Files:** `VERSION`, `CHANGELOG.md`, system-layer files updated by upstream 1.33, `.github/workflows/release.yml`, CLI skill entrypoint files, `docs/DRIVE_GITHUB_WORKFLOW.md`, `docs/LOCAL_SYSTEM_CHANGE_LOG.md`, local-only `C:\Users\dntpa\career-ops-runtime\.career-ops-data`
- **Backout:** Use the pre-update branch `codex/pre-update-2026-09-18-125-to-133` or `node update-system.mjs rollback` from the updated checkout to undo the upstream update. Delete `C:\Users\dntpa\career-ops-runtime` if returning to the Drive-backed checkout for execution.
