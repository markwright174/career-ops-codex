#!/usr/bin/env node

/**
 * discover-highered-ats.mjs
 *
 * Build a higher-ed institution seed set from College Scorecard, probe likely
 * careers pages, detect ATS platform hints (Workday/Paylocity/etc), and emit
 * candidate entries for portals.yml review.
 *
 * Usage:
 *   node discover-highered-ats.mjs
 *   node discover-highered-ats.mjs --limit 50
 *   node discover-highered-ats.mjs --state TX --limit 100
 *   node discover-highered-ats.mjs --name "University"
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const SCORECARD_BASE = 'https://api.data.gov/ed/collegescorecard/v1/schools';
const OUTPUT_DIR = 'output';
const FETCH_TIMEOUT_MS = 12000;
const CONCURRENCY = 8;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { limit: 60, page: 0, state: '', name: '' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit') out.limit = parseInt(args[++i] || '60', 10);
    else if (a === '--page') out.page = parseInt(args[++i] || '0', 10);
    else if (a === '--state') out.state = String(args[++i] || '').trim().toUpperCase();
    else if (a === '--name') out.name = String(args[++i] || '').trim();
  }
  if (!Number.isFinite(out.limit) || out.limit < 1) out.limit = 60;
  if (!Number.isFinite(out.page) || out.page < 0) out.page = 0;
  return out;
}

function normalizeDomain(urlOrDomain = '') {
  const raw = String(urlOrDomain || '').trim();
  if (!raw) return '';
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(withProtocol);
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  }
}

function toUrl(domainOrUrl = '', path = '/') {
  const domain = normalizeDomain(domainOrUrl);
  if (!domain) return '';
  const p = path.startsWith('/') ? path : `/${path}`;
  return `https://${domain}${p}`;
}

function slugify(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

async function fetchText(url) {
  const timer = timeoutSignal(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: timer.signal,
      headers: {
        'user-agent': 'career-ops-discovery/1.0 (+https://github.com/santifer/career-ops)',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      text: String(text || ''),
    };
  } catch (err) {
    return { ok: false, status: 0, url, text: '', error: err.message };
  } finally {
    timer.clear();
  }
}

function detectAtsFromText(text = '') {
  if (!text) return null;

  const checks = [
    { type: 'workday', re: /[a-z0-9-]+\.(wd\d+)\.myworkdayjobs\.com/i },
    { type: 'paylocity', re: /recruiting\.paylocity\.com\/Recruiting\/Jobs/i },
    { type: 'greenhouse', re: /(?:boards-api|job-boards(?:\.eu)?|boards)\.greenhouse\.io/i },
    { type: 'ashby', re: /jobs\.ashbyhq\.com/i },
    { type: 'lever', re: /jobs\.lever\.co/i },
    { type: 'workable', re: /apply\.workable\.com/i },
    { type: 'smartrecruiters', re: /jobs\.smartrecruiters\.com|careers\.smartrecruiters\.com/i },
    { type: 'icims', re: /(?:careers|jobs)(?:-[a-z0-9-]+)?\.icims\.com|social\.icims\.com\/board/i },
    { type: 'bamboohr', re: /[a-z0-9-]+\.bamboohr\.com\/careers/i },
    { type: 'teamtailor', re: /[a-z0-9.-]+\.teamtailor\.com/i },
  ];

  for (const check of checks) {
    if (check.re.test(text)) return check.type;
  }
  return null;
}

function extractFirstAtsUrl(text = '', atsType = '') {
  if (!text || !atsType) return '';
  const map = {
    workday: /https?:\/\/[a-z0-9-]+\.(?:wd\d+)\.myworkdayjobs\.com\/[^\s"'<>]+/i,
    paylocity: /https?:\/\/recruiting\.paylocity\.com\/Recruiting\/Jobs\/[^\s"'<>]+/i,
    greenhouse: /https?:\/\/(?:boards-api|job-boards(?:\.eu)?|boards)\.greenhouse\.io\/[^\s"'<>]+/i,
    ashby: /https?:\/\/jobs\.ashbyhq\.com\/[^\s"'<>]+/i,
    lever: /https?:\/\/jobs\.lever\.co\/[^\s"'<>]+/i,
    workable: /https?:\/\/apply\.workable\.com\/[^\s"'<>]+/i,
    smartrecruiters: /https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/[^\s"'<>]+/i,
    icims: /https?:\/\/(?:careers|jobs)(?:-[a-z0-9-]+)?\.icims\.com\/[^\s"'<>]+|https?:\/\/social\.icims\.com\/board\/[^\s"'<>]+/i,
    bamboohr: /https?:\/\/[a-z0-9-]+\.bamboohr\.com\/careers\/[^\s"'<>]*/i,
    teamtailor: /https?:\/\/[a-z0-9.-]+\.teamtailor\.com\/[^\s"'<>]*/i,
  };
  const re = map[atsType];
  if (!re) return '';
  const match = String(text).match(re);
  return match ? match[0] : '';
}

function guessCareerPaths(domain) {
  const paths = [
    '/',
    '/careers',
    '/jobs',
    '/employment',
    '/about/careers',
    '/human-resources/jobs',
  ];
  return paths.map((p) => toUrl(domain, p)).filter(Boolean);
}

function parseInstitutionRow(row) {
  const name = row['school.name'] || '';
  const city = row['school.city'] || '';
  const state = row['school.state'] || '';
  const schoolUrl = row['school.school_url'] || '';
  const rootDomain = normalizeDomain(schoolUrl);
  return {
    id: row.id || '',
    name,
    city,
    state,
    school_url: schoolUrl,
    domain: rootDomain,
  };
}

