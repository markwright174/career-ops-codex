# ChatGPT Handoff

This document is the clean handoff package for moving day-to-day repo operations to ChatGPT.

## What To Give ChatGPT

Give ChatGPT:

1. The full repository
2. This file: [docs/CHATGPT_HANDOFF.md](C:/Users/dntpa/career-ops/docs/CHATGPT_HANDOFF.md)
3. The project instructions in:
   - [AGENTS.md](C:/Users/dntpa/career-ops/AGENTS.md)
   - [CLAUDE.md](C:/Users/dntpa/career-ops/CLAUDE.md)
   - [docs/CODEX.md](C:/Users/dntpa/career-ops/docs/CODEX.md)
4. The frontend command guide:
   - [docs/CHATGPT_FRONTEND.md](C:/Users/dntpa/career-ops/docs/CHATGPT_FRONTEND.md)

If you cannot hand over the full repo immediately, at minimum provide:

- [config/profile.yml](C:/Users/dntpa/career-ops/config/profile.yml)
- [modes/_profile.md](C:/Users/dntpa/career-ops/modes/_profile.md)
- [cv.md](C:/Users/dntpa/career-ops/cv.md)
- [article-digest.md](C:/Users/dntpa/career-ops/article-digest.md)
- [portals.yml](C:/Users/dntpa/career-ops/portals.yml)
- [data/applications.md](C:/Users/dntpa/career-ops/data/applications.md)
- [reports/](C:/Users/dntpa/career-ops/reports)
- [output/](C:/Users/dntpa/career-ops/output)

## Paste This Into ChatGPT

```text
You are taking over operation of my Career-Ops repo.

Before doing anything else:
1. Read AGENTS.md
2. Read CLAUDE.md
3. Read docs/CODEX.md
4. Treat those files as the operating rules for this repo

Important constraints:
- Reuse the existing modes, scripts, templates, tracker flow, and scanner logic
- Do not create parallel logic or parallel trackers
- Store user-specific changes only in config/profile.yml, modes/_profile.md, article-digest.md, cv.md, or portals.yml
- Never submit applications on my behalf
- For new tracker rows, use the TSV addition flow and merge-tracker.mjs
- Keep data/applications.md canonical and run verify-pipeline.mjs after meaningful pipeline edits

Please start by reading:
- docs/CHATGPT_HANDOFF.md
- config/profile.yml
- modes/_profile.md
- cv.md
- article-digest.md
- data/applications.md

Then summarize:
1. My current target lanes
2. My current search/scoring rules
3. The current state of the tracker
4. Any immediate repo issues or inconsistencies you see

After that, operate as my job-search agent inside this repo.
```

## Non-Negotiable Repo Rules

ChatGPT should follow these rules exactly:

- Reuse the existing Career-Ops architecture
- Do not create a new tracker, scanner, prompt system, or resume pipeline
- Never put user-specific preferences into shared system files like `modes/_shared.md`
- Never submit an application for the user
- Use the tracked TSV merge flow for new applications:
  - write TSV to `batch/tracker-additions/`
  - run `node merge-tracker.mjs`
- Use `node verify-pipeline.mjs` to confirm pipeline health after meaningful changes
- Treat `cv.md` and `config/profile.yml` as core source-of-truth files

## Current User Profile

Source of truth:
- [config/profile.yml](C:/Users/dntpa/career-ops/config/profile.yml)
- [modes/_profile.md](C:/Users/dntpa/career-ops/modes/_profile.md)
- [cv.md](C:/Users/dntpa/career-ops/cv.md)
- [article-digest.md](C:/Users/dntpa/career-ops/article-digest.md)

Short version:

- Name: Mark Wright
- Location: Houston, TX
- Work authorization: no sponsorship needed
- Compensation target: `$120K-$250K`
- Minimum: `$100K`
- Remote preferred

Primary role lanes:

- Instructional Design Manager
- Senior Learning Experience Designer
- Senior Instructional Designer

Secondary lanes:

- Customer Education Manager / Lead
- Technical Learning Design and Development
- Learning and Development Manager

Additional lane now intentionally included:

- Learning and Organizational Development
- Leadership Development
- Talent Development

Important strengths:

- Complex-content translation into practical learning
- Leadership plus hands-on execution
- Agile instructional-design team leadership
- LMS-supported program delivery
- Accessibility and universal design
- Faculty development and educator enablement
- Healthcare-education curriculum leadership
- K-12 educator credibility
- Pragmatic AI-supported learning workflow

Confirmed profile signals added during operations:

- Degreed nursing-program curriculum design and maintenance across LVN, ADN, and BSN pathways
- Intermediate Adobe Captivate experience
- Working knowledge of xAPI / Tin Can API
- 2 years teaching PreK-3 in Prague
- 3 years teaching PreK-3 in Houston ISD
- K-5 afterschool-program leadership
- Open to strong individual-contributor roles if fit and compensation are compelling
- Open to some near-floor roles when fit is unusually strong

## Current Search Logic

Primary search/scoring behavior lives in:

- [portals.yml](C:/Users/dntpa/career-ops/portals.yml)
- [scan.mjs](C:/Users/dntpa/career-ops/scan.mjs)

