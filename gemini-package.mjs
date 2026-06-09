#!/usr/bin/env node

/**
 * gemini-package.mjs — Generate tailored CV + cover letter package using Gemini
 *
 * Inputs:
 * - JD text from --jd-file or --text
 * - optional report path for richer context
 * - optional company / role / url overrides
 *
 * Outputs:
 * - output/cv-...brief.json
 * - output/cv-....html
 * - output/cv-....pdf
 * - output/cover-letter-....json
 * - output/cover-letter-....html
 * - output/cover-letter-....pdf
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  PATHS,
  ROOT,
  inferPaperFormat,
  logAction,
  readText,
  readYaml,
  runNodeScript,
  slugify,
  todayIso,
  updateTrackerPdfStatus,
} from './repo-ops-lib.mjs';

function loadDotenv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf-8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotenv(PATHS.dotenv);

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    jdFile: null,
    text: null,
    report: null,
    company: null,
    role: null,
    url: null,
    date: todayIso(),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--jd-file') parsed.jdFile = args[++i];
    else if (arg === '--text') parsed.text = args[++i];
    else if (arg === '--report') parsed.report = args[++i];
    else if (arg === '--company') parsed.company = args[++i];
    else if (arg === '--role') parsed.role = args[++i];
    else if (arg === '--url') parsed.url = args[++i];
    else if (arg === '--date') parsed.date = args[++i];
  }

  if (!parsed.jdFile && !parsed.text) {
    console.error('Usage: node gemini-package.mjs --jd-file <file> [--report <report.md>] [--company <name>] [--role <title>] [--url <url>]');
    process.exit(1);
  }

  return parsed;
}

function extractReportMeta(reportContent) {
  const title = reportContent.match(/^#\s+Evaluation:\s+(.+?)\s+—\s+(.+)$/m);
  const score = reportContent.match(/\*\*Score:\*\*\s*([0-9.]+\/5)/i);
  return {
    company: title ? title[1].trim() : null,
    role: title ? title[2].trim() : null,
    score: score ? score[1].trim() : null,
  };
}

function buildPrompt({ jdText, reportContent, company, role, profile, userProfile, cvContent, articleDigest }) {
  const candidate = profile.candidate || {};
  const location = profile.location || {};
  const compensation = profile.compensation || {};

  return `You are generating a tailored application package for a real job application.

Return JSON only. No markdown, no prose outside the JSON object.

Your task:
1. Create a structured CV brief that matches the schema expected by build-tailored-cv.mjs.
2. Create a structured cover letter JSON that matches the schema expected by build-cover-letter.mjs.

Truth rules:
- Use only supported facts from the provided CV, profile, user profile, article digest, and optional report context.
- Do not invent metrics.
- Do not claim unsupported tools or domain depth.
- Keep the cover letter concise and credible.
- Make the package feel tailored to the JD.

Candidate profile:
- Name: ${candidate.full_name || ''}
- Location: ${candidate.location || location.city || ''}
- Compensation target: ${compensation.target_range || ''}
- Compensation minimum: ${compensation.minimum || ''}

Requested company: ${company || 'Unknown'}
Requested role: ${role || 'Unknown'}

CV source:
${cvContent}

User profile guidance:
${userProfile}

Article digest:
${articleDigest}

Existing evaluation report context:
${reportContent || '[No report provided]'}

Job description:
${jdText}

Return JSON in this exact shape:
{
  "brief": {
    "language": "en",
    "format": "letter",
    "summary_text": "...",
    "keywords": ["..."],
    "competencies": ["..."],
    "experience": [
      {
        "company": "...",
        "role": "...",
        "bullets": ["...", "..."]
      }
    ],
    "projects": [
      {
        "title": "...",
        "badge": "...",
        "description": "...",
        "tech": "Keywords: ..."
      }
    ],
    "skills": [
      {
        "category": "...",
        "items": ["...", "..."]
      }
    ]
  },
  "letter": {
    "language": "en",
    "format": "letter",
    "date": "${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}",
    "recipient_lines": ["Hiring Team"${company ? `, "${company.replace(/"/g, '\\"')}"` : ''}],
    "greeting": "Dear Hiring Team,",
    "paragraphs": ["...", "...", "..."],
    "closing": "Sincerely,"
  }
}

Package-specific guidance:
- The CV summary should be dense, practical, and keyword-aware.
- Use 12-18 keywords.
- Use 8-10 competencies max.
- Keep experience entries tied to real source roles only.
- Prefer the strongest adjacent evidence when the JD asks for a stretch area.
- The cover letter should usually be 2-3 paragraphs.
- Explain why this role fits and why the candidate is credible, without overselling domain gaps.
- If the role is below the compensation floor or otherwise questionable, still tailor the package professionally if asked, but do not pretend the role is ideal.
`;
}

function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not found in environment or .env');
    process.exit(1);
  }

  const jdText = args.jdFile ? readFileSync(resolve(args.jdFile), 'utf-8').trim() : String(args.text || '').trim();
  if (!jdText) {
    console.error('JD text is empty.');
    process.exit(1);
  }

  const reportContent = args.report && existsSync(resolve(args.report))
    ? readFileSync(resolve(args.report), 'utf-8')
    : '';
  const reportMeta = extractReportMeta(reportContent);

  const company = args.company || reportMeta.company || 'unknown-company';
  const role = args.role || reportMeta.role || 'unknown-role';

  const profile = readYaml(PATHS.profile, {});
  const userProfile = readText(PATHS.userProfile, '');
  const cvContent = readText(PATHS.cv, '');
  const articleDigest = readText(PATHS.articleDigest, '');

  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    },
  });

  const prompt = buildPrompt({
    jdText,
    reportContent,
    company,
    role,
    profile,
    userProfile,
    cvContent,
    articleDigest,
  });

  const response = model.generateContent(prompt);
  return Promise.resolve(response).then((result) => {
    const text = result.response.text().trim();
    const parsed = JSON.parse(text);
    const candidateSlug = slugify(profile?.candidate?.full_name || 'candidate');
    const companySlug = slugify(company);
    const date = args.date || todayIso();

    const briefPath = join(PATHS.output, `cv-${candidateSlug}-${companySlug}-${date}.brief.json`);
    const letterPath = join(PATHS.output, `cover-letter-${candidateSlug}-${companySlug}-${date}.json`);
    const cvHtmlPath = join(PATHS.output, `cv-${candidateSlug}-${companySlug}-${date}.html`);
    const cvPdfPath = join(PATHS.output, `cv-${candidateSlug}-${companySlug}-${date}.pdf`);
    const coverHtmlPath = join(PATHS.output, `cover-letter-${candidateSlug}-${companySlug}-${date}.html`);
    const coverPdfPath = join(PATHS.output, `cover-letter-${candidateSlug}-${companySlug}-${date}.pdf`);

    const format = parsed.brief?.format || inferPaperFormat(jdText, 'letter');
    parsed.brief.format = format;
    parsed.letter.format = format;
    mkdirSync(PATHS.output, { recursive: true });
    writeFileSync(briefPath, JSON.stringify(parsed.brief, null, 2), 'utf-8');
    writeFileSync(letterPath, JSON.stringify(parsed.letter, null, 2), 'utf-8');

    const cvRun = runNodeScript('build-tailored-cv.mjs', [
      briefPath,
      '--html', cvHtmlPath,
      '--pdf', cvPdfPath,
      `--format=${format}`,
    ]);
    if (!cvRun.ok) {
      console.error(cvRun.stderr || cvRun.stdout || 'CV build failed.');
      process.exit(cvRun.status || 1);
    }

    const letterRun = runNodeScript('build-cover-letter.mjs', [
      letterPath,
      '--html', coverHtmlPath,
      '--pdf', coverPdfPath,
      `--format=${format}`,
    ]);
    if (!letterRun.ok) {
      console.error(letterRun.stderr || letterRun.stdout || 'Cover letter build failed.');
      process.exit(letterRun.status || 1);
    }

    updateTrackerPdfStatus(company, role, '✅');
    logAction({
      actor: 'gemini-package',
      action: 'create-package',
      company,
      role,
      url: args.url || null,
      report: args.report || null,
      outputs: {
        briefPath,
        letterPath,
        cvHtmlPath,
        cvPdfPath,
        coverHtmlPath,
        coverPdfPath,
      },
    });

    console.log(JSON.stringify({
      ok: true,
      company,
      role,
      format,
      report: args.report || null,
      outputs: {
        brief_json: briefPath,
        cv_html: cvHtmlPath,
        cv_pdf: cvPdfPath,
        cover_letter_json: letterPath,
        cover_letter_html: coverHtmlPath,
        cover_letter_pdf: coverPdfPath,
      },
    }, null, 2));
  }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

main();