async function discoverInstitutionAts(inst) {
  const candidates = new Set();
  if (inst.school_url) candidates.add(inst.school_url);
  for (const u of guessCareerPaths(inst.domain)) candidates.add(u);

  const tries = [];
  let best = null;
  for (const url of candidates) {
    if (!url) continue;
    const res = await fetchText(url);
    const blob = `${res.url}\n${res.text}`;
    const atsType = detectAtsFromText(blob);
    const atsUrl = atsType ? extractFirstAtsUrl(blob, atsType) : '';
    const hasCareerSignal = /careers?|jobs?|employment|work with us|join our team/i.test(blob);

    const hit = {
      requested_url: url,
      final_url: res.url,
      status: res.status,
      ok: res.ok,
      has_career_signal: hasCareerSignal,
      ats_type: atsType || '',
      ats_url: atsUrl || '',
      error: res.error || '',
    };
    tries.push(hit);

    if (atsType) {
      best = hit;
      break;
    }
    if (!best && hasCareerSignal && res.ok) best = hit;
  }

  return {
    ...inst,
    discovered: Boolean(best),
    best_match: best,
    tries,
  };
}

async function runWithConcurrency(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let index = 0;
  async function runOne() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runOne());
  await Promise.all(workers);
  return results;
}

async function fetchCollegeScorecardRows(args) {
  const apiKey = process.env.DATA_GOV_API_KEY || process.env.COLLEGESCORECARD_API_KEY || 'DEMO_KEY';
  const params = new URLSearchParams({
    api_key: apiKey,
    per_page: String(Math.min(args.limit, 100)),
    page: String(args.page),
    fields: 'id,school.name,school.city,school.state,school.school_url',
    'school.degrees_awarded.predominant': '2,3,4',
  });
  if (args.state) params.set('school.state', args.state);
  if (args.name) params.set('school.name', args.name);

  const url = `${SCORECARD_BASE}?${params.toString()}`;
  const timer = timeoutSignal(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: timer.signal });
    if (!res.ok) {
      throw new Error(`Scorecard request failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    const rows = Array.isArray(json.results) ? json.results : [];
    return rows.map(parseInstitutionRow).filter((r) => r.name && r.domain);
  } finally {
    timer.clear();
  }
}

function toPortalsCandidate(row) {
  const company = row.name;
  const best = row.best_match || {};
  const careersUrl = best.final_url || toUrl(row.domain, '/careers');
  const atsType = best.ats_type || '';
  const probe = (best.ats_url || best.final_url || '').toLowerCase();
  const apiProvider = (
    atsType === 'workday' ? 'workday' :
    atsType === 'greenhouse' ? 'greenhouse' :
    atsType === 'ashby' ? 'ashby' :
    atsType === 'lever' ? 'lever' :
    atsType === 'workable' ? 'workable' :
    atsType === 'smartrecruiters' ? 'smartrecruiters' :
    atsType === 'icims' ? 'icims' :
    atsType === 'bamboohr' ? 'bamboohr' :
    probe.includes('paylocity') ? 'paylocity' :
    ''
  );

  return {
    name: company,
    careers_url: careersUrl,
    enabled: false,
    scan_method: apiProvider && apiProvider !== 'paylocity' ? `${apiProvider}_api` : 'websearch',
    notes: `auto-discovered (${row.state || ''}${row.city ? `/${row.city}` : ''})${atsType ? `; ats=${atsType}` : ''}`,
  };
}

function toTsv(rows) {
  const header = [
    'institution',
    'state',
    'city',
    'domain',
    'careers_url',
    'ats_type',
    'ats_url',
    'probe_status',
    'probe_url',
  ];
  const lines = [header.join('\t')];
  for (const row of rows) {
    const best = row.best_match || {};
    lines.push([
      row.name,
      row.state || '',
      row.city || '',
      row.domain || '',
      best.final_url || '',
      best.ats_type || '',
      best.ats_url || '',
      String(best.status || ''),
      best.requested_url || '',
    ].map((v) => String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t'));
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`Fetching institutions from College Scorecard (limit=${args.limit}${args.state ? `, state=${args.state}` : ''})...`);
  const institutions = await fetchCollegeScorecardRows(args);
  if (!institutions.length) {
    console.log('No institutions returned for this query.');
    return;
  }

  console.log(`Probing ${institutions.length} institution domains for careers/ATS signals...`);
  const discovered = await runWithConcurrency(institutions, discoverInstitutionAts, CONCURRENCY);
  const hits = discovered.filter((d) => d.discovered);
  const atsHits = hits.filter((d) => (d.best_match?.ats_type || '').length > 0);

  const day = new Date().toISOString().slice(0, 10);
  const base = join(OUTPUT_DIR, `highered-ats-discovery-${day}-${args.state || 'all'}-${args.limit}`);
  const jsonPath = `${base}.json`;
  const tsvPath = `${base}.tsv`;

  const payload = {
    generated_at: new Date().toISOString(),
    query: args,
    totals: {
      institutions: discovered.length,
      discovered_any: hits.length,
      ats_detected: atsHits.length,
    },
    results: discovered,
    portals_candidates: atsHits.map(toPortalsCandidate),
  };

  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  writeFileSync(tsvPath, `${toTsv(discovered)}\n`, 'utf-8');

  console.log(`\nDone.`);
  console.log(`Institutions checked: ${discovered.length}`);
  console.log(`Career pages found:   ${hits.length}`);
  console.log(`ATS detected:         ${atsHits.length}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`TSV:  ${tsvPath}`);

  if (atsHits.length) {
    console.log('\nSample ATS hits:');
    for (const row of atsHits.slice(0, 10)) {
      const best = row.best_match || {};
      console.log(`- ${row.name} (${row.state}) -> ${best.ats_type} | ${best.final_url || best.requested_url}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

