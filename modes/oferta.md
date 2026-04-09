# Mode: oferta -- Full A-F Evaluation

When the candidate pastes a job offer (text or URL), always deliver all 6 blocks:

## Step 0 -- Archetype Detection

Classify the offer into one of the 6 archetypes (see `_shared.md`). If it is hybrid, indicate the 2 closest archetypes. This determines:
- Which proof points to prioritize in Block B
- How to rewrite the summary in Block E
- Which STAR stories to prepare in Block F

## Block A -- Role Summary

Table with:
- Detected archetype
- Domain (platform/agentic/LLMOps/ML/enterprise)
- Function (build/consult/manage/deploy)
- Seniority
- Remote (full/hybrid/onsite)
- Team size (if mentioned)
- TL;DR in 1 sentence

## Block B -- CV Match

Read `cv.md`. Create a table mapping each JD requirement to exact CV lines.

**Adapted to the archetype:**
- If FDE -> prioritize fast-delivery and client-facing proof points
- If SA -> prioritize systems design and integrations
- If PM -> prioritize product discovery and metrics
- If LLMOps -> prioritize evals, observability, and pipelines
- If Agentic -> prioritize multi-agent, HITL, and orchestration
- If Transformation -> prioritize change management, adoption, and scaling

Add a **gaps** section with a mitigation strategy for each gap. For every gap:
1. Is it a hard blocker or a nice-to-have?
2. Can the candidate demonstrate adjacent experience?
3. Is there a portfolio project that covers the gap?
4. What is the concrete mitigation plan (cover-letter line, quick project, reframing, etc.)?

## Block C -- Level and Strategy

1. **Detected level** in the JD vs the candidate's **natural level for that archetype**
2. **"Sell senior without lying" plan**: specific positioning lines adapted to the archetype, concrete achievements to highlight, and how to position founder experience as an advantage
3. **"If they downlevel me" plan**: accept only if comp is fair, negotiate a 6-month review, and get clear promotion criteria

## Block D -- Comp and Demand

Use WebSearch for:
- Current salary data for the role (Glassdoor, Levels.fyi, Blind)
- Company compensation reputation
- Demand trend for the role

Include a table with data and cited sources. If data is unavailable, say so instead of inventing it.

## Block E -- Personalization Plan

| # | Section | Current state | Proposed change | Why |
|---|---------|---------------|-----------------|-----|
| 1 | Summary | ... | ... | ... |
| ... | ... | ... | ... | ... |

Top 5 CV changes + Top 5 LinkedIn changes to maximize fit.

## Block F -- Interview Plan

Create 6-10 STAR+R stories mapped to JD requirements (STAR + **Reflection**):

| # | JD requirement | STAR+R story | S | T | A | R | Reflection |
|---|----------------|-------------|---|---|---|---|------------|

The **Reflection** column captures what was learned or what would be done differently. This signals seniority: junior candidates describe what happened, senior candidates extract lessons.

**Story Bank:** If `interview-prep/story-bank.md` exists, check whether any of these stories are already there. If not, append them. Over time this becomes a reusable bank of 5-10 master stories that can be adapted to almost any interview question.

**Selected and framed by archetype:**
- FDE -> emphasize delivery speed and client-facing work
- SA -> emphasize architecture decisions
- PM -> emphasize discovery and trade-offs
- LLMOps -> emphasize metrics, evals, and production hardening
- Agentic -> emphasize orchestration, error handling, and HITL
- Transformation -> emphasize adoption and organizational change

Also include:
- 1 recommended case study (which project to present and how to frame it)
- Red-flag questions and how to answer them (for example: "why did you sell your company?", "do you manage direct reports?")

---

## Post-Evaluation

Always do the following after generating blocks A-F:

### 1. Save report .md

Save the full evaluation to `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`.

- `{###}` = next sequential number (3 digits, zero-padded)
- `{company-slug}` = lowercase company name without spaces (use hyphens)
- `{YYYY-MM-DD}` = current date

**Report format:**

```markdown
# Evaluation: {Company} - {Role}

**Date:** {YYYY-MM-DD}
**Archetype:** {detected}
**Score:** {X/5}
**PDF:** {path or pending}

---

## A) Role Summary
(full Block A content)

## B) CV Match
(full Block B content)

## C) Level and Strategy
(full Block C content)

## D) Comp and Demand
(full Block D content)

## E) Personalization Plan
(full Block E content)

## F) Interview Plan
(full Block F content)

## G) Draft Application Answers
(only if score >= 4.5 - draft answers for the application form)

---

## Extracted Keywords
(list 15-20 JD keywords for ATS optimization)
```

### 2. Register in tracker

Always register the role in `data/applications.md`:
- Next sequential number
- Current date
- Company
- Role
- Score: average match score (1-5)
- Status: `Evaluated`
- PDF: `❌` (or `✅` if auto-pipeline generated the PDF)
- Report: relative link to the report `.md` (for example `[001](reports/001-company-2026-01-01.md)`)

**Tracker format:**

```markdown
| # | Date | Company | Role | Score | Status | PDF | Report |
```
