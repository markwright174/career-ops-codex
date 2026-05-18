#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches ATS feeds/pages directly and also executes configured broad search
 * queries, applies title filters from portals.yml, deduplicates against
 * existing history, and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON/XML.
 *
 * Usage:
 *   node scan.mjs                  # scan tracked companies + enabled search queries
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const PROFILE_PATH = 'config/profile.yml';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  if (company.api) {
    if (typeof company.api === 'string') {
      const inferred = detectApiFromText(company.api);
      if (inferred) return inferred;
    }

    if (typeof company.api === 'object' && company.api.type && company.api.url) {
      return company.api;
    }
  }

  const candidates = [company.careers_url || '', company.scan_query || ''];

  for (const candidate of candidates) {
    const inferred = detectApiFromText(candidate);
    if (inferred) return inferred;
  }

  return null;
}

function detectApiFromText(text) {
  if (!text) return null;

  // Ashby
  const ashbyMatch = text.match(/jobs\.ashbyhq\.com\/([^\/\s"'|?#]+)/i);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // BambooHR
  const bambooMatch = text.match(/([a-z0-9-]+)\.bamboohr\.com/i);
  if (bambooMatch) {
    return {
      type: 'bamboohr',
      url: `https://${bambooMatch[1]}.bamboohr.com/careers/list`,
      companySlug: bambooMatch[1],
    };
  }

  // Breezy
  const breezyMatch = text.match(/([a-z0-9-]+)\.breezy\.hr/i);
  if (breezyMatch) {
    return {
      type: 'breezy',
      url: `https://${breezyMatch[1]}.breezy.hr/json`,
      companySlug: breezyMatch[1],
    };
  }

  // iCIMS public boards/pages
  const icimsCareersMatch = text.match(/((?:careers|jobs)(?:-[a-z0-9-]+)?\.icims\.com)/i);
  if (icimsCareersMatch) {
    return {
      type: 'icims',
      url: `https://${icimsCareersMatch[1]}/jobs/search?ss=1`,
      host: icimsCareersMatch[1],
    };
  }

  const icimsSocialMatch = text.match(/social\.icims\.com\/board\/([A-Za-z0-9_-]+)/i);
  if (icimsSocialMatch) {
    return {
      type: 'icims',
      url: `https://social.icims.com/board/${icimsSocialMatch[1]}`,
      boardSlug: icimsSocialMatch[1],
    };
  }

  // Lever
  const leverMatch = text.match(/jobs\.lever\.co\/([^\/\s"'|?#]+)/i);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Workable public account feed
  const workableApplyMatch = text.match(/apply\.workable\.com\/([a-z0-9-]+)/i);
  if (workableApplyMatch) {
    return {
      type: 'workable',
      url: `https://www.workable.com/api/accounts/${workableApplyMatch[1]}?details=true`,
      companySlug: workableApplyMatch[1],
    };
  }

  // SmartRecruiters
  const smartRecruitersMatch = text.match(/(?:jobs|careers)\.smartrecruiters\.com\/([^\/\s"'|?#]+)/i);
  if (smartRecruitersMatch) {
    return {
      type: 'smartrecruiters',
      url: `https://api.smartrecruiters.com/v1/companies/${smartRecruitersMatch[1]}/postings?limit=100&offset=0`,
      companySlug: smartRecruitersMatch[1],
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = text.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^\/\s"'|?#]+)/i);
  if (ghEuMatch) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  // Teamtailor
  const teamtailorMatch = text.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.teamtailor\.com/i);
  if (teamtailorMatch) {
    return {
      type: 'teamtailor',
      url: `https://${teamtailorMatch[1]}.teamtailor.com/jobs.rss`,
    };
  }

  // Workday
  const workdayMatch = text.match(/(?:https?:\/\/)?([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/i);
  if (workdayMatch) {
    const [, company, shard, site] = workdayMatch;
    return {
      type: 'workday',
      url: `https://${company}.${shard}.myworkdayjobs.com/wday/cxs/${company}/${site}/jobs`,
      companySlug: company,
      shard,
      site,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

function parseBamboohr(json, companyName, apiMeta = {}) {
  const jobs = Array.isArray(json?.result) ? json.result : [];

  return jobs.map(j => ({
    title: j.jobOpeningName || '',
    url: j.id ? `https://${apiMeta.companySlug}.bamboohr.com/careers/${j.id}/detail` : '',
    company: companyName,
    location: [j.location?.city, j.location?.state, j.location?.country]
      .filter(Boolean)
      .join(', '),
  })).filter(job => job.title && job.url);
}

function parseBreezy(json, companyName) {
  const jobs = Array.isArray(json) ? json : [];

  return jobs.map(j => ({
    title: j.name || '',
    url: j.url || '',
    company: companyName,
    location: j.location || '',
  })).filter(job => job.title && job.url);
}

function parseIcims(html, companyName, apiMeta = {}) {
  const seen = new Set();
  const jobs = [];
  const base = apiMeta.host ? `https://${apiMeta.host}` : 'https://social.icims.com';
  const anchorMatches = html.matchAll(/<a[^>]+href="([^"]*\/jobs\/\d+\/[^"]*?)"[^>]*>([\s\S]*?)<\/a>/gi);

  for (const match of anchorMatches) {
    const href = decodeXmlEntities(match[1] || '').trim();
    const rawTitle = decodeXmlEntities(match[2] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const url = href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`;
    if (!rawTitle || seen.has(url)) continue;
    seen.add(url);
    jobs.push({
      title: rawTitle,
      url,
      company: companyName,
      location: '',
    });
  }

  return jobs;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseTeamtailor(xml, companyName) {
  const items = [];
  const matches = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];

  for (const item of matches) {
    const title = decodeXmlEntities((item.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
    const url = decodeXmlEntities((item.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '').trim();
    const location = decodeXmlEntities((item.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!title || !url) continue;
    items.push({ title, url, company: companyName, location });
  }

  return items;
}

function parseWorkday(json, companyName, apiMeta = {}) {
  const jobs = json.jobPostings || json.jobPostings?.jobPostings || [];

  return jobs.map(j => {
    const externalPath = j.externalPath || '';
    const companySlug = apiMeta.companySlug || companyName.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const site = apiMeta.site || 'External';
    const url = externalPath
      ? `https://${companySlug}.${apiMeta.shard || 'wd1'}.myworkdayjobs.com/${site}/job/${externalPath}`
      : '';

    return {
      title: j.title || '',
      url,
      company: companyName,
      location: j.locationsText || j.location || '',
    };
  }).filter(job => job.title && job.url);
}

function parseWorkable(json, companyName) {
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];

  return jobs.map(j => ({
    title: j.title || j.full_title || '',
    url: j.url || j.shortlink || '',
    company: companyName,
    location: j.location?.location_str || '',
  })).filter(job => job.title && job.url);
}

function parseSmartRecruiters(json, companyName) {
  const jobs = Array.isArray(json?.content) ? json.content : Array.isArray(json?.jobs) ? json.jobs : [];

  return jobs.map(j => ({
    title: j.name || j.title || '',
    url: j.applyUrl || j.jobAdUrl || '',
    company: companyName,
    location: [
      j.location?.city,
      j.location?.region || j.location?.regionCode,
      j.location?.country,
    ].filter(Boolean).join(', '),
  })).filter(job => job.title && job.url);
}

const PARSERS = {
  greenhouse: parseGreenhouse,
  ashby: parseAshby,
  bamboohr: parseBamboohr,
  breezy: parseBreezy,
  icims: parseIcims,
  lever: parseLever,
  smartrecruiters: parseSmartRecruiters,
  teamtailor: parseTeamtailor,
  workable: parseWorkable,
  workday: parseWorkday,
};

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSearchResults(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; career-ops-scan/1.0)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWorkdayJobs(apiMeta) {
  const allJobs = [];
  let offset = 0;
  const limit = 20;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(apiMeta.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          appliedFacets: {},
          limit,
          offset,
          searchText: '',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const jobs = json.jobPostings || [];
      allJobs.push(...jobs);

      if (!Array.isArray(jobs) || jobs.length < limit) {
        return { ...json, jobPostings: allJobs };
      }

      offset += limit;
      if (offset > 200) {
        return { ...json, jobPostings: allJobs };
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchBamboohrJobs(apiMeta) {
  return await fetchJson(apiMeta.url);
}

async function fetchIcimsJobs(apiMeta) {
  return await fetchText(apiMeta.url);
}

async function fetchSmartRecruitersJobs(apiMeta) {
  const allJobs = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = `https://api.smartrecruiters.com/v1/companies/${apiMeta.companySlug}/postings?limit=${limit}&offset=${offset}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const jobs = Array.isArray(json.content) ? json.content : [];
      allJobs.push(...jobs);

      if (!jobs.length || allJobs.length >= (json.totalFound || jobs.length)) {
        return { ...json, content: allJobs };
      }

      offset += limit;
      if (offset > 500) {
        return { ...json, content: allJobs };
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchWorkableJobs(apiMeta) {
  return await fetchJson(apiMeta.url);
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const normalizeTitleMatch = (text) => String(text || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const containsPhrase = (haystack, needle) => {
    if (!needle) return false;
    return ` ${haystack} `.includes(` ${needle} `);
  };

  const positive = (titleFilter?.positive || []).map(normalizeTitleMatch);
  const negative = (titleFilter?.negative || []).map(normalizeTitleMatch);

  return (title) => {
    const normalizedTitle = normalizeTitleMatch(title);
    const hasPositive = positive.length === 0 || positive.some(k => containsPhrase(normalizedTitle, k));
    const hasNegative = negative.some(k => containsPhrase(normalizedTitle, k));
    return hasPositive && !hasNegative;
  };
}

function buildGeoFilter(profile) {
  const country = String(profile?.location?.country || '').toLowerCase();
  const city = String(profile?.location?.city || '').toLowerCase();
  const candidateLocation = String(profile?.candidate?.location || '').toLowerCase();

  return (location = '') => {
    const lower = String(location || '').toLowerCase().trim();
    if (!lower) return true;

    const nonUsSignals = [
      'emea',
      'apac',
      'europe',
      'united kingdom',
      'uk',
      'paris',
      'france',
      'brazil',
      'são paulo',
      'sao paulo',
      'canada',
      'toronto',
      'montreal',
      'india',
      'germany',
      'australia',
      'singapore',
    ];

    if (nonUsSignals.some(signal => lower.includes(signal))) return false;

    const remoteSignals = [
      'remote',
      'united states',
      'united states only',
      'us only',
      'u.s.',
      'u.s. only',
      'usa',
      'nationwide',
    ];
    if (remoteSignals.some(signal => lower.includes(signal))) return true;

    if (country && lower.includes(country)) return true;
    if (city && lower.includes(city)) return true;
    if (candidateLocation && lower.includes(candidateLocation)) return true;

    const usGeoSignals = [
      ', tx',
      ' texas',
      'new york, ny',
      'san francisco, ca',
      'ca •',
      'ny •',
      'portland, or',
      'austin, tx',
      'houston, tx',
    ];

    if (country === 'united states' && usGeoSignals.some(signal => lower.includes(signal))) {
      return true;
    }

    return country === 'united states';
  };
}

function buildRoleQualityFilter() {
  const blockedTitleSignals = [
    'revenue enablement',
    'sales enablement',
    'field enablement',
    'partner enablement',
    'solutions enablement',
    'support enablement',
    'account executive',
    'business development',
    'talent acquisition',
    'hr generalist',
    'human resources generalist',
  ];

  return (title = '') => {
    const lower = String(title || '').toLowerCase();
    return !blockedTitleSignals.some(signal => lower.includes(signal));
  };
}

function buildRoleRanker() {
  const normalizeRankText = (text) => String(text || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const rankedSignals = [
    { score: 5, terms: ['instructional design manager', 'senior instructional designer', 'instructional designer', 'learning experience designer'] },
    { score: 4, terms: ['learning designer', 'curriculum designer', 'curriculum developer', 'faculty development', 'learning strategist', 'learning consultant', 'leadership development', 'organizational development', 'talent development', 'learning and development lead', 'learning development lead', 'l d lead', 'technology enablement', 'technical enablement'] },
    { score: 3, terms: ['customer education manager', 'customer education', 'product education', 'technical training', 'technical learning', 'learning and development'] },
    { score: 2, terms: ['enablement content', 'education program strategist', 'customer learning'] },
    { score: 1, terms: ['customer enablement', 'enablement', 'customer success'] },
  ];

  return (title = '') => {
    const lower = normalizeRankText(title);
    let bestScore = 0;

    for (const group of rankedSignals) {
      if (group.terms.some(term => lower.includes(term))) {
        bestScore = Math.max(bestScore, group.score);
      }
    }

    return bestScore;
  };
}

function decodeDuckDuckGoUrl(href) {
  if (!href) return '';
  const normalized = href.startsWith('//') ? `https:${href}` : href;

  try {
    const url = new URL(normalized);
    const uddg = url.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
  } catch {
    // fall through
  }

  return decodeXmlEntities(normalized);
}

function inferCompanyFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const pieces = hostname.split('.');
    if (pieces.length >= 2) return pieces[pieces.length - 2];
    return hostname;
  } catch {
    return '';
  }
}

function companyMatchesFilter(company, filterCompany) {
  if (!filterCompany) return true;
  const needle = filterCompany.toLowerCase();
  const haystacks = [
    company.name || '',
    company.careers_url || '',
    company.scan_query || '',
    typeof company.api === 'string' ? company.api : '',
  ].map(value => String(value).toLowerCase());

  return haystacks.some(value => value.includes(needle));
}

function cleanSearchTitle(title) {
  return decodeXmlEntities(title || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferTitleAndCompany(rawTitle, url) {
  const title = cleanSearchTitle(rawTitle);
  const patterns = [
    /^Job Application for (.+?) at (.+)$/i,
    /^(.+?)\s+@\s+(.+)$/i,
    /^(.+?)\s+\|\s+(.+)$/i,
    /^(.+?)\s+[—–-]\s+(.+)$/i,
    /^(.+?)\s+at\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      return {
        title: match[1].trim(),
        company: match[2].trim(),
      };
    }
  }

  return {
    title,
    company: inferCompanyFromUrl(url),
  };
}

function parseDuckDuckGoResults(html, queryName) {
  const results = [];
  const seen = new Set();
  const matches = html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);

  for (const match of matches) {
    const url = decodeDuckDuckGoUrl(match[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const parsed = inferTitleAndCompany(match[2], url);
    if (!parsed.title) continue;

    results.push({
      title: parsed.title,
      url,
      company: parsed.company || queryName,
      location: '',
    });
  }

  return results;
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const profile = existsSync(PROFILE_PATH) ? parseYaml(readFileSync(PROFILE_PATH, 'utf-8')) : {};
  const companies = config.tracked_companies || [];
  const searchQueries = (config.search_queries || []).filter(q => q.enabled !== false);
  const titleFilter = buildTitleFilter(config.title_filter);
  const geoFilter = buildGeoFilter(profile);
  const roleQualityFilter = buildRoleQualityFilter();
  const roleRanker = buildRoleRanker();

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => companyMatchesFilter(c, filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;
  const runnableQueries = filterCompany
    ? companies
        .filter(c => c.enabled !== false)
        .filter(c => companyMatchesFilter(c, filterCompany))
        .filter(c => c.scan_query)
        .map(c => ({ name: `Tracked Search — ${c.name}`, query: c.scan_query }))
    : searchQueries;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  console.log(`Running ${runnableQueries.length} broad search queries`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalGeoFiltered = 0;
  let totalRoleFiltered = 0;
  let totalRankFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const payload = type === 'teamtailor'
        ? await fetchText(url)
        : type === 'workday'
          ? await fetchWorkdayJobs(company._api)
          : type === 'bamboohr'
            ? await fetchBamboohrJobs(company._api)
            : type === 'icims'
              ? await fetchIcimsJobs(company._api)
            : type === 'smartrecruiters'
              ? await fetchSmartRecruitersJobs(company._api)
              : type === 'workable'
                ? await fetchWorkableJobs(company._api)
              : await fetchJson(url);
      const jobs = PARSERS[type](payload, company.name, company._api);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (!roleQualityFilter(job.title)) {
          totalRoleFiltered++;
          continue;
        }
        const roleRank = roleRanker(job.title);
        if (roleRank < 3) {
          totalRankFiltered++;
          continue;
        }
        if (!geoFilter(job.location)) {
          totalGeoFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api`, roleRank });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  const queryTasks = runnableQueries.map(query => async () => {
    try {
      const html = await fetchSearchResults(query.query);
      const jobs = parseDuckDuckGoResults(html, query.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (!roleQualityFilter(job.title)) {
          totalRoleFiltered++;
          continue;
        }
        const roleRank = roleRanker(job.title);
        if (roleRank < 3) {
          totalRankFiltered++;
          continue;
        }
        if (!geoFilter(job.location)) {
          totalGeoFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `search:${query.name}`, roleRank });
      }
    } catch (err) {
      errors.push({ company: query.name, error: err.message });
    }
  });

  await parallelFetch([...tasks, ...queryTasks], CONCURRENCY);

  newOffers.sort((a, b) => {
    if (b.roleRank !== a.roleRank) return b.roleRank - a.roleRank;
    return a.company.localeCompare(b.company);
  });

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Queries executed:     ${runnableQueries.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Filtered by role:      ${totalRoleFiltered} removed`);
  console.log(`Filtered by rank:      ${totalRankFiltered} removed`);
  console.log(`Filtered by geography: ${totalGeoFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