Important current state:

- The scanner now runs both:
  - direct ATS/API tracked-company scans
  - enabled `search_queries`
- This was an important fix. Earlier, `search_queries` were passive config. They are now executable.

Supported direct ATS/feed paths currently include:

- Greenhouse
- Ashby
- Lever
- Workday
- BambooHR
- SmartRecruiters
- iCIMS
- Teamtailor
- Workable
- Breezy

Important limitation:

- Oracle Cloud ATS is still not a native scanner integration
- Oracle is handled through tracked search visibility rather than a native ATS parser
- This is intentional for now

Recent search broadening included:

- customer education design
- education product / curriculum product roles
- learning services / custom learning / agency-style providers
- leadership development / organizational development / talent development

Recent search narrowing included:

- pushing down generic revenue enablement / sales-heavy roles
- excluding obvious HR generalist / talent acquisition noise

## Current Workflow

The normal operating flow should be:

1. User gives a job URL or JD
2. Evaluate using the existing Career-Ops mode/logic
3. Write report to `reports/`
4. Write TSV tracker addition to `batch/tracker-additions/`
5. Run `node merge-tracker.mjs`
6. Run `node verify-pipeline.mjs`
7. If the user chooses to apply:
   - generate tailored resume and cover letter through the existing pipeline
   - never submit on the user’s behalf
   - update tracker status only after user confirms submission

## Quick-Apply Artifacts

These were intentionally created as broad default materials for fast applications:

- Resume PDF: [output/cv-mark-wright.pdf](C:/Users/dntpa/career-ops/output/cv-mark-wright.pdf)
- Resume HTML: [output/cv-mark-wright.html](C:/Users/dntpa/career-ops/output/cv-mark-wright.html)
- Cover letter PDF: [output/cover-letter-mark-wright.pdf](C:/Users/dntpa/career-ops/output/cover-letter-mark-wright.pdf)
- Cover letter HTML: [output/cover-letter-mark-wright.html](C:/Users/dntpa/career-ops/output/cover-letter-mark-wright.html)
- Cover letter JSON source: [output/cover-letter-mark-wright.json](C:/Users/dntpa/career-ops/output/cover-letter-mark-wright.json)

Notes:

- `cv-mark-wright.pdf` is now a true refreshed general-use resume
- It was previously an outdated tailored alias and was corrected
- The quick-apply cover letter is intentionally broad and one page
- Tailored packages should still be preferred for roles the user cares about

## Tracker And Reporting

Source of truth:

- [data/applications.md](C:/Users/dntpa/career-ops/data/applications.md)

Recent high-value records are at the top of the tracker.

ChatGPT should always:

- trust the tracker over memory
- trust individual report files for nuance
- update statuses carefully
- avoid creating duplicate rows

Useful companion files:

- [data/scan-history.tsv](C:/Users/dntpa/career-ops/data/scan-history.tsv)
- [data/pipeline.md](C:/Users/dntpa/career-ops/data/pipeline.md)

## Current Operational Reality

What has been learned from recent operation:

- The market is often quiet even when the scanner is healthy
- Good roles still sometimes appear through manual broad discovery
- Healthcare-education adjacency is a real strength
- Pharma clinical-operations learning is still a stretch boundary
- Customer-education roles can be worth pursuing when they stay close to true learning design
- Leadership development / organizational development roles should now be considered part of the scan/eval surface when they fit the compensation and scope

## Recommended First Steps For ChatGPT

When taking over, ChatGPT should do this first:

1. Read the operating instructions and user profile files
2. Read the current top of [data/applications.md](C:/Users/dntpa/career-ops/data/applications.md)
3. Read the last 10-15 recent reports
4. Run:
   - `node update-system.mjs check`
   - `node verify-pipeline.mjs`
5. Summarize:
   - target roles
   - current scanner behavior
   - current high-priority applications
   - any data inconsistencies

## What You Do Not Need To Handwrite Separately

You do not need to produce a separate “memory file” if ChatGPT has access to this repo and reads:

- [docs/CHATGPT_HANDOFF.md](C:/Users/dntpa/career-ops/docs/CHATGPT_HANDOFF.md)
- [config/profile.yml](C:/Users/dntpa/career-ops/config/profile.yml)
- [modes/_profile.md](C:/Users/dntpa/career-ops/modes/_profile.md)
- [cv.md](C:/Users/dntpa/career-ops/cv.md)
- [article-digest.md](C:/Users/dntpa/career-ops/article-digest.md)
- [data/applications.md](C:/Users/dntpa/career-ops/data/applications.md)

That is enough to operate effectively if ChatGPT actually follows the repo’s instructions.

## Better Frontend Mode

If ChatGPT has access to this repo through a terminal or workspace tool, prefer
the explicit command surface:

```bash
npm run chat -- help
```

This returns the supported actions for scan, inbox, tracker, quick-apply,
verification, patterns, and liveness. It is a better default than asking
ChatGPT to infer workflow from raw files every turn.

## Optional Extra

If you want an even smoother handoff, tell ChatGPT one sentence like this:

> “Assume the repo state is authoritative, but call out any inconsistencies you find before changing workflow logic.”

That tends to produce safer behavior during takeover.
