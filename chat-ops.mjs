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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPS_FILE = join(ROOT, 'data', 'applications.md');
const PIPELINE_FILE = join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY_FILE = join(ROOT, 'data', 'scan-history.tsv');
const PROFILE_FILE = join(ROOT, 'config', 'profile.yml');
const OUTPUT_DIR = join(ROOT, 'output');
const REPORTS_DIR = join(ROOT, 'reports');
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

function roleTokens(text) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 3);
}

function roleSimilarity(a, b) {
  const setA = new Set(roleTokens(a));
  const setB = new Set(roleTokens(b));
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

function titleSignalScore(title) {
  const lower = normalizeText(title);
  if (PRIMARY_TITLE_SIGNALS.some((signal) => lower.includes(signal))) return 45;
  if (SECONDARY_TITLE_SIGNALS.some((signal) => lower.includes(signal))) return 35;
  if (ADJACENT_TITLE_SIGNALS.some((signal) => lower.includes(signal))) return 24;
  return 10;
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
      { action: 'verify', description: 'Run verify-pipeline.mjs and return pass/fail with captured output.' },
      { action: 'sync-check', description: 'Run cv-sync-check.mjs and return pass/fail with captured output.' },
      { action: 'project-profile', description: 'Generate and return the ChatGPT-friendly markdown profile mirror.' },
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
    ],
  };
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
    const run = runNodeScript('generate-project-profile.mjs');
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

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
