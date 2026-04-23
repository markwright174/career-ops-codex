# Mode: auto-pipeline -- Full Automatic Pipeline

When the user pastes a JD (text or URL) without an explicit sub-command, run the full pipeline in sequence:

## Step 0 -- Extract the JD

If the input is a **URL** (not pasted JD text), use this extraction strategy:

**Priority order:**

1. **Playwright (preferred):** Most job portals (Lever, Ashby, Greenhouse, Workday) are SPAs. Use `browser_navigate` + `browser_snapshot` to render and read the JD.
2. **WebFetch (fallback):** For static pages (ZipRecruiter, company career pages that render server-side).
3. **WebSearch (last resort):** Search for the role title + company on secondary portals that index the JD as static HTML.

**If none of these work:** Ask the candidate to paste the JD manually or share a screenshot.

**If the input is JD text** (not a URL): use it directly with no fetch step.

## Step 1 -- A-G Evaluation

Run exactly the same evaluation flow as `oferta` mode, including Block G `Posting Legitimacy`.

## Step 2 -- Save Report .md

Save the full evaluation in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` using the format defined in `modes/oferta.md`.

## Step 3 -- Generate Tailored Resume Artifacts

Run the full `pdf` pipeline only when the role is worth pursuing:

- **Verified closed role** -> stop after report + tracker
- **Score below 4.0/5** -> stop after report + tracker
- **User explicitly asks for resume artifacts anyway** -> run the full `pdf` pipeline as an override

When resume artifacts are generated, the standard path is:

1. Create a structured tailored brief in `output/{cv-file}.brief.json`
2. Render the tailored HTML through `build-tailored-cv.mjs`
3. Generate the PDF through `generate-pdf.mjs` via the renderer

Do not hand-assemble resume HTML if the shared renderer is available.

## Step 4 -- Generate Cover Letter Artifacts

When a role is worth pursuing and resume artifacts were generated, also generate a tailored cover letter package unless the application clearly does not need one.

Standard path:

1. Create a structured cover letter JSON in `output/`
2. Render HTML through `build-cover-letter.mjs`
3. Generate the PDF through `generate-pdf.mjs` via the cover-letter renderer

Default rule:

- **Score >= 4.0/5 and role is application-worthy** -> generate cover letter package
- **Closed role** -> skip
- **Score below 4.0/5** -> skip

Use output names:

- `output/cover-letter-{candidate}-{company}-{YYYY-MM-DD}.json`
- `output/cover-letter-{candidate}-{company}-{YYYY-MM-DD}.html`
- `output/cover-letter-{candidate}-{company}-{YYYY-MM-DD}.pdf`

## Step 5 -- Draft Application Answers (only if score >= 4.5)

If the final score is >= 4.5, generate draft answers for the application form:

1. **Extract form questions:** Use Playwright to navigate to the form and snapshot it. If they cannot be extracted, use the generic questions.
2. **Generate answers** using the tone rules below.
3. **Save them in the report** as section `## H) Draft Application Answers`.

### Generic questions (use if the form questions cannot be extracted)

- Why are you interested in this role?
- Why do you want to work at [Company]?
- Tell us about a relevant project or achievement
- What makes you a good fit for this position?
- How did you hear about this role?

### Tone for Form Answers

**Positioning: "I'm choosing you."** The candidate has options and is choosing this company for specific reasons.

**Tone rules:**
- **Confident without arrogance:** "I've been intentional about finding a team where I can contribute meaningfully from day one."
- **Specific and concrete:** Reference something real from the JD or company, and something real from the candidate's experience.
- **Direct, no fluff:** 2-4 sentences per answer.
- **Lead with proof, not claims:** Prefer "I built X that did Y" over "I'm great at X."

**Language:** Always generate in the language of the JD, with English as the default.

## Step 6 -- Update Tracker

Register the role in `data/applications.md` after every evaluation.

- **Closed role** -> status `Discarded`
- **Active but below apply threshold (< 4.0/5)** -> status `SKIP`
- **Worth pursuing** -> status `Evaluated` unless the user asks for a different canonical state
- Set PDF to `✅` only when HTML/PDF artifacts were actually generated; otherwise leave it `❌`

**If any step fails**, continue with the next steps and mark the failed step as pending in the tracker.
