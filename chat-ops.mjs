#!/usr/bin/env node

/**
 * chat-ops.mjs — lightweight frontend command surface for ChatGPT/Codex
 *
 * Purpose:
 * - expose a small, explicit action set over the existing repo workflow
 * - return compact structured output so a conversational frontend does not
 *   need to re-derive repo behavior from raw markdown every turn
 *
 * Usage examples:
 *   node chat-ops.mjs help
 *   node chat-ops.mjs tracker --status Applied --limit 10
 *   node chat-ops.mjs inbox
 *   node chat-ops.mjs scan
 *   node chat-ops.mjs scan-safe
 *   node chat-ops.mjs verify
 *   node chat-ops.mjs quick-apply
 *   node chat-ops.mjs patterns
 *   node chat-ops.mjs liveness <url1> [url2]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { inferPaperFormat, logAction, PATHS, readYaml, updateTrackerPdfStatus } from './repo-ops-lib.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPS_FILE = join(ROOT, 'data', 'applications.md');
const PIPELINE_FILE = join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY_FILE = join(ROOT, 'data', 'scan-history.tsv');
const PROFILE_FILE = join(ROOT, 'config', 'profile.yml');
const OUTPUT_DIR = join(ROOT, 'output');
const REPORTS_DIR = join(ROOT, 'reports');
const TRACKER_ADDITIONS_DIR = join(ROOT, 'batch', 'tracker-additions');
const BLOCKED_READ_BASENAMES = new Set([
  '.env',
  '.env.local',
]);
const BLOCKED_READ_SEGMENTS = new Set([
  '.git',
  'node_modules',
]);
const TEXT_READ_EXTENSIONS = new Set([
  '',
  '.md',
  '.txt',
  '.json',
  '.yml',
  '.yaml',
  '.mjs',
  '.js',
  '.ts',
  '.tsx',
  '.html',
  '.css',
  '.ps1',
  '.toml',
  '.tsv',
  '.csv',
]);
const PRIMARY_TITLE_SIGNALS = [
  'instructional design manager',
  'senior learning experience designer',
  'senior instructional designer',
  'director of instructional design',
  'global director of instructional design',
  'learning design director',
];
const SECONDARY_TITLE_SIGNALS = [
  'customer education manager',
  'manager, customer education',
  'customer education design',
  'technical learning design and development',
  'learning and organizational development',
  'learning and development lead',
  'learning development lead',
  'l d lead',
  'leadership development',
  'organizational development',
  'talent development',
  'learning and development manager',
  'senior manager, customer education',
];
const ADJACENT_TITLE_SIGNALS = [
  'learning and development',
  'learning designer',
  'learning experience designer',
  'instructional designer',
  'curriculum designer',
  'curriculum developer',
  'faculty development',
  'professional learning',
  'technical training',
  'technology enablement',
  'technical enablement',
  'training manager',
];
const DOWNLEVEL_SIGNALS = [
  'associate',
  'specialist',
  'coordinator',
  'facilitator',
  'trainer',
  'assistant manager',
  'instructional designer ii',
  'ii',
];
const HIGH_RISK_SIGNALS = [
  'customer success',
  'sales enablement',
  'revenue enablement',
  'operations enablement',
  'support enablement',
  'campus',
  'principal customer success',
];
const CANONICAL_STATUSES = new Set([
  'Evaluated',
  'Applied',
  'Responded',
  'Interview',
  'Offer',
  'Rejected',
  'Discarded',
  'SKIP',
]);
const PIPELINE_MARKERS = {
  pending: ' ',
  processed: 'x',
  issue: '!',
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    action: args[0] || 'help',
    positionals: [],
    flags: {},
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, inlineValue] = arg.slice(2).split('=', 2);
      if (inlineValue !== undefined) {
        result.flags[key] = inlineValue;
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          result.flags[key] = next;
          i++;
        } else {
          result.flags[key] = true;
        }
      }
    } else {
      result.positionals.push(arg);
    }
  }

  return result;
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
      const trimmed = value.trim();
      parent[key] = (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ) ? trimmed.slice(1, -1) : trimmed;
    }
  }

  return root;
}

function extnameSafe(path) {
  const idx = path.lastIndexOf('.');
  if (idx <= 0) return '';
  return path.slice(idx).toLowerCase();
}

function isBlockedReadPath(path) {
  const normalized = resolve(path);
  const relative = normalized.slice(ROOT.length).replace(/^[\\/]+/, '');
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (BLOCKED_READ_BASENAMES.has(basename(normalized).toLowerCase())) return true;
  return parts.some((part) => BLOCKED_READ_SEGMENTS.has(part.toLowerCase()));
}

function resolveReadableRepoPath(inputPath = '.') {
  const resolved = resolve(ROOT, String(inputPath || '.'));
  if (!resolved.startsWith(ROOT)) {
    throw new Error(`Path "${inputPath}" resolves outside the repo root.`);
  }
  if (isBlockedReadPath(resolved)) {
    throw new Error(`Path "${inputPath}" is blocked from MCP read access.`);
  }
  return resolved;
}

function ensureReadableTextFile(path) {
  const ext = extnameSafe(path);
  if (!TEXT_READ_EXTENSIONS.has(ext)) {
    throw new Error(`File "${path}" is not an allowed text-readable type.`);
  }
}

function safeJsonParse(text, label) {
  try {
    return JSON.parse(String(text || ''));
  } catch (err) {
    throw new Error(`Invalid ${label} JSON: ${err.message}`);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function findUnknownKeys(obj, allowedKeys = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const allowed = new Set(allowedKeys);
  return Object.keys(obj).filter((key) => !allowed.has(key));
}

function parseBaseCvExperienceKeys(cvPath = PATHS.cv) {
  const path = cvPath;
  if (!existsSync(path)) return new Set();
  return new Set(
    parseCvChronologyFromPath(path).map((entry) => `${normalizeCompany(entry.company)}::${normalizeText(entry.role)}`)
  );
}

function parseCvChronologyFromPath(filePath = PATHS.cv) {
  if (!existsSync(filePath)) {
    return [];
  }

  const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/);
  const rows = [];
  let inExperience = false;
  let currentRole = null;

  function flushCurrentRole() {
    if (currentRole && currentRole.company && currentRole.role) {
      rows.push({
        role: currentRole.role,
        company: currentRole.company,
        period: currentRole.period,
        bullets: currentRole.bullets.slice(),
      });
    }
    currentRole = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('## ')) {
      if (inExperience) {
        flushCurrentRole();
      }
      inExperience = /^##\s+Professional Experience\s*$/i.test(line.trim());
      continue;
    }
    if (!inExperience) continue;

    const roleMatch = line.match(/^###\s+(.+?)\s*$/);
    if (roleMatch) {
      flushCurrentRole();
      currentRole = { role: roleMatch[1].trim(), company: '', period: '', bullets: [] };
      continue;
    }

    const companyMatch = line.match(/^\*\*(.+?)\*\*\s*\|\s*(.+?)\s*$/);
    if (companyMatch && currentRole) {
      currentRole.company = companyMatch[1].trim();
      currentRole.period = companyMatch[2].trim();
      continue;
    }

    if (currentRole && line.trim().startsWith('- ')) {
      currentRole.bullets.push(line.trim().slice(2).trim());
      continue;
    }
  }

  flushCurrentRole();

  return rows;
}

function parseBaseCvChronology() {
  return parseCvChronologyFromPath(PATHS.cv);
}

function buildBaseCvExperienceMap(cvPath = PATHS.cv) {
  const map = new Map();
  for (const entry of parseCvChronologyFromPath(cvPath)) {
    const key = `${normalizeCompany(entry.company)}::${normalizeText(entry.role)}`;
    map.set(key, entry);
  }
  return map;
}

function validateHybridBrief(brief, cvPath = PATHS.cv) {
  const errors = [];
  const baseExperienceKeys = parseBaseCvExperienceKeys(cvPath);
  const unknownBriefKeys = findUnknownKeys(brief, [
    'summary_text',
    'competencies',
    'experience',
    'projects',
    'skills',
    'keywords',
    'language',
    'section_labels',
    'name',
    'phone',
    'email',
    'location',
    'portfolio_url',
    'format',
    'html_path',
    'pdf_path',
  ]);
  if (unknownBriefKeys.length > 0) {
    errors.push(`brief has unsupported keys: ${unknownBriefKeys.join(', ')}. Use only the documented brief schema keys.`);
  }

  if (!isNonEmptyString(brief.summary_text)) {
    errors.push('brief.summary_text is required and must be a non-empty string.');
  }

  if (!Array.isArray(brief.competencies) || brief.competencies.length === 0) {
    errors.push('brief.competencies must be a non-empty array of strings.');
  }

  if (!Array.isArray(brief.experience) || brief.experience.length === 0) {
    errors.push('brief.experience must be a non-empty array.');
  } else {
    brief.experience.forEach((entry, index) => {
      const unknownEntryKeys = findUnknownKeys(entry, ['company', 'role', 'period', 'bullets']);
      if (unknownEntryKeys.length > 0) {
        errors.push(`brief.experience[${index}] has unsupported keys: ${unknownEntryKeys.join(', ')}.`);
      }
      if (!isNonEmptyString(entry.company)) {
        errors.push(`brief.experience[${index}].company is required.`);
      }
      if (!isNonEmptyString(entry.role)) {
        errors.push(`brief.experience[${index}].role is required.`);
      }
      if (!Array.isArray(entry.bullets) || entry.bullets.length === 0) {
        errors.push(`brief.experience[${index}].bullets must be a non-empty array of strings.`);
      }
      if (isNonEmptyString(entry.company) && isNonEmptyString(entry.role)) {
        const key = `${normalizeCompany(entry.company)}::${normalizeText(entry.role)}`;
        if (!baseExperienceKeys.has(key)) {
          errors.push(
            `brief.experience[${index}] must reference a real CV role/company pair. ` +
            `Use bullet overrides for existing roles instead of synthetic umbrella entries like "${entry.company}" / "${entry.role}".`
          );
        }
      }
    });
  }

  if (!Array.isArray(brief.skills) || brief.skills.length === 0) {
    errors.push('brief.skills must be a non-empty array.');
  } else {
    brief.skills.forEach((entry, index) => {
      const unknownSkillKeys = findUnknownKeys(entry, ['category', 'items']);
      if (unknownSkillKeys.length > 0) {
        errors.push(`brief.skills[${index}] has unsupported keys: ${unknownSkillKeys.join(', ')}.`);
      }
      if (!isNonEmptyString(entry.category)) {
        errors.push(`brief.skills[${index}].category is required.`);
      }
      if (
        !Array.isArray(entry.items)
        || entry.items.length === 0
        || !entry.items.every((item) => isNonEmptyString(item))
      ) {
        errors.push(`brief.skills[${index}].items must be a non-empty array of strings.`);
      }
    });
  }

  if (brief.projects !== undefined && !Array.isArray(brief.projects)) {
    errors.push('brief.projects must be an array when provided.');
  } else if (Array.isArray(brief.projects)) {
    brief.projects.forEach((project, index) => {
      const unknownProjectKeys = findUnknownKeys(project, ['title', 'badge', 'description', 'tech']);
      if (unknownProjectKeys.length > 0) {
        errors.push(`brief.projects[${index}] has unsupported keys: ${unknownProjectKeys.join(', ')}.`);
      }
      if (!isNonEmptyString(project.title) || !isNonEmptyString(project.description)) {
        errors.push(`brief.projects[${index}] requires non-empty title and description.`);
      }
    });
  }

  return errors;
}

function validateHybridLetter(letter) {
  const errors = [];
  const unknownLetterKeys = findUnknownKeys(letter, [
    'date',
    'recipient_lines',
    'greeting',
    'paragraphs',
    'closing',
    'language',
    'format',
    'html_path',
    'pdf_path',
  ]);
  if (unknownLetterKeys.length > 0) {
    errors.push(`letter has unsupported keys: ${unknownLetterKeys.join(', ')}. Use only the documented letter schema keys.`);
  }

  if (!isNonEmptyString(letter.date)) {
    errors.push('letter.date is required and must be a non-empty string.');
  }

  if (!Array.isArray(letter.recipient_lines) || letter.recipient_lines.length === 0) {
    errors.push('letter.recipient_lines must be a non-empty array of strings.');
  }

  if (!isNonEmptyString(letter.greeting)) {
    errors.push('letter.greeting is required and must be a non-empty string.');
  }

  if (!Array.isArray(letter.paragraphs) || letter.paragraphs.length < 2) {
    errors.push('letter.paragraphs must be an array with at least 2 paragraphs.');
  }

  if (!isNonEmptyString(letter.closing)) {
    errors.push('letter.closing is required and must be a non-empty string.');
  } else if (String(letter.closing).includes('\n')) {
    errors.push('letter.closing must be a single-line closing such as "Sincerely,". Do not include the candidate name in closing.');
  }

  return errors;
}

function normalizedBulletList(bullets = []) {
  return bullets
    .map((bullet) => normalizeText(bullet))
    .filter(Boolean);
}

function bulletsChangedFromBase(candidateBullets = [], baseBullets = []) {
  const left = normalizedBulletList(candidateBullets);
  const right = normalizedBulletList(baseBullets);
  return JSON.stringify(left) !== JSON.stringify(right);
}

function companyReferenceTokens(company) {
  return normalizeText(company)
    .split(' ')
    .filter((token) => token.length > 3 && !['university', 'college', 'group', 'company'].includes(token));
}

function hasCompanyReference(text, company) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const full = normalizeText(company);
  if (full && normalized.includes(full)) return true;
  return companyReferenceTokens(company).some((token) => normalized.includes(token));
}

function roleReferenceTokens(role) {
  const stopwords = new Set([
    'and', 'the', 'for', 'with', 'role', 'position', 'of', 'to', 'in',
    'senior', 'jr', 'sr', 'principal', 'director', 'manager', 'lead',
    'head', 'associate', 'ii', 'iii', 'iv',
  ]);
  return [...new Set(
    normalizeText(role)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !stopwords.has(token))
  )];
}

function hasRoleReference(text, role) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const full = normalizeText(role);
  if (full && normalized.includes(full)) return true;
  const tokens = roleReferenceTokens(role);
  let matches = 0;
  for (const token of tokens) {
    if (normalized.includes(token)) matches += 1;
  }
  return matches >= Math.min(2, tokens.length);
}

function inferCoverLetterThemes(reportContent = '', row = {}) {
  const source = normalizeText(`${reportContent || ''}\n${row.role || ''}\n${row.notes || ''}`);
  const themeCatalog = [
    {
      key: 'operations',
      label: 'operations and process discipline',
      tokens: ['operations', 'operational', 'workflow', 'workflows', 'process', 'processes', 'documentation'],
    },
    {
      key: 'prioritization',
      label: 'prioritization, intake, and timelines',
      tokens: ['prioritization', 'priorities', 'intake', 'timeline', 'timelines', 'milestones', 'risk'],
    },
    {
      key: 'curriculum',
      label: 'curriculum and course-development maintenance',
      tokens: ['curriculum', 'course development', 'course-development', 'course maintenance', 'maintenance', 'courses'],
    },
    {
      key: 'stakeholders',
      label: 'academic and stakeholder coordination',
      tokens: ['stakeholder', 'stakeholders', 'faculty', 'academic', 'academic affairs', 'cross functional', 'cross-functional', 'sme'],
    },
    {
      key: 'delivery_quality',
      label: 'delivery quality, assessment, and accessibility',
      tokens: ['quality', 'assessment', 'accessibility', 'learner', 'delivery', 'lms'],
    },
  ];

  const inferred = themeCatalog.filter((theme) =>
    theme.tokens.some((token) => source.includes(normalizeText(token)))
  );

  return inferred.length > 0 ? inferred : themeCatalog.slice(0, 3);
}

function extractReportRiskSignals(reportContent = '') {
  const stopwords = new Set([
    'about', 'across', 'adjacent', 'align', 'also', 'although', 'among', 'and', 'another',
    'avoid', 'best', 'between', 'bridge', 'bring', 'candidate', 'can', 'claim', 'claims',
    'confirm', 'confirmed', 'context', 'core', 'credibly', 'current', 'deep', 'direct',
    'does', 'dont', 'education', 'experience', 'fit', 'focus', 'frame', 'from', 'good',
    'have', 'highly', 'include', 'includes', 'into', 'keep', 'lane', 'lead', 'leadership',
    'main', 'mark', 'match', 'more', 'must', 'need', 'not', 'only', 'or', 'other',
    'overlap', 'overstate', 'owned', 'ownership', 'position', 'posting', 'present',
    'primary', 'profile', 'project', 'role', 'secondary', 'selectively', 'should',
    'show', 'signal', 'skills', 'some', 'strength', 'strengths', 'strong', 'support',
    'supports', 'that', 'the', 'their', 'them', 'these', 'this', 'through', 'treat',
    'unless', 'use', 'using', 'very', 'with', 'without', 'work', 'works',
    'instructional', 'design', 'manager', 'management', 'curriculum', 'development',
    'learning', 'operational', 'operations', 'quality', 'delivery', 'stakeholder',
    'stakeholders', 'team', 'program', 'programs', 'faculty', 'training', 'reporting',
    'process', 'processes', 'similar', 'preferred', 'practical', 'specific', 'under',
    'such', 'which', 'allows', 'allow', 'sits', 'mentions', 'line',
  ]);
  const lines = String(reportContent || '')
    .split(/\r?\n/)
    .map((line) => line.trim());

  const signals = [];
  let section = '';
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      section = line.replace(/^##\s+/, '').trim().toLowerCase();
      continue;
    }
    if (!line.startsWith('- ')) continue;

    const normalized = normalizeText(line);
    if (!normalized) continue;

    let kind = null;
    if (/(do not overstate|avoid claiming|unless confirmed|unless present)/i.test(line)) {
      kind = 'overclaim';
    } else if (/(adjacency|adjacent|bridge|selectively|secondary|not core strengths?)/i.test(line)) {
      kind = 'adjacency';
    } else if (/(does not have|does not appear|not .*specific|not .*direct)/i.test(line)) {
      kind = 'gap';
    }
    if (!kind) continue;
    if (!/(cv match|level and strategy|personalization plan)/i.test(section)) continue;

    const tokens = [...new Set(
      normalized
        .split(' ')
        .map((token) => token.trim())
        .filter((token) =>
          token.length >= 4
          && !stopwords.has(token)
          && !/^\d+$/.test(token)
        )
    )].slice(0, 8);

    if (tokens.length === 0) continue;
    signals.push({ kind, line, tokens });
  }

  return signals;
}

function buildQualityPackageRules(row, chronology, reportContent = '') {
  const focusRoles = chronology.slice(0, 4).map((entry) => ({
    company: entry.company,
    role: entry.role,
  }));
  const coverLetterThemes = inferCoverLetterThemes(reportContent, row);

  return {
    summary: 'Prefer strong bullet-level tailoring on real CV roles before adding project filler.',
    required_steps: [
      'Use real CV chronology only.',
      'Read the saved tracker row, report, CV chronology, and profile context first.',
      'Tailor primarily by refining bullets on real roles, especially the recent core roles.',
      'Build builder-ready JSON only.',
      'Run the quality build/write path through this tool.',
    ],
    cv_requirements: [
      'Use only real company/role pairs from CV chronology.',
      'At least two roles should show meaningful bullet overrides beyond the base CV.',
      'At least two focus roles should show tailored bullets when possible.',
      'Keep the summary credible; avoid stacking absolute scope claims when the role is better framed with measured current ownership.',
      'Make the strongest role themes visible in real work-history bullets, not only in the summary or projects.',
      'Avoid synthetic umbrella employers, synthetic contexts, or fake roles.',
      'Keep projects additive; do not make projects carry most of the tailoring.',
      'Do not turn adjacency, bridge experience, or caution areas from the saved report into direct ownership claims.',
      'Prefer restrained workflow/outcome framing over named-product AI/tool emphasis.',
    ],
    cover_letter_requirements: [
      'Use 3-4 body paragraphs.',
      'Include a real date.',
      'Keep closing as exactly "Sincerely," and let the renderer add the candidate name.',
      'Mention the target role clearly in the opening paragraph.',
      'Mention the company directly in the body.',
      'Reflect at least 2 role-specific themes from the saved evaluation context.',
      'Do not turn adjacency, bridge experience, or caution areas from the saved report into direct ownership claims.',
      'Do not mention compensation.',
    ],
    cover_letter_focus_themes: coverLetterThemes.map((theme) => theme.label),
    focus_roles: focusRoles,
  };
}

function appendTailoredClause(text, clause) {
  const base = String(text || '').trim().replace(/[.?!]\s*$/, '');
  const addon = String(clause || '').trim().replace(/[.?!]\s*$/, '');
  if (!base || !addon) return String(text || '').trim();
  if (normalizeText(base).includes(normalizeText(addon))) return `${base}.`;
  return `${base}, ${addon}.`;
}

function isTruthyFlag(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function joinWithAnd(items) {
  const parts = (Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function buildAutoDraftSummary(row, themes) {
  const themeLabels = Array.isArray(themes) ? themes.map((theme) => theme.label).filter(Boolean) : [];
  const themeOne = themeLabels[0] || 'practical learning delivery';
  const themeTwo = themeLabels[1] || 'stakeholder coordination';

  if (/\b(learning product|professional learning|enablement|capability)\b/i.test(`${row.role || ''} ${row.notes || ''}`)) {
    return `Learning product and educator enablement leader who builds practical learning systems that support ${themeOne} and ${themeTwo} while keeping delivery usable, measurable, and easy to adopt.`;
  }

  return `Senior learning and instructional design leader who builds scalable learning ecosystems, leadership development programs, compliance-ready learning operations, and AI-supported adoption pathways across complex environments.`;
}

function buildAutoDraftCompetencies(row) {
  if (/\b(learning product|professional learning|enablement|capability)\b/i.test(`${row.role || ''} ${row.notes || ''}`)) {
    return [
      'Learning product strategy and delivery',
      'Educator enablement and adoption support',
      'Learning operations and process discipline',
      'Stakeholder facilitation and coaching',
      'LMS administration and optimization',
      'Accessibility and universal design',
      'Program measurement and continuous improvement',
      'AI-supported workflow design',
      'Documentation and templates',
      'Cross-functional coordination',
    ];
  }

  return [
    'L&D strategy and ecosystem design',
    'Learning operations and process discipline',
    'Compliance training and governance',
    'AI literacy and adoption support',
    'LMS administration and optimization',
    'Accessibility and universal design',
    'Stakeholder facilitation and coaching',
    'Program measurement and continuous improvement',
    'Vendor and cross-functional coordination',
    'Leadership development and capability building',
  ];
}

function themeClauseMap() {
  return {
    operations: 'while keeping workflows documented and repeatable',
    prioritization: 'while balancing priorities, timelines, and risk',
    curriculum: 'to keep course development prioritized and maintainable',
    stakeholders: 'with faculty, SME, and cross-functional coordination',
    delivery_quality: 'with an emphasis on accessibility, assessment, and learner experience',
  };
}

function laneClauseMap() {
  return [
    'across multiple programs and delivery formats',
    'with quality, timelines, and stakeholder priorities aligned',
    'to support scalable implementation and adoption',
    'with learner experience and accessibility in view',
  ];
}

function tailorExperienceEntry(entry, context, index) {
  const themes = Array.isArray(context.cover_letter_focus_themes) ? context.cover_letter_focus_themes : [];
  const themeClauses = themes
    .map((theme) => themeClauseMap()[theme.key])
    .filter(Boolean);
  const laneClauses = laneClauseMap();
  const roleClauses = [...themeClauses, ...laneClauses].filter(Boolean);
  const baseBullets = Array.isArray(entry.bullets) ? entry.bullets : [];
  const maxBulletsToTailor = Math.min(2, baseBullets.length);

  const bullets = baseBullets.map((bullet, bulletIndex) => {
    if (bulletIndex >= maxBulletsToTailor) return bullet;
    const clause = roleClauses[(index + bulletIndex) % roleClauses.length] || roleClauses[0];
    return appendTailoredClause(bullet, clause);
  });

  return {
    company: entry.company,
    role: entry.role,
    bullets,
  };
}

function buildAutoDraftLetter(context) {
  const themeLabels = Array.isArray(context.cover_letter_focus_themes)
    ? context.cover_letter_focus_themes.map((theme) => theme.label).filter(Boolean)
    : [];
  const themeOne = themeLabels[0] || 'operations and process discipline';
  const themeTwo = themeLabels[1] || 'prioritization, intake, and timelines';
  const themeThree = themeLabels[2] || 'curriculum and course-development maintenance';
  const focusCompanies = (Array.isArray(context.focus_roles) ? context.focus_roles : [])
    .map((entry) => entry.company)
    .filter(Boolean);
  const focusCompanyText = joinWithAnd(focusCompanies);

  const opening = `I am excited to apply for the ${context.role} role at ${context.company} because it sits directly at the intersection of the work I do best: building learning systems that help people grow, improve performance, and adopt new ways of working in a practical, measurable way.`;
  const bodyOne = `Across ${focusCompanyText || 'my recent roles in higher education, workforce learning, and learning operations'}, I have led curriculum and learning operations, supported teams through change, partnered closely with subject matter experts, and turned complex content into usable learning experiences. That mix of leadership and hands-on execution lines up well with ${context.company}'s emphasis on ${themeOne}.`;
  const bodyTwo = `I am especially drawn to the way ${context.company} is asking someone to keep curricula current, relevant, and measurable while also partnering across the business. My experience has been strongest in environments where learning has to be practical, accessible, and easy to apply, and I would bring that same mindset to helping teams strengthen capability, keep programs aligned with business priorities, and support the people who use the learning every day.`;
  const bodyThree = `The chance to contribute to ${context.company}'s mission in a role that combines strategy, operations, and learner support is compelling, especially where learning path architecture and ongoing content maintenance matter as much as the initial design.`;

  return {
    date: todayIso(),
    recipient_lines: ['Hiring Team', context.company],
    greeting: 'Dear Hiring Team,',
    paragraphs: [opening, bodyOne, bodyTwo, bodyThree],
    closing: 'Sincerely,',
  };
}

function buildAutoDraftQualityPackage(context, chronology) {
  const profileMode = 'tstc';
  const brief = {
    summary_text: buildAutoDraftSummary(context, context.cover_letter_focus_themes),
    competencies: buildAutoDraftCompetencies(context),
    experience: chronology.slice(0, 4).map((entry, index) => tailorExperienceEntry(entry, context, index)),
    skills: [
      {
        category: 'Learning & Development',
        items: [
          'L&D strategy',
          'capability building',
          'learning ecosystems',
          'program design',
          'measurement',
          'facilitation',
        ],
      },
      {
        category: 'Learning Technology',
        items: [
          'LMS administration',
          'D2L Brightspace',
          'Blackboard',
          'Canvas',
          'Codio',
          'accessibility',
          'Articulate Storyline',
          'Articulate Rise',
          'Adobe Captivate',
        ],
      },
      {
        category: 'Leadership & Operations',
        items: [
          'team leadership',
          'stakeholder management',
          'coaching',
          'process improvement',
          'vendor coordination',
        ],
      },
      {
        category: 'AI & Content Development',
        items: [
          'AI-supported workflow',
          'assessment generation',
          'curriculum review',
          'content refinement',
          'copyediting',
        ],
      },
    ],
    projects: [],
  };

  return {
    brief,
    letter: buildAutoDraftLetter(context),
  };
}

function buildAutoDraftPackageContext(flags = {}) {
  const company = String(flags.company || 'unknown-company').trim();
  const role = String(flags.role || 'unknown-role').trim();
  const report = flags.report ? String(flags.report) : '';
  const reportPath = report ? resolve(ROOT, report) : '';
  const reportText = reportPath && existsSync(reportPath) ? readFileSync(reportPath, 'utf-8') : '';
  const reportRiskSignals = extractReportRiskSignals(reportText);
  const recommendedProfileMode = 'tstc';
  const selectedProfileMode = 'tstc';
  const baseCvSource = cvPathForMode(selectedProfileMode);
  const chronology = parseCvChronologyFromPath(baseCvSource);
  return {
    company,
    role,
    report: report || null,
    report_text: reportText,
    report_risk_signals: reportRiskSignals,
    profile_mode: 'tstc',
    recommended_cv_source: cvPathForMode(recommendedProfileMode),
    base_cv_source: baseCvSource,
    focus_roles: chronology.slice(0, 4).map((entry) => ({ company: entry.company, role: entry.role })),
  };
}

function narrativeSegments(parts = []) {
  return (Array.isArray(parts) ? parts : [parts])
    .flatMap((part) => String(part || '').split(/(?<=[.!?])\s+|\n+/))
    .map((segment) => normalizeText(segment))
    .filter(Boolean);
}

function segmentMatchesRiskSignal(segment, signal) {
  if (!segment || !signal || !Array.isArray(signal.tokens)) return false;
  const threshold = Math.min(2, signal.tokens.length);
  return signal.tokens.filter((token) => segment.includes(token)).length >= threshold;
}

function validateQualityPackageForRow(brief, letter, context) {
  const errors = [];
  const warnings = [];
  const baseCvPath = context.base_cv_source || PATHS.cv;
  const baseMap = buildBaseCvExperienceMap(baseCvPath);
  const focusKeys = new Set(
    context.focus_roles.map((entry) => `${normalizeCompany(entry.company)}::${normalizeText(entry.role)}`)
  );
  let changedRoles = 0;
  let changedFocusRoles = 0;

  for (const entry of brief.experience || []) {
    const key = `${normalizeCompany(entry.company)}::${normalizeText(entry.role)}`;
    const base = baseMap.get(key);
    if (!base) continue;
    if (bulletsChangedFromBase(entry.bullets, base.bullets)) {
      changedRoles += 1;
      if (focusKeys.has(key)) changedFocusRoles += 1;
    }
  }

  if (changedRoles < 2) {
    errors.push('Quality package requires meaningful bullet overrides on at least 2 real CV roles.');
  }

  if (changedFocusRoles < 2 && context.focus_roles.length >= 2) {
    errors.push('Quality package requires bullet-level tailoring on at least 2 focus roles from CV chronology.');
  }

  if (Array.isArray(brief.projects) && brief.projects.length > 3) {
    warnings.push('More than 3 projects were provided. Quality packages usually work better with fewer, stronger projects.');
  }

  if (Array.isArray(brief.projects) && brief.projects.length > 0 && changedRoles <= brief.projects.length) {
    warnings.push('Projects appear to be carrying as much or more tailoring weight than work-history bullets.');
  }

  const knownCompanies = new Set(
    parseCvChronologyFromPath(baseCvPath).map((entry) => normalizeCompany(entry.company))
  );
  const focusBulletText = [];
  for (const project of brief.projects || []) {
    if (project.badge && !knownCompanies.has(normalizeCompany(project.badge))) {
      warnings.push(`Project badge "${project.badge}" does not map to a base CV company. Make sure it adds credible evidence.`);
    }
    const projectText = [project.title, project.description, project.tech].filter(Boolean).join(' ');
    if (/\b(chatgpt|gemini|copilot|claude|openai)\b/i.test(projectText)) {
      warnings.push(`Project "${project.title || 'untitled project'}" uses named-product AI/tool language. Prefer workflow and outcomes unless brand names are clearly useful.`);
    }
  }

  for (const entry of brief.experience || []) {
    const key = `${normalizeCompany(entry.company)}::${normalizeText(entry.role)}`;
    if (focusKeys.has(key)) {
      focusBulletText.push(...(entry.bullets || []));
    }
  }

  const cvThemeText = normalizeText([
    brief.summary_text,
    ...focusBulletText,
  ].filter(Boolean).join('\n\n'));
  const cvThemeCoverageCount = (Array.isArray(context.cover_letter_focus_themes) ? context.cover_letter_focus_themes : [])
    .filter((theme) =>
      Array.isArray(theme.tokens) && theme.tokens.some((token) => cvThemeText.includes(normalizeText(token)))
    )
    .length;
  if (Array.isArray(context.cover_letter_focus_themes) && context.cover_letter_focus_themes.length > 0 && cvThemeCoverageCount < Math.min(2, context.cover_letter_focus_themes.length)) {
    warnings.push('CV work-history bullets may not be carrying enough of the role-specific theme coverage. Push more of the tailoring into recent real roles.');
  }

  const summaryScopeVerbCount = (String(brief.summary_text || '').match(/\b(leads?|oversees?|manages?|directs)\b/gi) || []).length;
  if (summaryScopeVerbCount >= 3) {
    warnings.push('CV summary may be stacking too many absolute scope verbs. Consider a slightly more measured summary if the evidence is strong but adjacent.');
  }

  const cvSegments = narrativeSegments([
    brief.summary_text,
    ...(brief.competencies || []),
    ...((brief.projects || []).flatMap((project) => [project.title, project.description, project.tech])),
  ]);
  const cvClaimPattern = /\b(deep|extensive|expert|ownership|owner|primary|federal contract|vha|public trust|clearance|pmp|acquisition|budget(?:ing)?|contract ownership|direct federal|direct contract)\b/i;
  for (const signal of Array.isArray(context.report_risk_signals) ? context.report_risk_signals : []) {
    const segmentMatch = cvSegments.some((segment) =>
      segmentMatchesRiskSignal(segment, signal) && cvClaimPattern.test(segment)
    );
    if (segmentMatch && (signal.kind === 'adjacency' || signal.kind === 'overclaim' || signal.kind === 'gap')) {
      warnings.push(`CV may be overstating a caution or adjacency area from the saved report: "${signal.line}"`);
    }
  }

  if (!Array.isArray(letter.paragraphs) || letter.paragraphs.length < 3 || letter.paragraphs.length > 4) {
    errors.push('Quality package cover letter must use 3-4 body paragraphs.');
  }

  const openingParagraph = Array.isArray(letter.paragraphs) ? String(letter.paragraphs[0] || '') : '';
  const bodyText = Array.isArray(letter.paragraphs) ? letter.paragraphs.join('\n\n') : '';
  const bodyTextNormalized = normalizeText(bodyText);

  if (!hasRoleReference(openingParagraph, context.role)) {
    errors.push(`Cover letter opening paragraph must reference the target role (${context.role}) clearly.`);
  }

  if (!hasCompanyReference(bodyText, context.company)) {
    errors.push(`Cover letter body must mention the target company (${context.company}) directly.`);
  }

  if (/\b(compensation|salary|range|min(?:imum)?|target|pay)\b|\$\d/i.test(bodyText)) {
    errors.push('Cover letter body must not mention compensation.');
  }

  const coverLetterThemes = Array.isArray(context.cover_letter_focus_themes)
    ? context.cover_letter_focus_themes
    : [];
  const matchedThemeCount = coverLetterThemes.filter((theme) =>
    Array.isArray(theme.tokens) && theme.tokens.some((token) => bodyTextNormalized.includes(normalizeText(token)))
  ).length;
  if (coverLetterThemes.length > 0 && matchedThemeCount < Math.min(2, coverLetterThemes.length)) {
    errors.push('Cover letter body must reflect at least 2 role-specific themes from the saved evaluation context.');
  }

  if (/^i am writing to express my interest\b/i.test(openingParagraph.trim())) {
    warnings.push('Cover letter opening is generic. Prefer a sharper, role-specific opening sentence.');
  }

  const finalParagraph = Array.isArray(letter.paragraphs)
    ? String(letter.paragraphs[letter.paragraphs.length - 1] || '')
    : '';
  if (!/(operations?|priorit|curriculum|stakeholder|course|academic|delivery)/i.test(finalParagraph)) {
    warnings.push('Cover letter closing paragraph may be too generic. Reinforce the operational fit before the signoff.');
  }

  const bodyParagraphs = Array.isArray(letter.paragraphs) ? letter.paragraphs.map((paragraph) => normalizeText(paragraph)) : [];
  const boosterPattern = /\b(strong match|well suited|well positioned|my experience includes|my background combines|i would bring|i bring|direct|deep|extensive|expert|owner|ownership|primary)\b/i;
  for (const signal of Array.isArray(context.report_risk_signals) ? context.report_risk_signals : []) {
    const paragraphMatch = bodyParagraphs.some((paragraph) =>
      segmentMatchesRiskSignal(paragraph, signal) && boosterPattern.test(paragraph)
    );
    if (!paragraphMatch) continue;

    if (signal.kind === 'adjacency') {
      warnings.push(`Cover letter may be turning an adjacency/bridge area into a stronger ownership claim than the saved report supports: "${signal.line}"`);
    }

    if (signal.kind === 'overclaim' || signal.kind === 'gap') {
      warnings.push(`Cover letter may be overstating a caution area called out in the saved report: "${signal.line}"`);
    }
  }

  return { errors, warnings, changed_roles: changedRoles, changed_focus_roles: changedFocusRoles };
}

function isTruthyFlagValue(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function summarizePackageReadiness({ errors = [], warnings = [], reviewed = false, chatVerified = false } = {}) {
  const hasErrors = Array.isArray(errors) && errors.length > 0;
  const hasWarnings = Array.isArray(warnings) && warnings.length > 0;
  const reviewedNow = Boolean(reviewed || chatVerified);

  if (hasErrors) {
    return {
      build_state: 'blocked',
      quality_state: 'failed',
      completion_status: 'blocked',
      ready_for_submission: false,
      review_required: false,
      chat_verified: Boolean(chatVerified),
      reviewed: reviewedNow,
    };
  }

  if (!reviewedNow) {
    return {
      build_state: 'built',
      quality_state: 'not_reviewed',
      completion_status: 'needs_chat_review',
      ready_for_submission: false,
      review_required: true,
      chat_verified: Boolean(chatVerified),
      reviewed: false,
    };
  }

  if (hasWarnings && !chatVerified) {
    return {
      build_state: 'built',
      quality_state: 'review_required',
      completion_status: 'needs_chat_review',
      ready_for_submission: false,
      review_required: true,
      chat_verified: false,
      reviewed: true,
    };
  }

  return {
    build_state: 'built',
    quality_state: hasWarnings ? 'reviewed_with_warnings' : 'passed',
    completion_status: 'complete',
    ready_for_submission: true,
    review_required: false,
    chat_verified: Boolean(chatVerified),
    reviewed: true,
  };
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompany(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveProfileMode(raw) {
  return String(raw || '').trim().toLowerCase() === 'tstc' ? 'tstc' : '';
}

function inferProfileMode({ company = '', role = '', contextText = '' } = {}) {
  return 'tstc';
}

function cvPathForMode(mode) {
  return join(ROOT, 'cv-tstc.md');
}

function roleTokens(text) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 3);
}

function roleIdentityTokens(text) {
  const stopwords = new Set([
    'and', 'the', 'for', 'with', 'role', 'position', 'of', 'to', 'in',
    'senior', 'jr', 'sr', 'principal', 'director', 'manager', 'lead',
    'head', 'associate', 'ii', 'iii', 'iv',
  ]);
  return [...new Set(
    normalizeText(text)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !stopwords.has(token))
  )];
}

function roleSimilarity(a, b) {
  const setA = new Set(roleIdentityTokens(a));
  const setB = new Set(roleIdentityTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap++;
  }
  return overlap / Math.min(setA.size, setB.size);
}

function readProfile() {
  if (!existsSync(PROFILE_FILE)) return {};
  return parseSimpleYaml(readFileSync(PROFILE_FILE, 'utf-8'));
}

function parseApplications() {
  if (!existsSync(APPS_FILE)) return [];
  const lines = readFileSync(APPS_FILE, 'utf-8').split(/\r?\n/);
  const rows = [];

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('---') || line.includes('| # |')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 10) continue;

    const num = parseInt(parts[1], 10);
    if (Number.isNaN(num)) continue;

    rows.push({
      num,
      date: parts[2],
      company: parts[3],
      role: parts[4],
      score: parts[5],
      status: parts[6],
      pdf: parts[7],
      report: parts[8],
      notes: parts[9] || '',
    });
  }

  return rows;
}

function parsePipeline() {
  if (!existsSync(PIPELINE_FILE)) return [];
  const lines = readFileSync(PIPELINE_FILE, 'utf-8').split(/\r?\n/);
  const items = [];

  for (const line of lines) {
    const match = line.match(/^- \[([ x!])\] (.+)$/);
    if (!match) continue;

    const marker = match[1];
    const body = match[2];
    const parts = body.split(' | ').map((part) => part.trim());
    const url = parts[0] || '';
    const company = parts[1] || '';
    const title = parts[2] || '';
    const note = parts.slice(3).join(' | ');

    items.push({
      marker,
      state: marker === ' ' ? 'pending' : marker === 'x' ? 'processed' : 'issue',
      url,
      company,
      title,
      note,
      raw: line,
    });
  }

  return items;
}

function resolveStructuredPayload(flags = {}, key) {
  const jsonValue = flags[`${key}-json`] || flags[`${key}_json`];
  if (jsonValue) return String(jsonValue);

  const fileValue = flags[`${key}-file`] || flags[`${key}_file`];
  if (fileValue) {
    const filePath = resolve(String(fileValue));
    if (!existsSync(filePath)) {
      throw new Error(`${key} file not found: ${filePath}`);
    }
    return readFileSync(filePath, 'utf-8');
  }

  return '';
}

function buildPackageFromStructuredInput(flags = {}) {
  const briefJson = resolveStructuredPayload(flags, 'brief');
  const letterJson = resolveStructuredPayload(flags, 'letter');
  if (!briefJson || !letterJson) {
    throw new Error('Hybrid package build requires both brief and letter payloads.');
  }

  const brief = safeJsonParse(briefJson, 'brief');
  const letter = safeJsonParse(letterJson, 'letter');
  const profile = readYaml(PATHS.profile, {});
  const candidateSlug = slugify(profile?.candidate?.full_name || 'candidate');
  const company = String(flags.company || 'unknown-company').trim();
  const role = String(flags.role || 'unknown-role').trim();
  const companySlug = slugify(company || 'unknown-company');
  const date = String(flags.date || todayIso()).trim();
  const format = String(
    flags.format
      || brief.format
      || letter.format
      || inferPaperFormat(String(flags.location || profile?.candidate?.location || ''), 'letter')
  ).toLowerCase();
  const report = flags.report ? String(flags.report) : null;
  const url = flags.url ? String(flags.url) : null;
  const dryRun = String(flags['dry-run'] || flags.dry_run || '').toLowerCase() === 'true';
  const reportPath = report ? resolve(ROOT, report) : '';
  const reportText = reportPath && existsSync(reportPath) ? readFileSync(reportPath, 'utf-8') : '';
  const profileMode = 'tstc';
  const cvSource = cvPathForMode(profileMode);
  const validationErrors = [
    ...validateHybridBrief(brief, cvSource),
    ...validateHybridLetter(letter),
  ];
  const readiness = summarizePackageReadiness({
    errors: validationErrors,
    warnings: [],
    reviewed: isTruthyFlagValue(flags.quality_reviewed || flags.qualityReviewed || flags.chat_verified || flags.chatVerified),
    chatVerified: isTruthyFlagValue(flags.chat_verified || flags.chatVerified),
  });

  if (!company) throw new Error('company is required for hybrid package build.');
  if (!role) throw new Error('role is required for hybrid package build.');
  if (!['letter', 'a4'].includes(format)) {
    throw new Error(`Unsupported format "${format}". Use letter or a4.`);
  }

  brief.format = format;
  letter.format = format;
  brief.cv_path = cvSource;

  const briefPath = join(OUTPUT_DIR, `cv-${candidateSlug}-${companySlug}-${date}.brief.json`);
  const letterPath = join(OUTPUT_DIR, `cover-letter-${candidateSlug}-${companySlug}-${date}.json`);
  const cvHtmlPath = join(OUTPUT_DIR, `cv-${candidateSlug}-${companySlug}-${date}.html`);
  const cvPdfPath = join(OUTPUT_DIR, `cv-${candidateSlug}-${companySlug}-${date}.pdf`);
  const coverHtmlPath = join(OUTPUT_DIR, `cover-letter-${candidateSlug}-${companySlug}-${date}.html`);
  const coverPdfPath = join(OUTPUT_DIR, `cover-letter-${candidateSlug}-${companySlug}-${date}.pdf`);

  const payload = {
    action: 'package',
    ok: true,
    mode: 'hybrid',
    company,
    role,
    cv_source: cvSource,
    format,
    date,
      report,
      url,
      quality_gate: readiness,
      outputs: {
        brief_json: briefPath,
        cv_html: cvHtmlPath,
        cv_pdf: cvPdfPath,
      cover_letter_json: letterPath,
      cover_letter_html: coverHtmlPath,
      cover_letter_pdf: coverPdfPath,
    },
  };

  if (validationErrors.length > 0) {
    return {
      action: 'package',
      ok: false,
      mode: 'hybrid',
      error: 'Hybrid package payload failed validation.',
      validation_errors: validationErrors,
      quality_gate: readiness,
      ...readiness,
      expected_shapes: {
        brief: {
          summary_text: 'string',
          competencies: ['string'],
          experience: [{ company: 'string', role: 'string', bullets: ['string'] }],
          projects: [{ title: 'string', badge: 'string?', description: 'string', tech: 'string?' }],
          skills: [{ category: 'string', items: ['string'] }],
        },
        letter: {
          recipient_lines: ['string'],
          greeting: 'string',
          paragraphs: ['string', 'string'],
          closing: 'string',
        },
      },
    };
  }

  if (dryRun) {
    return {
      ...payload,
      dry_run: true,
      quality_gate: readiness,
      ...readiness,
      brief_preview: brief,
      letter_preview: letter,
    };
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`, 'utf-8');
  writeFileSync(letterPath, `${JSON.stringify(letter, null, 2)}\n`, 'utf-8');

  const cvRun = runNodeScript('build-tailored-cv.mjs', [
    briefPath,
    '--cv-path', cvSource,
    '--html', cvHtmlPath,
    '--pdf', cvPdfPath,
    `--format=${format}`,
  ]);
  if (!cvRun.ok) {
    return {
      action: 'package',
      ok: false,
      mode: 'hybrid',
      exit_code: cvRun.status,
      stdout: cvRun.stdout.trim(),
      stderr: cvRun.stderr.trim(),
      failed_step: 'build-tailored-cv',
    };
  }

  const letterRun = runNodeScript('build-cover-letter.mjs', [
    letterPath,
    '--html', coverHtmlPath,
    '--pdf', coverPdfPath,
    `--format=${format}`,
  ]);
  if (!letterRun.ok) {
    return {
      action: 'package',
      ok: false,
      mode: 'hybrid',
      exit_code: letterRun.status,
      stdout: letterRun.stdout.trim(),
      stderr: letterRun.stderr.trim(),
      failed_step: 'build-cover-letter',
    };
  }

  const pdfUpdated = updateTrackerPdfStatus(company, role, '✅');
  const verifyRun = runNodeScript('verify-pipeline.mjs');

  logAction({
    actor: 'chat-ops',
    action: 'hybrid-package',
    company,
    role,
    report,
    url,
    outputs: payload.outputs,
    pdf_updated: pdfUpdated,
    verify_ok: verifyRun.ok,
  });

  return {
    ...payload,
    dry_run: false,
    quality_gate: readiness,
    ...readiness,
    pdf_updated: pdfUpdated,
    verify: {
      ok: verifyRun.ok,
      exit_code: verifyRun.status,
      stdout: verifyRun.stdout.trim(),
      stderr: verifyRun.stderr.trim(),
    },
  };
}

function parseScanHistory() {
  if (!existsSync(SCAN_HISTORY_FILE)) return [];
  const lines = readFileSync(SCAN_HISTORY_FILE, 'utf-8').split(/\r?\n/).slice(1);
  return lines
    .filter(Boolean)
    .map((line) => {
      const [url, first_seen, portal, title, company, status] = line.split('\t');
      return { url, first_seen, portal, title, company, status };
    });
}

function parseScoreValue(score) {
  const match = String(score || '').match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

function extractReportPath(reportCell) {
  const match = String(reportCell || '').match(/\]\(([^)]+)\)/);
  return match ? match[1] : null;
}

function absoluteReportPath(reportCell) {
  const rel = extractReportPath(reportCell);
  return rel ? join(ROOT, rel) : null;
}

function runNodeScript(scriptName, args = []) {
  const result = spawnSync(process.execPath, [join(ROOT, scriptName), ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 300000,
  });

  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function parseScanSummary(stdout) {
  const numberAfter = (label) => {
    const regex = new RegExp(`${label}:\\s+(\\d+)`, 'i');
    const match = stdout.match(regex);
    return match ? parseInt(match[1], 10) : null;
  };

  const newOffers = [];
  const lines = stdout.split(/\r?\n/);
  let inNewOffers = false;
  for (const line of lines) {
    if (/^New offers:/i.test(line.trim())) {
      inNewOffers = true;
      continue;
    }
    if (inNewOffers) {
      if (!line.trim()) break;
      const match = line.match(/^\s+\+\s+(.+?)\s+\|\s+(.+?)\s+\|\s+(.+)$/);
      if (match) {
        newOffers.push({
          company: match[1].trim(),
          title: match[2].trim(),
          location: match[3].trim(),
        });
      }
    }
  }

  return {
    companies_scanned: numberAfter('Companies scanned'),
    queries_executed: numberAfter('Queries executed'),
    total_jobs_found: numberAfter('Total jobs found'),
    filtered_by_title: numberAfter('Filtered by title'),
    filtered_by_role: numberAfter('Filtered by role'),
    filtered_by_rank: numberAfter('Filtered by rank'),
    filtered_by_geography: numberAfter('Filtered by geography'),
    duplicates: numberAfter('Duplicates'),
    new_offers_added: numberAfter('New offers added'),
    listed_new_offers: newOffers,
  };
}

function parseLivenessOutput(stdout, urls) {
  const results = [];
  const lines = stdout.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^[^\s]+\s+(active|expired|uncertain)\s+(\S+)/i);
    if (!match) continue;
    const result = match[1].toLowerCase();
    const url = match[2];
    let reason = '';
    if (lines[i + 1] && /^\s{5,}\S/.test(lines[i + 1])) {
      reason = lines[i + 1].trim();
    }
    results.push({ url, result, reason });
  }

  const missing = urls.filter((url) => !results.some((entry) => entry.url === url));
  for (const url of missing) {
    results.push({ url, result: 'unknown', reason: 'Result not parsed from liveness output.' });
  }

  return results;
}

function latestFilesInDir(dir, predicate) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && predicate(path))
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function pickOutputFile(files, extension, patterns) {
  const normalizedExt = extension.toLowerCase();
  for (const file of files) {
    const name = basename(file.path).toLowerCase();
    if (!name.endsWith(normalizedExt)) continue;
    if (patterns.some((pattern) => name === pattern || name.includes(pattern))) {
      return file.path;
    }
  }
  return null;
}

function summarizeTracker(rows, flags = {}) {
  const statusFilter = flags.status ? String(flags.status).toLowerCase() : null;
  const limit = flags.limit ? parseInt(flags.limit, 10) : 10;
  const minScore = flags['min-score'] ? parseFloat(flags['min-score']) : null;

  let filtered = rows.slice();
  if (statusFilter) {
    filtered = filtered.filter((row) => row.status.toLowerCase() === statusFilter);
  }
  if (minScore !== null && !Number.isNaN(minScore)) {
    filtered = filtered.filter((row) => (parseScoreValue(row.score) ?? 0) >= minScore);
  }

  filtered.sort((a, b) => b.num - a.num);
  const items = filtered.slice(0, Number.isNaN(limit) ? 10 : limit).map((row) => ({
    num: row.num,
    date: row.date,
    company: row.company,
    role: row.role,
    score: row.score,
    status: row.status,
    pdf: row.pdf,
    notes: row.notes,
    report_path: absoluteReportPath(row.report),
  }));

  const statusCounts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  return {
    total: rows.length,
    filtered_total: filtered.length,
    status_counts: statusCounts,
    items,
  };
}

function summarizeInbox(items) {
  const pending = items.filter((item) => item.state === 'pending');
  const issue = items.filter((item) => item.state === 'issue');
  const processed = items.filter((item) => item.state === 'processed');

  return {
    total: items.length,
    pending_count: pending.length,
    issue_count: issue.length,
    processed_count: processed.length,
    pending,
    issue,
  };
}

function buildQuickApplySummary() {
  const profile = readProfile();
  const slug = slugify(profile?.candidate?.full_name || '');
  const files = latestFilesInDir(OUTPUT_DIR, () => true);

  const cvPdf = pickOutputFile(files, '.pdf', [`cv-${slug}.pdf`, 'cv-mark-wright.pdf', 'cv-']);
  const cvHtml = pickOutputFile(files, '.html', [`cv-${slug}.html`, 'cv-mark-wright.html', 'cv-']);
  const coverPdf = pickOutputFile(files, '.pdf', [`cover-letter-${slug}.pdf`, 'cover-letter-mark-wright.pdf', 'cover-letter-']);
  const coverHtml = pickOutputFile(files, '.html', [`cover-letter-${slug}.html`, 'cover-letter-mark-wright.html', 'cover-letter-']);
  const coverJson = pickOutputFile(files, '.json', [`cover-letter-${slug}.json`, 'cover-letter-mark-wright.json', 'cover-letter-']);

  return {
    candidate: profile?.candidate?.full_name || null,
    quick_apply: {
      cv_pdf: cvPdf,
      cv_html: cvHtml,
      cover_letter_pdf: coverPdf,
      cover_letter_html: coverHtml,
      cover_letter_json: coverJson,
    },
    output_file_count: files.length,
  };
}

function buildCvChronologySummary() {
  const items = parseBaseCvChronology();
  return {
    action: 'cv-chronology',
    total_roles: items.length,
    items,
  };
}

function buildBaseCvSummary() {
  const path = resolveReadableRepoPath('cv.md');
  const content = readFileSync(path, 'utf-8');
  return {
    action: 'base-cv',
    path: 'cv.md',
    content,
    chronology: parseBaseCvChronology(),
  };
}

function buildProfileContextSummary() {
  const files = [
    ['config/profile.yml', PATHS.profile],
    ['modes/_profile.md', PATHS.userProfile],
    ['article-digest.md', PATHS.articleDigest],
  ];

  return {
    action: 'profile-context',
    files: files
      .filter(([, abs]) => existsSync(abs))
      .map(([rel, abs]) => ({
        path: rel,
        content: readFileSync(abs, 'utf-8'),
      })),
  };
}

function buildTrackerRowSummary(flags = {}) {
  const num = parseInt(flags.num || '', 10);
  if (Number.isNaN(num)) {
    throw new Error('tracker-row requires a numeric num.');
  }
  const row = parseApplications().find((item) => item.num === num);
  if (!row) {
    throw new Error(`Tracker row ${num} not found.`);
  }
  return {
    action: 'tracker-row',
    row: {
      ...row,
      report_path: absoluteReportPath(row.report),
    },
  };
}

function buildReportSummary(flags = {}) {
  const inputPath = flags.path || flags.report;
  if (!inputPath) {
    throw new Error('report requires a path.');
  }
  const path = resolveReadableRepoPath(inputPath);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Report "${inputPath}" does not exist.`);
  }
  ensureReadableTextFile(path);
  return {
    action: 'report',
    path: path.slice(ROOT.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'),
    content: readFileSync(path, 'utf-8'),
  };
}

function extractReportUrl(reportContent) {
  const match = String(reportContent || '').match(/^\*\*URL:\*\*\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function buildQualityPackageForRow(flags = {}) {
  const num = parseInt(flags.num || '', 10);
  if (Number.isNaN(num)) {
    return { ok: false, error: 'quality-package-row requires a numeric num.' };
  }

  const row = parseApplications().find((item) => item.num === num);
  if (!row) {
    return { ok: false, error: `Tracker row ${num} not found.` };
  }

  const reportPath = absoluteReportPath(row.report);
  const reportContent = reportPath && existsSync(reportPath) ? readFileSync(reportPath, 'utf-8') : null;
  const reportRelPath = reportPath
    ? reportPath.slice(ROOT.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    : null;
  const reportUrl = reportContent ? extractReportUrl(reportContent) : null;
  const reportRiskSignals = extractReportRiskSignals(reportContent || '');
  const recommendedProfileMode = 'tstc';
  const selectedProfileMode = 'tstc';
  const baseCvSource = cvPathForMode(selectedProfileMode);
  const chronology = parseCvChronologyFromPath(baseCvSource);
  const profileContext = buildProfileContextSummary();
  const rules = buildQualityPackageRules(row, chronology, reportContent || '');
  const context = {
    num,
    company: row.company,
    role: row.role,
    score: row.score,
    status: row.status,
    pdf: row.pdf,
    notes: row.notes,
    report_path: reportRelPath,
    report_url: reportUrl,
    cover_letter_focus_themes: inferCoverLetterThemes(reportContent || '', row),
    report_risk_signals: reportRiskSignals,
    profile_mode: 'tstc',
    recommended_cv_source: cvPathForMode(recommendedProfileMode),
    base_cv_source: baseCvSource,
    focus_roles: chronology.slice(0, 4).map((entry) => ({ company: entry.company, role: entry.role })),
  };
  const briefJson = resolveStructuredPayload(flags, 'brief');
  const letterJson = resolveStructuredPayload(flags, 'letter');
  const autoDraftRequested = isTruthyFlag(flags.auto_draft || flags.autoDraft || flags.draft);

  if (!briefJson || !letterJson) {
    if (autoDraftRequested) {
      const drafted = buildAutoDraftQualityPackage(context, chronology);
      return buildQualityPackageForRow({
        ...flags,
        'profile-mode': selectedProfileMode,
        'brief-json': JSON.stringify(drafted.brief),
        'letter-json': JSON.stringify(drafted.letter),
      });
    }

    return {
      action: 'quality-package-row',
      ok: true,
      mode: 'context',
      context: {
        base_cv_source: baseCvSource,
        tracker_row: {
          ...row,
          report_path: reportRelPath,
          url: reportUrl,
        },
        cv_chronology: chronology,
        report: reportContent ? {
          path: reportRelPath,
          content: reportContent,
        } : null,
        profile_context: profileContext.files,
      },
      quality_rules: rules,
      next_step: 'Draft builder-ready brief and letter JSON, or call quality-package-row again with auto_draft=true to let the repo draft them from the active TSTC lane.',
    };
  }

  let brief;
  let letter;
  try {
    brief = safeJsonParse(briefJson, 'brief');
    letter = safeJsonParse(letterJson, 'letter');
  } catch (err) {
    return {
      action: 'quality-package-row',
      ok: false,
      mode: 'hybrid-quality',
      error: err.message,
    };
  }

  const quality = validateQualityPackageForRow(brief, letter, context);
  const readiness = summarizePackageReadiness({
    errors: quality.errors,
    warnings: quality.warnings,
    reviewed: true,
    chatVerified: isTruthyFlagValue(flags.chat_verified || flags.chatVerified),
  });
  if (quality.errors.length > 0) {
    return {
      action: 'quality-package-row',
      ok: false,
      mode: 'hybrid-quality',
      error: 'Quality package payload failed package-quality checks.',
      quality_errors: quality.errors,
      quality_warnings: quality.warnings,
      quality_gate: readiness,
      ...readiness,
      quality_rules: rules,
      context,
    };
  }

  const mergedFlags = {
    ...flags,
    company: row.company,
    role: row.role,
    report: reportRelPath || flags.report,
    url: reportUrl || flags.url,
    'brief-json': briefJson,
    'letter-json': letterJson,
  };
  const packageResult = buildPackageFromStructuredInput(mergedFlags);
  return {
    ...packageResult,
    action: 'quality-package-row',
    mode: packageResult.mode === 'hybrid' ? 'hybrid-quality' : packageResult.mode,
    quality_warnings: quality.warnings,
    quality_stats: {
      changed_roles: quality.changed_roles,
      changed_focus_roles: quality.changed_focus_roles,
    },
    quality_gate: readiness,
    ...readiness,
    quality_rules: rules,
    context,
  };
}

function buildPipelineItemSummary(flags = {}) {
  const url = String(flags.url || '').trim();
  if (!url) {
    throw new Error('pipeline-item requires a url.');
  }
  const item = parsePipeline().find((entry) => entry.url === url);
  if (!item) {
    throw new Error(`Pipeline item not found for URL: ${url}`);
  }
  return {
    action: 'pipeline-item',
    item,
  };
}

function listRepoDir(flags = {}) {
  const dirPath = resolveReadableRepoPath(flags.path || '.');
  const depth = Math.max(0, Math.min(4, parseInt(flags.depth || '1', 10) || 1));

  function visit(currentPath, currentDepth) {
    return readdirSync(currentPath)
      .map((name) => join(currentPath, name))
      .filter((entryPath) => !isBlockedReadPath(entryPath))
      .map((entryPath) => {
        const stats = statSync(entryPath);
        const rel = entryPath.slice(ROOT.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
        const item = {
          path: rel || '.',
          name: basename(entryPath),
          type: stats.isDirectory() ? 'directory' : 'file',
        };
        if (stats.isDirectory() && currentDepth < depth) {
          item.children = visit(entryPath, currentDepth + 1);
        } else if (!stats.isDirectory()) {
          item.size = stats.size;
          item.ext = extnameSafe(entryPath);
        }
        return item;
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  return {
    action: 'list-repo-dir',
    root: ROOT,
    path: dirPath.slice(ROOT.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') || '.',
    depth,
    items: visit(dirPath, 1),
  };
}

function readRepoFile(flags = {}) {
  if (!flags.path) {
    throw new Error('read-file requires a path.');
  }
  const filePath = resolveReadableRepoPath(flags.path);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`File "${flags.path}" does not exist or is not a file.`);
  }
  ensureReadableTextFile(filePath);

  const startLine = Math.max(1, parseInt(flags['start-line'] || flags.start_line || '1', 10) || 1);
  const maxLines = Math.max(1, Math.min(400, parseInt(flags['max-lines'] || flags.max_lines || '200', 10) || 200));
  const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/);
  const slice = lines.slice(startLine - 1, startLine - 1 + maxLines);

  return {
    action: 'read-repo-file',
    path: filePath.slice(ROOT.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'),
    start_line: startLine,
    end_line: startLine + slice.length - 1,
    total_lines: lines.length,
    content: slice.join('\n'),
  };
}

function searchRepoText(flags = {}) {
  const query = String(flags.query || '').trim();
  if (!query) {
    throw new Error('search-repo requires a non-empty query.');
  }

  const basePath = resolveReadableRepoPath(flags.path || '.');
  const limit = Math.max(1, Math.min(100, parseInt(flags.limit || '30', 10) || 30));
  const result = spawnSync('rg', [
    '--line-number',
    '--with-filename',
    '--color', 'never',
    '--max-count', String(limit),
    query,
    basePath,
  ], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 300000,
  });

  const matches = (result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => {
      const match = line.match(/^(.*?):(\d+):(.*)$/);
      if (!match) return null;
      const [, absPath, lineNumber, text] = match;
      if (isBlockedReadPath(absPath)) return null;
      return {
        path: absPath.slice(ROOT.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'),
        line: parseInt(lineNumber, 10),
        text,
      };
    })
    .filter(Boolean);

  return {
    action: 'search-repo',
    query,
    path: basePath.slice(ROOT.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') || '.',
    total_matches: matches.length,
    matches,
    stderr: (result.stderr || '').trim(),
  };
}

function buildProjectProfileSummary() {
  const run = runNodeScript('generate-project-profile.mjs');
  if (!run.ok) {
    return {
      ok: false,
      exit_code: run.status,
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    };
  }

  try {
    return {
      ok: true,
      ...JSON.parse(run.stdout),
    };
  } catch {
    return {
      ok: false,
      exit_code: run.status,
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    };
  }
}

function titleSignalScore(title) {
  const lower = normalizeText(title);
  if (PRIMARY_TITLE_SIGNALS.some((signal) => lower.includes(signal))) return 45;
  if (SECONDARY_TITLE_SIGNALS.some((signal) => lower.includes(signal))) return 35;
  if (ADJACENT_TITLE_SIGNALS.some((signal) => lower.includes(signal))) return 24;
  return 10;
}

function daysSince(dateString) {
  if (!dateString) return null;
  const parsed = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor((Date.now() - parsed.getTime()) / 86400000);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function buildAttentionReport(rows) {
  const applied = rows
    .filter((row) => row.status === 'Applied')
    .sort((a, b) => b.num - a.num);
  const evaluated = rows
    .filter((row) => row.status === 'Evaluated')
    .sort((a, b) => (parseScoreValue(b.score) ?? 0) - (parseScoreValue(a.score) ?? 0));

  const attentionNeeded = [];
  const waiting = [];
  const packageGaps = [];

  for (const row of [...applied, ...evaluated]) {
    if (row.pdf !== '✅') {
      packageGaps.push({
        num: row.num,
        company: row.company,
        role: row.role,
        status: row.status,
        pdf: row.pdf,
        report_path: absoluteReportPath(row.report),
      });
    }
  }

  for (const row of applied) {
    const ageDays = daysSince(row.date);
    const note = String(row.notes || '').toLowerCase();
    const reasons = [];

    if (row.pdf !== '✅') reasons.push('No tailored PDF package is recorded in the tracker.');
    if (note.includes('recruiter follow-up')) reasons.push('Tracker notes mention recruiter follow-up.');
    if (note.includes('applied generically')) reasons.push('Tracker notes say the role was applied to generically.');
    if (note.includes('you replied')) reasons.push('Tracker notes mention that you already replied, so follow-through may matter.');
    if (ageDays !== null && ageDays >= 28) reasons.push(`Application is ${ageDays} days old with no newer tracker status yet.`);

    const enriched = {
      num: row.num,
      date: row.date,
      age_days: ageDays,
      company: row.company,
      role: row.role,
      score: row.score,
      pdf: row.pdf,
      notes: row.notes,
      report_path: absoluteReportPath(row.report),
      reasons,
    };

    if (reasons.length > 0) attentionNeeded.push(enriched);
    else waiting.push(enriched);
  }

  return {
    heuristics: [
      'Flags missing PDF/package records on Applied or Evaluated rows.',
      'Flags Applied rows whose notes mention recruiter follow-up or generic application.',
      'Flags Applied rows older than 28 days with no newer tracker status.',
    ],
    attention_needed: attentionNeeded,
    waiting,
    evaluated_awaiting_decision: evaluated.map((row) => ({
      num: row.num,
      date: row.date,
      age_days: daysSince(row.date),
      company: row.company,
      role: row.role,
      score: row.score,
      pdf: row.pdf,
      notes: row.notes,
      report_path: absoluteReportPath(row.report),
    })),
    package_gaps: packageGaps,
  };
}

function buildRepoSummary() {
  const profile = buildProjectProfileSummary();
  const trackerRows = parseApplications();
  const pipelineItems = parsePipeline();
  const trackerSummary = summarizeTracker(trackerRows, {});
  const inboxSummary = summarizeInbox(pipelineItems);
  const attention = buildAttentionReport(trackerRows);

  const inconsistencies = [];
  if (profile.ok && Array.isArray(profile.inconsistencies)) {
    inconsistencies.push(...profile.inconsistencies);
  }

  if (inboxSummary.issue_count > 0) {
    inconsistencies.push(`${inboxSummary.issue_count} inbox item(s) are already marked as issues.`);
  }

  return {
    action: 'repo-summary',
    generated_at: new Date().toISOString(),
    profile: profile.ok ? profile : null,
    tracker: {
      total: trackerSummary.total,
      status_counts: trackerSummary.status_counts,
    },
    applied: {
      total: trackerRows.filter((row) => row.status === 'Applied').length,
      attention_needed: attention.attention_needed,
      waiting: attention.waiting,
    },
    evaluated: {
      total: trackerRows.filter((row) => row.status === 'Evaluated').length,
      awaiting_decision: attention.evaluated_awaiting_decision,
    },
    inbox: inboxSummary,
    package_gaps: attention.package_gaps,
    inconsistencies,
  };
}

function historicalPenalty(item, trackerRows, scanHistory) {
  const company = normalizeCompany(item.company);
  const title = item.title || '';
  let penalty = 0;
  const reasons = [];

  for (const row of trackerRows) {
    if (normalizeCompany(row.company) !== company) continue;
    const similarity = roleSimilarity(title, row.role);
    if (similarity < 0.6) continue;

    if (['SKIP', 'Discarded', 'Rejected'].includes(row.status)) {
      penalty += 20;
      reasons.push(`Similar ${row.company} role already ended as ${row.status}.`);
    } else if (['Applied', 'Interview', 'Offer', 'Responded'].includes(row.status)) {
      penalty += 10;
      reasons.push(`Similar ${row.company} role already exists in tracker as ${row.status}.`);
    } else if (row.status === 'Evaluated') {
      penalty += 8;
      reasons.push(`Similar ${row.company} role was already evaluated.`);
    }
  }

  for (const entry of scanHistory) {
    if (normalizeCompany(entry.company) !== company) continue;
    const similarity = roleSimilarity(title, entry.title);
    if (similarity < 0.6) continue;

    if (['expired', 'filled', 'duplicate', 'inaccessible'].includes(entry.status)) {
      penalty += 12;
      reasons.push(`Recent scan history for a similar role was ${entry.status}.`);
      break;
    }
  }

  return { penalty, reasons };
}

function triageItems(items, trackerRows, scanHistory, options = {}) {
  const includeIssues = Boolean(options.includeIssues);
  const candidates = items.filter((item) => includeIssues || item.state === 'pending');

  const results = candidates.map((item) => {
    const reasons = [];
    let score = titleSignalScore(item.title);

    const lowerTitle = normalizeText(item.title);
    if (lowerTitle.includes('senior') || lowerTitle.includes('director') || lowerTitle.includes('manager') || lowerTitle.includes('lead')) {
      score += 10;
      reasons.push('Seniority looks aligned with target level.');
    }
    if (DOWNLEVEL_SIGNALS.some((signal) => lowerTitle.includes(signal))) {
      score -= 22;
      reasons.push('Title reads below target level.');
    }
    if (HIGH_RISK_SIGNALS.some((signal) => lowerTitle.includes(signal))) {
      score -= 20;
      reasons.push('Title suggests a weaker-fit lane based on prior filtering rules.');
    }
    if (item.state === 'issue') {
      score -= 40;
      reasons.push(item.note || 'Inbox item is already marked as an issue.');
    }

    const history = historicalPenalty(item, trackerRows, scanHistory);
    score -= history.penalty;
    reasons.push(...history.reasons);

    score = Math.max(0, Math.min(100, score));

    let disposition = 'reject';
    if (score >= 65) disposition = 'shortlist';
    else if (score >= 45) disposition = 'review';

    if (item.state === 'issue') disposition = 'reject';

    return {
      ...item,
      heuristic_score: score,
      disposition,
      reasons,
    };
  });

  return {
    total_considered: results.length,
    shortlist: results.filter((item) => item.disposition === 'shortlist').sort((a, b) => b.heuristic_score - a.heuristic_score),
    review: results.filter((item) => item.disposition === 'review').sort((a, b) => b.heuristic_score - a.heuristic_score),
    reject: results.filter((item) => item.disposition === 'reject').sort((a, b) => b.heuristic_score - a.heuristic_score),
  };
}

function markPipelineIssues(livenessResults) {
  if (!existsSync(PIPELINE_FILE)) return false;
  const lines = readFileSync(PIPELINE_FILE, 'utf-8').split(/\r?\n/);
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    for (const result of livenessResults) {
      if (result.result !== 'expired') continue;
      if (!lines[i].startsWith('- [ ]')) continue;
      if (!lines[i].includes(result.url)) continue;
      lines[i] = lines[i].replace(/^- \[ \]/, '- [!]') + ` | Liveness check marked this URL expired: ${result.reason}`;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(PIPELINE_FILE, lines.join('\n'));
  }

  return changed;
}

function buildHelp() {
  return {
    name: 'chat-ops',
    purpose: 'Explicit frontend command surface for operating career-ops from ChatGPT or another conversational layer.',
    actions: [
      { action: 'help', description: 'Show available actions and flags.' },
      { action: 'scan', description: 'Run the existing broad scanner and return a compact summary plus new inbox items.' },
      { action: 'scan-safe', description: 'Run scan, then Playwright liveness-check any newly added URLs. Optional --mark-expired to convert dead inbox items to [!].' },
      { action: 'inbox', description: 'Show pending and issue items from data/pipeline.md.' },
      { action: 'tracker', description: 'Show tracker summary. Optional --status Applied|Evaluated|Interview etc, --limit N, --min-score 4.0.' },
      { action: 'applied', description: 'Alias for tracker --status Applied.' },
      { action: 'evaluated', description: 'Alias for tracker --status Evaluated.' },
      { action: 'shortlist', description: 'Heuristic triage of inbox items into shortlist, review, and reject buckets. Optional --include-issues.' },
      { action: 'evaluate', description: 'Run the Gemini-backed evaluation pipeline for a JD URL or file. Supports --url, --jd-file, and optional --with-package.' },
      { action: 'record-evaluation', description: 'Persist a Chat-authored evaluation report and tracker row without using Gemini. Supports --company, --role, --score, --report-body-file or --report-body, plus metadata fields.' },
      { action: 'package', description: 'Generate a tailored CV + cover letter package from a JD file and optional report context.' },
      { action: 'package-schema', description: 'Return the strict expected JSON schema shape for hybrid package brief/letter payloads.' },
      { action: 'quality-package-row', description: 'High-level package workflow for an existing tracker row. Without JSON inputs, returns row context + quality rules. With --brief-json and --letter-json, runs quality checks and builds the package.' },
      { action: 'apply-prep', description: 'Evaluate a role and generate the tailored package in one step.' },
      { action: 'update-application', description: 'Update an existing tracker row by number. Supports --num N, optional --status STATE, --pdf ✅|❌, --notes TEXT, and --replace-notes.' },
      { action: 'update-inbox', description: 'Update a pipeline inbox item by URL. Supports --url URL, --state pending|processed|issue, optional --note TEXT, and --replace-note.' },
      { action: 'mark-applied', description: 'Convenience helper: set an existing tracker row to Applied and optionally append a note or PDF status.' },
      { action: 'mark-inbox-stale', description: 'Convenience helper: mark a pipeline URL as an issue/stale item with a note.' },
      { action: 'verify', description: 'Run verify-pipeline.mjs and return pass/fail with captured output.' },
      { action: 'sync-check', description: 'Run cv-sync-check.mjs and return pass/fail with captured output.' },
      { action: 'project-profile', description: 'Generate and return the ChatGPT-friendly markdown profile mirror.' },
      { action: 'repo-summary', description: 'Bundle profile lanes, tracker counts, attention-needed applications, evaluated roles, inbox state, and inconsistencies.' },
      { action: 'attention-report', description: 'Return read-only attention buckets for applied and evaluated roles, plus package gaps.' },
      { action: 'base-cv', description: 'Return the full base CV content and parsed chronology.' },
      { action: 'cv-chronology', description: 'Return parsed company/role chronology and bullets from cv.md.' },
      { action: 'profile-context', description: 'Return raw profile context files (profile.yml, _profile.md, article-digest.md).' },
      { action: 'tracker-row', description: 'Return a single tracker row by number.' },
      { action: 'report', description: 'Return raw content of a report markdown file.' },
      { action: 'pipeline-item', description: 'Return a single pipeline item by URL.' },
      { action: 'list-repo-dir', description: 'List repo directories/files through a controlled read surface. Supports --path and --depth.' },
      { action: 'read-file', description: 'Read a repo text file with line offsets. Supports --path, --start-line, and --max-lines.' },
      { action: 'search-repo', description: 'Search repo text with ripgrep. Supports --query, optional --path and --limit.' },
      { action: 'patterns', description: 'Return structured pattern analysis from analyze-patterns.mjs.' },
      { action: 'quick-apply', description: 'Return the current general-use resume and cover-letter artifact paths from output/.' },
      { action: 'liveness', description: 'Run Playwright liveness on one or more URLs.' },
      { action: 'reports', description: 'Show recent reports. Optional --limit N.' },
    ],
    examples: [
      'node chat-ops.mjs scan-safe --mark-expired',
      'node chat-ops.mjs tracker --status Applied --limit 8',
      'node chat-ops.mjs quick-apply',
      'node chat-ops.mjs liveness https://example.com/job/123',
      'node chat-ops.mjs update-application --num 73 --status Applied --notes "Applied via company site"',
      'node chat-ops.mjs mark-inbox-stale --url https://example.com/job --note "Expired shell"',
      'node chat-ops.mjs record-evaluation --company "Acme" --role "Senior Instructional Designer" --score "4.2/5" --report-body-file output/report-body.md --dry-run',
      'node chat-ops.mjs quality-package-row --num 77',
    ],
  };
}

function buildPackageSchema() {
  return {
    action: 'package-schema',
    mode: 'hybrid',
    required_top_level_keys: ['brief', 'letter'],
    brief: {
      required: ['summary_text', 'competencies', 'experience', 'skills'],
      optional: ['projects', 'keywords', 'language', 'section_labels', 'name', 'phone', 'email', 'location', 'portfolio_url', 'format', 'html_path', 'pdf_path'],
      experience_item: {
        required: ['company', 'role', 'bullets'],
        optional: ['period'],
      },
      skills_item: {
        required: ['category', 'items'],
      },
      project_item: {
        required: ['title', 'description'],
        optional: ['badge', 'tech'],
      },
    },
    letter: {
      required: ['date', 'recipient_lines', 'greeting', 'paragraphs', 'closing'],
      optional: ['language', 'format', 'html_path', 'pdf_path'],
    },
  };
}

function appendOrReplaceNote(existing, incoming, replace = false) {
  const next = String(incoming || '').trim();
  if (!next) return String(existing || '');
  if (replace) return next;
  const current = String(existing || '').trim();
  if (!current) return next;
  return `${current} | ${next}`;
}

function updateApplicationRow(flags = {}) {
  const num = parseInt(flags.num, 10);
  if (Number.isNaN(num)) {
    return { ok: false, error: 'A numeric --num is required for update-application.' };
  }

  if (!existsSync(APPS_FILE)) {
    return { ok: false, error: 'Tracker file does not exist.' };
  }

  const nextStatus = flags.status ? String(flags.status).trim() : null;
  if (nextStatus && !CANONICAL_STATUSES.has(nextStatus)) {
    return {
      ok: false,
      error: `Status must be one of: ${Array.from(CANONICAL_STATUSES).join(', ')}`,
    };
  }

  const nextPdf = flags.pdf ? String(flags.pdf).trim() : null;
  if (nextPdf && !['✅', '❌'].includes(nextPdf)) {
    return { ok: false, error: 'PDF must be either ✅ or ❌.' };
  }

  const lines = readFileSync(APPS_FILE, 'utf-8').split(/\r?\n/);
  let updated = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    if (line.includes('---') || line.includes('| # |')) continue;
    const parts = line.split('|').map((value) => value.trim());
    if (parts.length < 10) continue;
    const rowNum = parseInt(parts[1], 10);
    if (rowNum !== num) continue;

    const nextNotes = flags.notes !== undefined
      ? appendOrReplaceNote(parts[9] || '', flags.notes, Boolean(flags['replace-notes']))
      : (parts[9] || '');

    const row = {
      num: rowNum,
      date: parts[2],
      company: parts[3],
      role: parts[4],
      score: parts[5],
      status: nextStatus || parts[6],
      pdf: nextPdf || parts[7],
      report: parts[8],
      notes: nextNotes,
    };

    lines[i] = `| ${row.num} | ${row.date} | ${row.company} | ${row.role} | ${row.score} | ${row.status} | ${row.pdf} | ${row.report} | ${row.notes} |`;
    updated = row;
    break;
  }

  if (!updated) {
    return { ok: false, error: `Could not find tracker row #${num}.` };
  }

  writeFileSync(APPS_FILE, lines.join('\n'), 'utf-8');
  const verify = runNodeScript('verify-pipeline.mjs');
  logAction({
    actor: 'chat-ops',
    action: 'update-application',
    num,
    updated_fields: {
      status: nextStatus,
      pdf: nextPdf,
      notes: flags.notes ?? null,
      replace_notes: Boolean(flags['replace-notes']),
    },
    ok: verify.ok,
  });

  return {
    action: 'update-application',
    ok: verify.ok,
    updated: updated,
    verify: {
      ok: verify.ok,
      exit_code: verify.status,
      stdout: verify.stdout.trim(),
      stderr: verify.stderr.trim(),
    },
  };
}

function updateInboxItem(flags = {}) {
  const targetUrl = String(flags.url || '').trim();
  if (!targetUrl) {
    return { ok: false, error: 'A --url is required for update-inbox.' };
  }

  const nextState = String(flags.state || '').trim().toLowerCase();
  if (!PIPELINE_MARKERS[nextState]) {
    return { ok: false, error: 'State must be one of: pending, processed, issue.' };
  }

  if (!existsSync(PIPELINE_FILE)) {
    return { ok: false, error: 'Pipeline file does not exist.' };
  }

  const lines = readFileSync(PIPELINE_FILE, 'utf-8').split(/\r?\n/);
  let updated = null;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^- \[([ x!])\] (.+)$/);
    if (!match) continue;
    const body = match[2];
    const parts = body.split(' | ').map((part) => part.trim());
    const url = parts[0] || '';
    if (url !== targetUrl) continue;

    const company = parts[1] || '';
    const title = parts[2] || '';
    const existingNote = parts.slice(3).join(' | ');
    const nextNote = flags.note !== undefined
      ? appendOrReplaceNote(existingNote, flags.note, Boolean(flags['replace-note']))
      : existingNote;

    const nextBodyParts = [url, company, title];
    if (nextNote) nextBodyParts.push(nextNote);
    lines[i] = `- [${PIPELINE_MARKERS[nextState]}] ${nextBodyParts.join(' | ')}`;

    updated = {
      url,
      company,
      title,
      state: nextState,
      note: nextNote,
    };
    break;
  }

  if (!updated) {
    return { ok: false, error: `Could not find pipeline item for URL: ${targetUrl}` };
  }

  writeFileSync(PIPELINE_FILE, lines.join('\n'), 'utf-8');
  const verify = runNodeScript('verify-pipeline.mjs');
  logAction({
    actor: 'chat-ops',
    action: 'update-inbox',
    url: targetUrl,
    updated_fields: {
      state: nextState,
      note: flags.note ?? null,
      replace_note: Boolean(flags['replace-note']),
    },
    ok: verify.ok,
  });

  return {
    action: 'update-inbox',
    ok: verify.ok,
    updated,
    verify: {
      ok: verify.ok,
      exit_code: verify.status,
      stdout: verify.stdout.trim(),
      stderr: verify.stderr.trim(),
    },
  };
}

function markApplied(flags = {}) {
  return updateApplicationRow({
    ...flags,
    status: 'Applied',
  });
}

function markInboxStale(flags = {}) {
  const incomingNote = String(flags.note || '').trim();
  const note = incomingNote || 'Marked stale via MCP helper.';
  return updateInboxItem({
    ...flags,
    state: 'issue',
    note,
  });
}

function nextTrackerNumberLocal() {
  const rows = parseApplications();
  return (rows.length ? Math.max(...rows.map((row) => row.num)) : 0) + 1;
}

function buildEvaluationReportContent({
  company,
  role,
  date,
  archetype,
  score,
  url,
  verification,
  legitimacy,
  pdf,
  body,
}) {
  const reportBody = String(body || '').trim();
  return [
    `# Evaluation: ${company} - ${role}`,
    '',
    `**Date:** ${date}`,
    `**Archetype:** ${archetype || 'Not specified'}`,
    `**Score:** ${score}`,
    `**URL:** ${url || 'inline text'}`,
    `**Verification:** ${verification || 'Manual evaluation recorded through MCP hybrid flow.'}`,
    `**Legitimacy:** ${legitimacy || 'Unspecified'}`,
    `**PDF:** ${pdf}`,
    '',
    '---',
    '',
    reportBody,
  ].join('\n');
}

function recordEvaluation(flags = {}) {
  const company = String(flags.company || '').trim();
  const role = String(flags.role || '').trim();
  const score = String(flags.score || '').trim();
  if (!company || !role || !score) {
    return { ok: false, error: 'record-evaluation requires --company, --role, and --score.' };
  }

  const date = String(flags.date || todayIso()).trim();
  const status = String(flags.status || 'Evaluated').trim();
  if (!CANONICAL_STATUSES.has(status)) {
    return { ok: false, error: `Status must be one of: ${Array.from(CANONICAL_STATUSES).join(', ')}` };
  }

  const pdf = String(flags.pdf || '❌').trim();
  if (!['✅', '❌'].includes(pdf)) {
    return { ok: false, error: 'PDF must be either ✅ or ❌.' };
  }

  let reportBody = '';
  if (flags['report-body-file']) {
    const reportBodyPath = resolve(String(flags['report-body-file']));
    if (!existsSync(reportBodyPath)) {
      return { ok: false, error: `Report body file not found: ${reportBodyPath}` };
    }
    reportBody = readFileSync(reportBodyPath, 'utf-8');
  } else if (flags['report-body']) {
    reportBody = String(flags['report-body']);
  }

  if (!String(reportBody || '').trim()) {
    return { ok: false, error: 'record-evaluation requires --report-body or --report-body-file.' };
  }

  const trackerNum = nextTrackerNumberLocal();
  const reportNum = String(trackerNum).padStart(3, '0');
  const reportRel = `reports/${reportNum}-${slugify(company)}-${date}.md`;
  const reportPath = join(ROOT, reportRel);
  const reportCell = `[${reportNum}](${reportRel})`;
  const trackerNotes = String(flags.notes || '').trim();
  const reportContent = buildEvaluationReportContent({
    company,
    role,
    date,
    archetype: flags.archetype,
    score,
    url: flags.url,
    verification: flags.verification,
    legitimacy: flags.legitimacy,
    pdf,
    body: reportBody,
  });

  const additionLine = [
    trackerNum,
    date,
    company,
    role,
    status,
    score,
    pdf,
    reportCell,
    trackerNotes,
  ].join('\t');

  if (parsedBool(flags['dry-run'])) {
    return {
      action: 'record-evaluation',
      ok: true,
      dry_run: true,
      planned: {
        tracker_num: trackerNum,
        report_path: reportPath,
        tracker_addition_path: join(TRACKER_ADDITIONS_DIR, `${reportNum}-${slugify(company)}-${date}.tsv`),
        tracker_line: additionLine,
      },
      report_preview: reportContent,
    };
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  mkdirSync(TRACKER_ADDITIONS_DIR, { recursive: true });
  writeFileSync(reportPath, `${reportContent.trim()}\n`, 'utf-8');
  const additionPath = join(TRACKER_ADDITIONS_DIR, `${reportNum}-${slugify(company)}-${date}.tsv`);
  writeFileSync(additionPath, `${additionLine}\n`, 'utf-8');

  const merge = runNodeScript('merge-tracker.mjs');
  if (!merge.ok) {
    return {
      action: 'record-evaluation',
      ok: false,
      error: 'Tracker merge failed after writing report/addition.',
      report_path: reportPath,
      tracker_addition_path: additionPath,
      merge: {
        exit_code: merge.status,
        stdout: merge.stdout.trim(),
        stderr: merge.stderr.trim(),
      },
    };
  }

  const verify = runNodeScript('verify-pipeline.mjs');
  logAction({
    actor: 'chat-ops',
    action: 'record-evaluation',
    company,
    role,
    status,
    score,
    report: reportPath,
    tracker_addition: additionPath,
    ok: verify.ok,
  });

  return {
    action: 'record-evaluation',
    ok: verify.ok,
    created: {
      tracker_num: trackerNum,
      report_path: reportPath,
      tracker_addition_path: additionPath,
    },
    verify: {
      ok: verify.ok,
      exit_code: verify.status,
      stdout: verify.stdout.trim(),
      stderr: verify.stderr.trim(),
    },
  };
}

function parsedBool(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

async function main() {
  const parsed = parseArgs(process.argv);
  const action = parsed.action;
  let result;

  if (action === 'help') {
    result = buildHelp();
  } else if (action === 'tracker' || action === 'applied' || action === 'evaluated') {
    const rows = parseApplications();
    const flags = { ...parsed.flags };
    if (action === 'applied') flags.status = 'Applied';
    if (action === 'evaluated') flags.status = 'Evaluated';
    result = {
      action,
      ...summarizeTracker(rows, flags),
    };
    } else if (action === 'inbox') {
    result = {
      action,
      ...summarizeInbox(parsePipeline()),
    };
  } else if (action === 'shortlist') {
    result = {
      action,
      ...triageItems(
        parsePipeline(),
        parseApplications(),
        parseScanHistory(),
        { includeIssues: Boolean(parsed.flags['include-issues']) }
      ),
    };
  } else if (action === 'evaluate' || action === 'apply-prep') {
    const scriptArgs = [];
    if (parsed.flags.url) scriptArgs.push('--url', String(parsed.flags.url));
    if (parsed.flags['jd-file']) scriptArgs.push('--jd-file', String(parsed.flags['jd-file']));
    if (parsed.flags.text) scriptArgs.push('--text', String(parsed.flags.text));
    if (parsed.flags.client) scriptArgs.push('--client', String(parsed.flags.client));
    if (parsed.flags['with-package'] || action === 'apply-prep') scriptArgs.push('--with-package');
    const run = runNodeScript('gemini-auto-pipeline.mjs', scriptArgs);
    result = run.ok ? {
      action,
      ok: true,
      ...JSON.parse(run.stdout),
    } : {
      action,
      ok: false,
      exit_code: run.status,
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    };
  } else if (action === 'package') {
    if (
      parsed.flags['brief-json']
      || parsed.flags.brief_json
      || parsed.flags['brief-file']
      || parsed.flags.brief_file
    ) {
      try {
        result = buildPackageFromStructuredInput(parsed.flags);
      } catch (err) {
        result = {
          action,
          ok: false,
          mode: 'hybrid',
          error: err.message,
        };
      }
    } else if (isTruthyFlag(parsed.flags.auto_draft)) {
      const autoContext = buildAutoDraftPackageContext(parsed.flags);
      const chronology = parseCvChronologyFromPath(autoContext.base_cv_source);
      const drafted = buildAutoDraftQualityPackage(autoContext, chronology);
      try {
        result = buildPackageFromStructuredInput({
          ...parsed.flags,
          company: autoContext.company,
          role: autoContext.role,
          report: autoContext.report || parsed.flags.report,
          'brief-json': JSON.stringify(drafted.brief),
          'letter-json': JSON.stringify(drafted.letter),
        });
      } catch (err) {
        result = {
          action,
          ok: false,
          mode: 'hybrid',
          error: err.message,
        };
      }
    } else {
      const scriptArgs = [];
      if (parsed.flags['jd-file']) scriptArgs.push('--jd-file', String(parsed.flags['jd-file']));
      if (parsed.flags.text) scriptArgs.push('--text', String(parsed.flags.text));
      if (parsed.flags.report) scriptArgs.push('--report', String(parsed.flags.report));
      if (parsed.flags.company) scriptArgs.push('--company', String(parsed.flags.company));
      if (parsed.flags.role) scriptArgs.push('--role', String(parsed.flags.role));
      if (parsed.flags.url) scriptArgs.push('--url', String(parsed.flags.url));
      const run = runNodeScript('gemini-package.mjs', scriptArgs);
      result = run.ok ? {
        action,
        ok: true,
        mode: 'gemini',
        ...JSON.parse(run.stdout),
        quality_gate: summarizePackageReadiness({
          errors: [],
          warnings: [],
          reviewed: false,
          chatVerified: false,
        }),
        ...summarizePackageReadiness({
          errors: [],
          warnings: [],
          reviewed: false,
          chatVerified: false,
        }),
      } : {
        action,
        ok: false,
        mode: 'gemini',
        exit_code: run.status,
        stdout: run.stdout.trim(),
        stderr: run.stderr.trim(),
      };
    }
  } else if (action === 'package-schema') {
    result = buildPackageSchema();
  } else if (action === 'record-evaluation') {
    result = recordEvaluation(parsed.flags);
  } else if (action === 'quality-package-row') {
    result = buildQualityPackageForRow(parsed.flags);
  } else if (action === 'update-application') {
    result = updateApplicationRow(parsed.flags);
  } else if (action === 'update-inbox') {
    result = updateInboxItem(parsed.flags);
  } else if (action === 'mark-applied') {
    result = markApplied(parsed.flags);
  } else if (action === 'mark-inbox-stale') {
    result = markInboxStale(parsed.flags);
  } else if (action === 'verify') {
    const run = runNodeScript('verify-pipeline.mjs');
    result = {
      action,
      ok: run.ok,
      exit_code: run.status,
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    };
  } else if (action === 'sync-check') {
    const run = runNodeScript('cv-sync-check.mjs');
    result = {
      action,
      ok: run.ok,
      exit_code: run.status,
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    };
  } else if (action === 'project-profile') {
    result = {
      action,
      ...buildProjectProfileSummary(),
    };
  } else if (action === 'repo-summary') {
    result = buildRepoSummary();
  } else if (action === 'attention-report') {
    result = {
      action,
      ...buildAttentionReport(parseApplications()),
    };
  } else if (action === 'patterns') {
    const run = runNodeScript('analyze-patterns.mjs');
    result = run.ok ? JSON.parse(run.stdout) : {
      action,
      ok: false,
      exit_code: run.status,
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    };
  } else if (action === 'quick-apply') {
    result = {
      action,
      ...buildQuickApplySummary(),
    };
  } else if (action === 'base-cv') {
    result = buildBaseCvSummary();
  } else if (action === 'profile-context') {
    result = buildProfileContextSummary();
  } else if (action === 'tracker-row') {
    result = buildTrackerRowSummary(parsed.flags);
  } else if (action === 'report') {
    result = buildReportSummary(parsed.flags);
  } else if (action === 'pipeline-item') {
    result = buildPipelineItemSummary(parsed.flags);
  } else if (action === 'list-repo-dir') {
    result = listRepoDir(parsed.flags);
  } else if (action === 'read-file') {
    result = readRepoFile(parsed.flags);
  } else if (action === 'search-repo') {
    result = searchRepoText(parsed.flags);
  } else if (action === 'cv-chronology') {
    result = buildCvChronologySummary();
  } else if (action === 'reports') {
    const limit = parsed.flags.limit ? parseInt(parsed.flags.limit, 10) : 10;
    const files = latestFilesInDir(REPORTS_DIR, (path) => path.toLowerCase().endsWith('.md'))
      .slice(0, Number.isNaN(limit) ? 10 : limit)
      .map((file) => ({
        path: file.path,
        name: basename(file.path),
        modified_at: new Date(file.mtimeMs).toISOString(),
      }));
    result = {
      action,
      total_reports: latestFilesInDir(REPORTS_DIR, (path) => path.toLowerCase().endsWith('.md')).length,
      items: files,
    };
  } else if (action === 'liveness') {
    const urls = parsed.positionals;
    if (urls.length === 0) {
      console.error('Usage: node chat-ops.mjs liveness <url1> [url2] ...');
      process.exit(1);
    }
    const run = runNodeScript('check-liveness.mjs', urls);
    result = {
      action,
      ok: run.ok,
      exit_code: run.status,
      items: parseLivenessOutput(run.stdout, urls),
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    };
  } else if (action === 'scan' || action === 'scan-safe') {
    const beforePipeline = parsePipeline();
    const beforeUrls = new Set(beforePipeline.map((item) => item.url));
    const runArgs = [];
    if (parsed.flags.company) {
      runArgs.push('--company', String(parsed.flags.company));
    }
    if (parsed.flags['dry-run']) {
      runArgs.push('--dry-run');
    }

    const run = runNodeScript('scan.mjs', runArgs);
    const afterPipeline = parsePipeline();
    const newlyAdded = afterPipeline.filter((item) => !beforeUrls.has(item.url));
    const summary = parseScanSummary(run.stdout);

    result = {
      action,
      ok: run.ok,
      exit_code: run.status,
      scan_summary: summary,
      new_inbox_items: newlyAdded,
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    };

    if (run.ok && action === 'scan-safe' && newlyAdded.length > 0) {
      const urls = newlyAdded.map((item) => item.url).filter(Boolean);
      const liveRun = runNodeScript('check-liveness.mjs', urls);
      const items = parseLivenessOutput(liveRun.stdout, urls);
      const marked = parsed.flags['mark-expired'] ? markPipelineIssues(items) : false;
      result.liveness = {
        ok: liveRun.ok,
        exit_code: liveRun.status,
        items,
        pipeline_marked: marked,
      };
    }

    if (parsed.flags.shortlist) {
      const pipelineItems = parsePipeline();
      const triaged = triageItems(
        pipelineItems.filter((item) => newlyAdded.some((added) => added.url === item.url)),
        parseApplications(),
        parseScanHistory(),
        { includeIssues: Boolean(parsed.flags['include-issues']) }
      );
      result.shortlist = triaged;
    }
  } else {
    console.error(`Unknown action "${action}". Run: node chat-ops.mjs help`);
    process.exit(1);
  }

  logAction({
    actor: 'chat-ops',
    action,
    flags: parsed.flags,
    ok: result?.ok !== false,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
