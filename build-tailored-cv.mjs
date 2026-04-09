#!/usr/bin/env node

/**
 * build-tailored-cv.mjs — Structured tailored CV brief -> HTML -> optional PDF
 *
 * Usage:
 *   node build-tailored-cv.mjs <brief.json> [--html <output.html>] [--pdf <output.pdf>] [--format=letter|a4]
 *
 * This script standardizes the HTML assembly step so the pipeline can reuse:
 * - cv.md (source-of-truth resume)
 * - config/profile.yml (candidate identity/header)
 * - templates/cv-template.html (shared HTML/CSS template)
 * - generate-pdf.mjs (existing PDF generation)
 *
 * The AI still creates the tailored brief content, but no longer needs to hand-assemble raw HTML.
 */

import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, parse, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(ROOT, 'templates', 'cv-template.html');
const CV_PATH = join(ROOT, 'cv.md');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
const PDF_SCRIPT_PATH = join(ROOT, 'generate-pdf.mjs');

const SECTION_LABELS = {
  en: {
    summary: 'Professional Summary',
    competencies: 'Core Competencies',
    experience: 'Work Experience',
    projects: 'Projects',
    education: 'Education',
    certifications: 'Certifications',
    skills: 'Skills',
  },
  es: {
    summary: 'Resumen Profesional',
    competencies: 'Competencias Core',
    experience: 'Experiencia Laboral',
    projects: 'Proyectos',
    education: 'Formacion',
    certifications: 'Certificaciones',
    skills: 'Competencias',
  },
  de: {
    summary: 'Berufliches Profil',
    competencies: 'Kernkompetenzen',
    experience: 'Berufserfahrung',
    projects: 'Projekte',
    education: 'Ausbildung',
    certifications: 'Zertifikate',
    skills: 'Kenntnisse',
  },
  fr: {
    summary: 'Resume Professionnel',
    competencies: 'Competences Clés',
    experience: 'Experience Professionnelle',
    projects: 'Projets',
    education: 'Formation',
    certifications: 'Certifications',
    skills: 'Competences',
  },
  pt: {
    summary: 'Resumo Profissional',
    competencies: 'Competencias Principais',
    experience: 'Experiencia Profissional',
    projects: 'Projetos',
    education: 'Formacao',
    certifications: 'Certificacoes',
    skills: 'Competencias',
  },
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    briefPath: null,
    htmlPath: null,
    pdfPath: null,
    format: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!parsed.briefPath && !arg.startsWith('--')) {
      parsed.briefPath = arg;
      continue;
    }
    if (arg === '--html') {
      parsed.htmlPath = args[++i];
      continue;
    }
    if (arg === '--pdf') {
      parsed.pdfPath = args[++i];
      continue;
    }
    if (arg.startsWith('--format=')) {
      parsed.format = arg.slice('--format='.length);
      continue;
    }
  }

  if (!parsed.briefPath) {
    console.error('Usage: node build-tailored-cv.mjs <brief.json> [--html <output.html>] [--pdf <output.pdf>] [--format=letter|a4]');
    process.exit(1);
  }

  return parsed;
}

function parseYamlScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSimpleYaml(content) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    if (rawLine.trim().startsWith('- ')) continue;

    const indent = rawLine.match(/^ */)[0].length;
    const line = rawLine.trim();
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;

    const [, key, value] = match;
    while (indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;

    if (value === '') {
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    } else {
      parent[key] = parseYamlScalar(value);
    }
  }

  return root;
}

