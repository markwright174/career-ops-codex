#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const PATHS = {
  root: ROOT,
  profile: join(ROOT, 'config', 'profile.yml'),
  userProfile: join(ROOT, 'modes', '_profile.md'),
  shared: join(ROOT, 'modes', '_shared.md'),
  oferta: join(ROOT, 'modes', 'oferta.md'),
  articleDigest: join(ROOT, 'article-digest.md'),
  cv: join(ROOT, 'cv.md'),
  reports: join(ROOT, 'reports'),
  output: join(ROOT, 'output'),
  tracker: join(ROOT, 'data', 'applications.md'),
  pipeline: join(ROOT, 'data', 'pipeline.md'),
  scanHistory: join(ROOT, 'data', 'scan-history.tsv'),
  trackerAdditions: join(ROOT, 'batch', 'tracker-additions'),
  actionLog: join(ROOT, 'data', 'chat-actions.ndjson'),
  dotenv: join(ROOT, '.env'),
};

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readText(path, fallback = '') {
  return existsSync(path) ? readFileSync(path, 'utf-8') : fallback;
}

export function readYaml(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  return yaml.load(readFileSync(path, 'utf-8')) || fallback;
}

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeCompany(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function parseScore(score) {
  const match = String(score || '').match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

export function parseApplications() {
  if (!existsSync(PATHS.tracker)) return [];
  const lines = readFileSync(PATHS.tracker, 'utf-8').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('| # |') || line.includes('---')) continue;
    const parts = line.split('|').map((value) => value.trim());
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
      raw: line,
    });
  }
  return rows;
}

export function nextReportNumber() {
  ensureDir(PATHS.reports);
  const nums = readdirSync(PATHS.reports)
    .filter((name) => /^\d{3}-/.test(name))
    .map((name) => parseInt(name.slice(0, 3), 10))
    .filter((value) => !Number.isNaN(value));
  return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
}

export function nextTrackerNumber() {
  const rows = parseApplications();
  return (rows.length ? Math.max(...rows.map((row) => row.num)) : 0) + 1;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function latestFiles(dir, predicate) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && predicate(path))
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function runNodeScript(scriptName, args = [], options = {}) {
  const result = spawnSync(process.execPath, [join(ROOT, scriptName), ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: options.timeout_ms || 300000,
  });

  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

export function writeTrackerAddition(addition) {
  ensureDir(PATHS.trackerAdditions);
  const fileName = `${String(addition.num).padStart(3, '0')}-${slugify(addition.company)}-${addition.date}.tsv`;
  const outPath = join(PATHS.trackerAdditions, fileName);
  const line = [
    addition.num,
    addition.date,
    addition.company,
    addition.role,
    addition.status,
    addition.score,
    addition.pdf,
    addition.report,
    addition.notes || '',
  ].join('\t');
  writeFileSync(outPath, `${line}\n`, 'utf-8');
  return outPath;
}

export function mergeTrackerAndVerify() {
  const merge = runNodeScript('merge-tracker.mjs');
  if (!merge.ok) return { ok: false, merge, verify: null };
  const verify = runNodeScript('verify-pipeline.mjs');
  return { ok: verify.ok, merge, verify };
}

export function updateTrackerPdfStatus(company, role, pdfEmoji = '✅') {
  if (!existsSync(PATHS.tracker)) return false;
  const lines = readFileSync(PATHS.tracker, 'utf-8').split(/\r?\n/);
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    if (line.includes('| # |') || line.includes('---')) continue;
    const parts = line.split('|').map((value) => value.trim());
    if (parts.length < 10) continue;
    if (normalizeCompany(parts[3]) !== normalizeCompany(company)) continue;
    if (parts[4].toLowerCase() !== String(role || '').toLowerCase()) continue;
    parts[7] = pdfEmoji;
    lines[i] = `| ${parts[1]} | ${parts[2]} | ${parts[3]} | ${parts[4]} | ${parts[5]} | ${parts[6]} | ${parts[7]} | ${parts[8]} | ${parts[9]} |`;
    changed = true;
    break;
  }

  if (changed) {
    writeFileSync(PATHS.tracker, lines.join('\n'), 'utf-8');
  }
  return changed;
}

export function logAction(entry) {
  ensureDir(join(ROOT, 'data'));
  const row = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  appendFileSync(PATHS.actionLog, `${JSON.stringify(row)}\n`, 'utf-8');
}

export function inferPaperFormat(locationText = '', fallback = 'letter') {
  const lower = String(locationText || '').toLowerCase();
  if (!lower) return fallback;
  if (lower.includes('united states') || lower.includes('usa') || lower.includes('texas') || lower.includes('houston') || lower.includes('utah') || lower.includes('canada')) {
    return 'letter';
  }
  return 'a4';
}
