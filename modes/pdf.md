# Mode: pdf -- ATS-Optimized Resume HTML + PDF

Use this mode when the user explicitly asks for resume/PDF generation, or when `auto-pipeline` reaches the resume step.

## Default gating

In `auto-pipeline`, do **not** generate resume artifacts by default when:

- the role is verified closed, or
- the score is below `4.0/5`

In those cases, the default output is:
- full evaluation report
- tracker update with the correct canonical status

Only run this mode for a closed or low-fit role if the user explicitly asks for resume artifacts anyway.

## Goal

Produce a tailored application package through one repeatable path:

1. Read canonical source data from `cv.md`, `config/profile.yml`, and optionally `article-digest.md`
2. Create a structured tailored brief in `output/`
3. Render HTML from `templates/cv-template.html` with `build-tailored-cv.mjs`
4. Generate the PDF with `generate-pdf.mjs`
5. For strong, application-worthy roles, also create a tailored cover letter JSON/HTML/PDF package
6. Update tracker PDF status only if the role is already registered

The AI should tailor the content. The script should assemble the HTML. Do not hand-build raw HTML unless the renderer itself is broken.

## Standard pipeline

1. Read `cv.md` as the source of truth
2. Read `config/profile.yml` for candidate identity and location
3. Read `article-digest.md` only if it contains relevant proof points
4. Use the JD in context, or ask for it if missing
5. Extract 15-20 JD keywords
6. Detect JD language:
   - English roles -> default `modes/`
   - German roles -> `modes/de/` only when explicitly selected or clearly appropriate
   - French roles -> `modes/fr/` only when explicitly selected or clearly appropriate
7. Detect company location -> page format:
   - US/Canada -> `letter`
   - Else -> `a4`
8. Detect the role archetype and tailor framing accordingly
9. Rewrite the summary truthfully using JD vocabulary and the user's real background
10. Select the most relevant experience bullets and projects
11. Build a structured brief JSON in `output/`
12. Run the renderer:

```bash
node build-tailored-cv.mjs output/cv-{candidate}-{company}-{YYYY-MM-DD}.brief.json --html output/cv-{candidate}-{company}-{YYYY-MM-DD}.html --pdf output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf --format={letter|a4}
```

13. Report:
   - report path
   - HTML path
   - PDF path
   - page count
   - keyword coverage
14. If the role is worth pursuing, also generate a cover letter package:

```bash
node build-cover-letter.mjs output/cover-letter-{candidate}-{company}-{YYYY-MM-DD}.json --html output/cover-letter-{candidate}-{company}-{YYYY-MM-DD}.html --pdf output/cover-letter-{candidate}-{company}-{YYYY-MM-DD}.pdf --format={letter|a4}
```

15. Report:
   - cover letter HTML path
   - cover letter PDF path

If this mode is skipped by the gating rule above, do not create the brief, HTML, or PDF artifacts.

## Tailored brief contract

The structured brief should contain the tailored parts only. Shared candidate data stays in `cv.md` and `config/profile.yml`.

Suggested shape:

```json
{
  "language": "en",
  "format": "letter",
  "summary_text": "Tailored summary...",
  "keywords": ["keyword 1", "keyword 2"],
  "competencies": ["Competency 1", "Competency 2"],
  "experience": [
    {
      "company": "Company Name",
      "role": "Role Title",
      "bullets": ["Tailored bullet 1", "Tailored bullet 2"]
    }
  ],
  "projects": [
    {
      "title": "Project Name",
      "badge": "Optional badge",
      "description": "Short project description",
      "tech": "Optional keyword line"
    }
  ],
  "skills": [
    {
      "category": "Category",
      "items": ["Skill A", "Skill B"]
    }
  ]
}
```

## ATS rules

- Single-column layout only
- Standard section headers
- No critical information in images or PDF headers/footers
- No invented metrics
- No JD keyword stuffing
- Keywords should appear naturally in:
  - summary
  - first bullets of the most relevant roles
  - competencies
  - skills

## Tailoring rules

- Prefer truthful reframing over reinvention
- Reorder or rewrite bullets only when the claim is already supported by `cv.md` or `article-digest.md`
- Keep the base chronology intact
- Use the JD language for the generated output, with English as the default
- Preserve German and French support through `modes/de/` and `modes/fr/`; do not fork a separate English workflow
- Competency labels must be clearly supported by source files; if support is weak, omit the label rather than infer it

## Shared renderer

`build-tailored-cv.mjs` is the standard renderer for this mode.

It should:
- read `templates/cv-template.html`
- read shared candidate data from `cv.md` and `config/profile.yml`
- merge in tailored brief content
- write the HTML artifact
- optionally call `generate-pdf.mjs`

This keeps the generation path repeatable without changing the existing template, PDF generator, or tracker flow.

## Shared cover-letter renderer

`build-cover-letter.mjs` is the standard cover-letter renderer for this mode.

It should:
- read shared candidate data from `config/profile.yml`
- read a structured cover letter JSON from `output/`
- write the HTML artifact
- optionally call `generate-pdf.mjs`

This keeps cover letter generation repeatable for strong roles instead of manually crafting one-off files.

## Optional Canva path

If `config/profile.yml` has `canva_resume_design_id`, you may offer:
- `HTML/PDF (fast, ATS-optimized)` -> standard path above
- `Canva CV (visual, design-preserving)` -> optional path

If no Canva design ID exists, skip Canva and use the standard HTML/PDF path.

## Post-generation

If the role already exists in the tracker, update the PDF field from `❌` to `✅`.