function parseCv(content) {
  const lines = content.split(/\r?\n/);
  const sections = {
    summary: '',
    education: [],
    certifications: [],
    experience: [],
  };

  let currentSection = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('## ')) {
      currentSection = line.replace(/^## /, '').trim().toLowerCase();
      i++;
      continue;
    }

    if (!currentSection && line.trim() && !line.startsWith('# ') && !line.includes('linkedin.com') && !line.includes('@') && !line.includes('Houston, TX') && !line.includes('(')) {
      sections.summary = line.trim();
    }

    if (currentSection === 'education') {
      if (line.startsWith('**')) {
        const title = line.replace(/\*\*/g, '').trim();
        const orgLine = (lines[i + 1] || '').trim();
        const orgMatch = orgLine.match(/^(.*?)(?:,\s*(\d{4}))?$/);
        sections.education.push({
          title,
          org: orgMatch ? orgMatch[1].trim() : orgLine,
          year: orgMatch?.[2] || '',
        });
        i += 2;
        continue;
      }
    }

    if (currentSection === 'certifications') {
      if (line.trim().startsWith('- ')) {
        const item = line.trim().slice(2);
        const parts = item.split(',').map((p) => p.trim());
        const year = parts.length > 2 ? parts.pop() : '';
        const org = parts.length > 1 ? parts.pop() : '';
        const title = parts.join(', ');
        sections.certifications.push({ title, org, year });
      }
    }

    if (currentSection === 'professional experience') {
      if (line.startsWith('### ')) {
        const role = line.replace(/^### /, '').trim();
        const companyLine = (lines[i + 1] || '').trim();
        const companyMatch = companyLine.match(/^\*\*(.+?)\*\*\s*\|\s*(.+)$/);
        const company = companyMatch ? companyMatch[1].trim() : companyLine;
        const period = companyMatch ? companyMatch[2].trim() : '';
        const bullets = [];
        i += 2;
        while (i < lines.length && !lines[i].startsWith('### ') && !lines[i].startsWith('## ')) {
          const bulletLine = lines[i].trim();
          if (bulletLine.startsWith('- ')) bullets.push(bulletLine.slice(2).trim());
          i++;
        }
        sections.experience.push({ role, company, period, bullets });
        continue;
      }
    }

    i++;
  }

  return sections;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugToDisplay(url) {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function renderCompetencies(items) {
  return items.map((item) => `<span class="competency-tag">${escapeHtml(item)}</span>`).join('\n      ');
}

function renderExperience(entries) {
  return entries.map((entry) => {
    const bullets = entry.bullets
      .map((bullet) => `        <li>${escapeHtml(bullet)}</li>`)
      .join('\n');

    return [
      '    <div class="job">',
      '      <div class="job-header">',
      `        <div class="job-company">${escapeHtml(entry.company)}</div>`,
      `        <div class="job-period">${escapeHtml(entry.period || '')}</div>`,
      '      </div>',
      `      <div class="job-role">${escapeHtml(entry.role)}</div>`,
      '      <ul>',
      bullets,
      '      </ul>',
      '    </div>',
    ].join('\n');
  }).join('\n\n');
}

function renderProjects(projects) {
  return projects.map((project) => [
    '    <div class="project">',
    `      <div class="project-title">${escapeHtml(project.title)}${project.badge ? ` <span class="project-badge">${escapeHtml(project.badge)}</span>` : ''}</div>`,
    `      <div class="project-desc">${escapeHtml(project.description)}</div>`,
    project.tech ? `      <div class="project-tech">${escapeHtml(project.tech)}</div>` : '',
    '    </div>',
  ].filter(Boolean).join('\n')).join('\n\n');
}

function renderEducation(items) {
  return items.map((item) => [
    '    <div class="edu-item">',
    '      <div class="edu-header">',
    `        <div class="edu-title">${escapeHtml(item.title)}${item.org ? ` <span class="edu-org">${escapeHtml(item.org)}</span>` : ''}</div>`,
    `        <div class="edu-year">${escapeHtml(item.year || '')}</div>`,
    '      </div>',
    '    </div>',
  ].join('\n')).join('\n');
}

function renderCertifications(items) {
  return items.map((item) => [
    '    <div class="cert-item">',
    `      <div class="cert-title">${escapeHtml(item.title)}${item.org ? ` <span class="cert-org">${escapeHtml(item.org)}</span>` : ''}</div>`,
    `      <div class="cert-year">${escapeHtml(item.year || '')}</div>`,
    '    </div>',
  ].join('\n')).join('\n');
}

function renderSkills(items) {
  return items.map((item) => {
    const value = Array.isArray(item.items) ? item.items.join(', ') : item.items;
    return `      <div class="skill-item"><span class="skill-category">${escapeHtml(item.category)}:</span> ${escapeHtml(value)}</div>`;
  }).join('\n');
}

function mergeExperience(baseEntries, overrides) {
  if (!Array.isArray(overrides) || overrides.length === 0) return baseEntries;

  const baseByKey = new Map(baseEntries.map((entry) => [`${entry.company}::${entry.role}`, entry]));
  return overrides.map((override) => {
    const key = `${override.company}::${override.role}`;
    const base = baseByKey.get(key);
    if (!base) return override;
    return {
      role: override.role || base.role,
      company: override.company || base.company,
      period: override.period || base.period,
      bullets: override.bullets || base.bullets,
    };
  });
}

function inferOutputPath(briefPath, explicitPath, extension) {
  if (explicitPath) return resolve(explicitPath);
  const parsed = parse(briefPath);
  const stem = parsed.name.replace(/\.brief$/, '');
  return resolve(parsed.dir, `${stem}.${extension}`);
}

function computeKeywordCoverage(html, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return null;
  const lower = html.toLowerCase();
  const matched = keywords.filter((keyword) => lower.includes(String(keyword).toLowerCase()));
  return {
    matched: matched.length,
    total: keywords.length,
    coverage: Math.round((matched.length / keywords.length) * 100),
    missing: keywords.filter((keyword) => !matched.includes(keyword)),
  };
}

function buildHtml(template, data) {
  let html = template;
  for (const [key, value] of Object.entries(data)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }
  return html;
}

function runPdfGenerator(htmlPath, pdfPath, format) {
  const result = spawnSync(process.execPath, [PDF_SCRIPT_PATH, htmlPath, pdfPath, `--format=${format}`], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const briefPath = resolve(args.briefPath);
  const brief = JSON.parse(readFileSync(briefPath, 'utf-8'));
  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  const cv = parseCv(readFileSync(CV_PATH, 'utf-8'));
  const profile = parseSimpleYaml(readFileSync(PROFILE_PATH, 'utf-8'));

  const format = (args.format || brief.format || 'a4').toLowerCase();
  if (!['letter', 'a4'].includes(format)) {
    console.error(`Invalid format "${format}". Use letter or a4.`);
    process.exit(1);
  }

  const labels = {
    ...(SECTION_LABELS[brief.language || 'en'] || SECTION_LABELS.en),
    ...(brief.section_labels || {}),
  };

  const htmlPath = inferOutputPath(briefPath, args.htmlPath || brief.html_path, 'html');
  const pdfPath = args.pdfPath || brief.pdf_path ? inferOutputPath(briefPath, args.pdfPath || brief.pdf_path, 'pdf') : null;

  const candidate = profile.candidate || {};
  const experience = mergeExperience(cv.experience, brief.experience);
  const html = buildHtml(template, {
    LANG: escapeHtml(brief.language || 'en'),
    PAGE_WIDTH: format === 'letter' ? '8.5in' : '210mm',
    NAME: escapeHtml(candidate.full_name || brief.name || ''),
    EMAIL: escapeHtml(candidate.email || brief.email || ''),
    LINKEDIN_URL: escapeHtml((candidate.linkedin || '').startsWith('http') ? candidate.linkedin : `https://${candidate.linkedin || ''}`),
    LINKEDIN_DISPLAY: escapeHtml(slugToDisplay((candidate.linkedin || '').startsWith('http') ? candidate.linkedin : `https://${candidate.linkedin || ''}`)),
    LOCATION: escapeHtml(candidate.location || brief.location || ''),
    SECTION_SUMMARY: escapeHtml(labels.summary),
    SUMMARY_TEXT: escapeHtml(brief.summary_text || cv.summary || ''),
    SECTION_COMPETENCIES: escapeHtml(labels.competencies),
    COMPETENCIES: renderCompetencies(brief.competencies || []),
    SECTION_EXPERIENCE: escapeHtml(labels.experience),
    EXPERIENCE: renderExperience(experience),
    SECTION_PROJECTS: escapeHtml(labels.projects),
    PROJECTS: renderProjects(brief.projects || []),
    SECTION_EDUCATION: escapeHtml(labels.education),
    EDUCATION: renderEducation(cv.education),
    SECTION_CERTIFICATIONS: escapeHtml(labels.certifications),
    CERTIFICATIONS: renderCertifications(cv.certifications),
    SECTION_SKILLS: escapeHtml(labels.skills),
    SKILLS: renderSkills(brief.skills || []),
  });

  writeFileSync(htmlPath, html);

  const coverage = computeKeywordCoverage(html, brief.keywords || []);
  const summary = {
    brief: briefPath,
    html: htmlPath,
    pdf: pdfPath,
    format,
    keyword_coverage: coverage,
  };

  if (pdfPath) {
    runPdfGenerator(htmlPath, pdfPath, format);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
