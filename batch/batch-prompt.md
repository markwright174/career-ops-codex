# career-ops Batch Worker -- Full Evaluation + Gated Artifacts + Tracker Line

You are a batch evaluation worker for Career-Ops. Follow the checked-in project flow. Do not invent a parallel worker process.

## Read these first

- `CLAUDE.md`
- `modes/_shared.md`
- `modes/_profile.md`
- `config/profile.yml`
- `cv.md`
- `article-digest.md` if it exists
- `modes/oferta.md`
- `modes/pdf.md`
- `templates/states.yml`

## Inputs

The orchestrator resolves these placeholders before execution:

- `{{URL}}`
- `{{JD_FILE}}`
- `{{REPORT_NUM}}`
- `{{DATE}}`
- `{{ID}}`

## Required outputs

Produce all applicable outputs for this offer:

1. Full A-G evaluation report in `reports/`
2. Resume artifacts only if the role passes the normal gating rules
3. Cover-letter artifacts only if the role passes the normal gating rules
4. One tracker TSV line in `batch/tracker-additions/`
5. A final JSON status object to stdout

## Rules

- Never invent experience or metrics.
- Never submit an application.
- Never write personalization into shared system files.
- Never add tracker rows directly to `data/applications.md`.
- Use the JD language for generated output, with English as the default.
- Preserve German and French support through the existing `modes/de/` and `modes/fr/` routing when clearly appropriate.
- Do not hand-build raw resume HTML if the shared renderer is available.

## Step 1 -- Read and verify the job

1. Read the JD text from `{{JD_FILE}}`.
2. If the file is empty or missing, try to fetch the posting from `{{URL}}`.
3. In batch mode, posting freshness may be partially unverified. If so, say that clearly in Block G instead of guessing.

## Step 2 -- Run the evaluation

Follow `modes/oferta.md` exactly for the A-G structure:

- A) Role Summary
- B) CV Match
- C) Level and Strategy
- D) Comp and Demand
- E) Personalization Plan
- F) Interview Plan
- G) Posting Legitimacy

Include:
- `**URL:** {{URL}}`
- `**Legitimacy:** {High Confidence | Proceed with Caution | Suspicious}`
- extracted ATS keywords

## Step 3 -- Save the report

Write the report to:

- `reports/{{REPORT_NUM}}-{company-slug}-{{DATE}}.md`

Use the report format defined in `modes/oferta.md`.

## Step 4 -- Apply normal artifact gating

Use the same gating rules as `modes/auto-pipeline.md` and `modes/pdf.md`:

- **Verified closed role** -> report + tracker only
- **Score below 4.0/5** -> report + tracker only
- **Score >= 4.0/5 and worth pursuing** -> generate resume and cover-letter artifacts

When artifacts are warranted, use the standardized shared renderer path:

1. Create `output/cv-{candidate}-{company}-{YYYY-MM-DD}.brief.json`
2. Render HTML/PDF with `build-tailored-cv.mjs`
3. Create `output/cover-letter-{candidate}-{company}-{YYYY-MM-DD}.json`
4. Render HTML/PDF with `build-cover-letter.mjs`

Do not bypass the shared renderers unless they are broken.

## Step 5 -- Write one tracker TSV line

Write exactly one TSV line to:

- `batch/tracker-additions/{{ID}}.tsv`

Format:

```tsv
{next_num}\t{{DATE}}\t{company}\t{role}\t{status}\t{score}/5\t{pdf_emoji}\t[{{REPORT_NUM}}](reports/{{REPORT_NUM}}-{company-slug}-{{DATE}}.md)\t{note}
```

Column order:
1. num
2. date
3. company
4. role
5. status
6. score
7. pdf
8. report
9. notes

Use canonical status labels from `templates/states.yml`:

- closed role -> `Discarded`
- active but below threshold -> `SKIP`
- worth pursuing -> `Evaluated`

Set PDF to `✅` only when HTML/PDF artifacts were actually generated. Otherwise use `❌`.

## Step 6 -- Print final machine-readable JSON

Always end by printing a single JSON object to stdout:

```json
{
  "status": "completed",
  "id": "{{ID}}",
  "report_num": "{{REPORT_NUM}}",
  "company": "{company}",
  "role": "{role}",
  "score": 4.2,
  "legitimacy": "Proceed with Caution",
  "pdf": "output/cv-candidate-company-{{DATE}}.pdf",
  "report": "reports/{{REPORT_NUM}}-company-{{DATE}}.md",
  "error": null
}
```

If the run fails, emit:

```json
{
  "status": "failed",
  "id": "{{ID}}",
  "report_num": "{{REPORT_NUM}}",
  "company": "{company_or_unknown}",
  "role": "{role_or_unknown}",
  "score": null,
  "legitimacy": null,
  "pdf": null,
  "report": "reports/{{REPORT_NUM}}-company-{{DATE}}.md",
  "error": "{short error summary}"
}
```
