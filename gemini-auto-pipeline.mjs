#!/usr/bin/env node

/**
 * gemini-auto-pipeline.mjs — evaluate a JD, create report, tracker row,
 * and optionally generate a tailored application package.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { chromium } from 'playwright';
import {
  PATHS,
  logAction,
  mergeTrackerAndVerify,
  nextTrackerNumber,
  readText,
  runNodeScript,
  slugify,
  todayIso,
  writeTrackerAddition,
} from './repo-ops-lib.mjs';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    url: null,
    jdFile: null,
    text: null,
    client: null,
    withPackage: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url') parsed.url = args[++i];
    else if (arg === '--jd-file') parsed.jdFile = args[++i];
    else if (arg === '--text') parsed.text = args[++i];
    else if (arg === '--client') parsed.client = args[++i];
    else if (arg === '--with-package') parsed.withPackage = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
  }

  if (!parsed.url && !parsed.jdFile && !parsed.text) {
    console.error('Usage: node gemini-auto-pipeline.mjs --url <job-url> [--with-package]');
    console.error('   or: node gemini-auto-pipeline.mjs --jd-file <file> [--with-package]');
    process.exit(1);
  }

  return parsed;
}

const EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
];

const MIN_CONTENT_CHARS = 300;

function inferLiveness(bodyText = '', finalUrl = '') {
  if (EXPIRED_URL_PATTERNS.some((pattern) => pattern.test(finalUrl))) {
    return { result: 'expired', reason: `redirect to ${finalUrl}` };
  }
  if (APPLY_PATTERNS.some((pattern) => pattern.test(bodyText))) {
    return { result: 'active', reason: 'apply button detected' };
  }
  for (const pattern of EXPIRED_PATTERNS) {
    if (pattern.test(bodyText)) {
      return { result: 'expired', reason: `pattern matched: ${pattern.source}` };
    }
  }
  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', reason: 'insufficient content — likely nav/footer only' };
  }
  return { result: 'uncertain', reason: 'content present but no apply button found' };
}

function shouldUseHybridBridge(client) {
  return /\b(chatgpt|mcp|chat)\b/i.test(String(client || ''));
}

function inferProfileMode(text = '', url = '') {
  return 'tstc';
}

function isLikelyWorkdayUrl(url = '') {
  return /myworkday(site|jobs)\.com/i.test(String(url || ''));
}

function isLikelyDayforceUrl(url = '') {
  return /jobs\.dayforcehcm\.com/i.test(String(url || ''));
}

function parseWorkdayPathParts(url = '') {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const recruitingIdx = parts.findIndex((p) => p.toLowerCase() === 'recruiting');
    if (recruitingIdx < 0 || parts.length <= recruitingIdx + 2) return null;
    const tenant = parts[recruitingIdx + 1];
    const site = parts[recruitingIdx + 2];
    return { origin: parsed.origin, tenant, site };
  } catch {
    return null;
  }
}

function parseWorkdayReqToken(url = '') {
  const reqMatch = String(url || '').match(/_(REQ[-_A-Z0-9]+)/i);
  if (reqMatch) return reqMatch[1].replace(/_/g, '-');
  const tail = String(url || '').split('/').filter(Boolean).pop() || '';
  const tokenMatch = tail.match(/[A-Za-z0-9-]{8,}$/);
  return tokenMatch ? tokenMatch[0] : '';
}

function stringifyWorkdayPosting(posting) {
  if (!posting || typeof posting !== 'object') return '';
  const lines = [];
  const push = (label, value) => {
    const clean = String(value || '').trim();
    if (clean) lines.push(`${label}: ${clean}`);
  };

  push('Title', posting.title);
  push('External Path', posting.externalPath);
  push('Location', posting.locationsText);
  push('Posted', posting.postedOn);
  push('Remote Type', posting.remoteType);
  if (posting.bulletFields && Array.isArray(posting.bulletFields)) {
    for (const field of posting.bulletFields) {
      const key = String(field?.label || '').trim();
      const value = String(field?.value || '').trim();
      if (key && value) lines.push(`${key}: ${value}`);
    }
  }
  const desc = String(posting.jobDescription || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (desc) {
    lines.push('');
    lines.push('Description:');
    lines.push(desc);
  }
  return lines.join('\n').trim();
}

function stringifyWorkdayDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const info = detail.jobPostingInfo || {};
  const lines = [];
  const push = (label, value) => {
    const clean = String(value || '').trim();
    if (clean) lines.push(`${label}: ${clean}`);
  };
  push('Title', info.title);
  push('External Path', info.externalPath);
  push('Location', info.location);
  push('Posted', info.startDate);
  push('Time Type', info.timeType);
  push('Worker Sub-Type', info.workerSubType);
  push('Primary Location', info.primaryLocation);

  const desc = String(info.jobDescription || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (desc) {
    lines.push('');
    lines.push('Description:');
    lines.push(desc);
  }
  return lines.join('\n').trim();
}

function inferWorkArrangementFromText(text = '') {
  const t = String(text || '').toLowerCase();
  if (!t) return 'unknown';
  if (/\bremote\b|work\s+schedule[\s\S]{0,80}\bremote\b/.test(t)) return 'remote';
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\bon-?site\b|in\s+office|on\s+campus/.test(t)) return 'onsite';
  return 'unknown';
}

function stringifyDayforceData(data) {
  if (!data || typeof data !== 'object') return '';
  const lines = [];
  const push = (label, value) => {
    const clean = String(value || '').trim();
    if (clean) lines.push(`${label}: ${clean}`);
  };
  push('Title', data.jobTitle);
  push('Req', data.jobReqId);
  push('Posted', data.postingStartTimestampUTC);
  push('Expires', data.postingExpiryTimestampUTC);
  if (Array.isArray(data.postingLocations) && data.postingLocations.length > 0) {
    const loc = data.postingLocations
      .map((l) => String(l?.locationName || l?.name || '').trim())
      .filter(Boolean)
      .join(' | ');
    push('Location', loc);
  }
  if (data.hasVirtualLocation) push('Remote', 'true');
  const html = String(data.jobPostingContent?.jobDescription || '');
  const desc = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (desc) {
    lines.push('');
    lines.push('Description:');
    lines.push(desc);
  }
  return lines.join('\n').trim();
}

async function extractDayforceFallback(page, sourceUrl) {
  if (!isLikelyDayforceUrl(sourceUrl)) return null;
  const data = await page.evaluate(async () => {
    const direct = globalThis.__NEXT_DATA__?.props?.pageProps?.jobData || null;
    if (direct) return { source: 'next-data', jobData: direct };

    const route = globalThis.__NEXT_DATA__;
    const buildId = route?.buildId;
    const query = route?.query || {};
    const locale = query?.locale || 'en-US';
    const clientNamespace = query?.clientNamespace;
    const careerSiteXRefCode = query?.careerSiteXRefCode;
    const id = query?.id;
    if (buildId && clientNamespace && careerSiteXRefCode && id) {
      const jsonUrl = `${location.origin}/_next/data/${buildId}/${locale}/${clientNamespace}/${careerSiteXRefCode}/jobs/${id}.json?external=true&clientNamespace=${clientNamespace}&careerSiteXRefCode=${careerSiteXRefCode}&id=${id}`;
      const res = await fetch(jsonUrl, { credentials: 'include' });
      if (res.ok) {
        const payload = await res.json();
        const fromJson = payload?.pageProps?.jobData || payload?.props?.pageProps?.jobData || null;
        if (fromJson) return { source: 'next-data-json', jsonUrl, jobData: fromJson };
      }
    }
    return null;
  });

  if (!data?.jobData) return null;
  const text = stringifyDayforceData(data.jobData);
  return {
    source: data.source || 'dayforce',
    jsonUrl: data.jsonUrl || null,
    text,
    workArrangement: data.jobData?.hasVirtualLocation ? 'remote' : inferWorkArrangementFromText(text),
  };
}

async function extractWorkdayFallback(page, sourceUrl) {
  if (!isLikelyWorkdayUrl(sourceUrl)) return null;
  const pathParts = parseWorkdayPathParts(sourceUrl);
  if (!pathParts) return null;

  const reqToken = parseWorkdayReqToken(sourceUrl);
  const result = await page.evaluate(async ({ origin, tenant, site, reqToken }) => {
    const endpoint = `${origin}/wday/cxs/${tenant}/${site}/jobs`;
    const baseBody = {
      appliedFacets: {},
      limit: 20,
      offset: 0,
      searchText: reqToken || '',
    };

    async function fetchJobs(searchText) {
      const body = { ...baseBody, searchText: searchText || '' };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return res.json();
    }

    const tokenData = await fetchJobs(reqToken);
    const broadData = tokenData?.jobPostings?.length ? tokenData : await fetchJobs('');
    const jobPostings = broadData?.jobPostings || [];
    if (!jobPostings.length) return null;

    const loweredToken = String(reqToken || '').toLowerCase();
    let chosen = jobPostings.find((item) =>
      loweredToken && String(item?.externalPath || '').toLowerCase().includes(loweredToken)
    );
    if (!chosen && loweredToken) {
      chosen = jobPostings.find((item) =>
        String(item?.title || '').toLowerCase().includes(loweredToken)
      );
    }
    if (!chosen) chosen = jobPostings[0];

    const response = {
      endpoint,
      reqToken,
      totalPostings: jobPostings.length,
      posting: chosen,
    };
    const externalPath = String(chosen?.externalPath || '').trim();
    if (externalPath) {
      const detailEndpoint = `${origin}/wday/cxs/${tenant}/${site}${externalPath}`;
      const detailRes = await fetch(detailEndpoint, {
        method: 'GET',
        headers: { 'accept': 'application/json' },
        credentials: 'include',
      });
      if (detailRes.ok) {
        response.detailEndpoint = detailEndpoint;
        response.detail = await detailRes.json();
      }
    }
    if (response.detail?.jobPostingInfo?.jobRequisitionLocation?.descriptor) {
      response.jobRequisitionLocationDescriptor = String(
        response.detail.jobPostingInfo.jobRequisitionLocation.descriptor
      );
    }
    return response;
  }, { ...pathParts, reqToken });

  if (!result?.posting) return null;
  const detailText = stringifyWorkdayDetail(result.detail);
  const summaryText = stringifyWorkdayPosting(result.posting);
  const text = detailText && detailText.length > summaryText.length ? detailText : summaryText;
  return {
    source: 'workday-cxs',
    endpoint: result.endpoint,
    detailEndpoint: result.detailEndpoint || null,
    reqToken: result.reqToken,
    totalPostings: result.totalPostings,
    text,
    jobRequisitionLocationDescriptor: result.jobRequisitionLocationDescriptor || null,
    workArrangement: inferWorkArrangementFromText(
      `${result.jobRequisitionLocationDescriptor || ''}\n${text}`
    ),
  };
}

async function extractFromUrl(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      // Some enterprise ATS pages (SAP/SuccessFactors, Dayforce variants)
      // can be slow or delayed by anti-bot scripts; retry with a longer budget.
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    }
    await page.waitForTimeout(2500);
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const finalUrl = page.url();
    let liveness = inferLiveness(bodyText, finalUrl);
    let finalText = bodyText.trim();
    let fallback = null;
    const shouldTryDayforceFallback = (
      isLikelyDayforceUrl(finalUrl) &&
      (
        finalText.length < 1200 ||
        /cookie preferences|reject|accept all|search jobs/i.test(finalText) ||
        liveness.result !== 'active'
      )
    );
    if (shouldTryDayforceFallback) {
      const dayforceFallback = await extractDayforceFallback(page, finalUrl);
      if (dayforceFallback?.text && dayforceFallback.text.length > finalText.length) {
        fallback = dayforceFallback;
        finalText = dayforceFallback.text;
        liveness = {
          result: 'active',
          reason: 'dayforce next-data fallback extracted posting',
        };
      }
    }

    const shouldTryWorkdayFallback = (
      isLikelyWorkdayUrl(finalUrl) &&
      (
        finalText.length < 800 ||
        liveness.result === 'expired' ||
        /jobs?\s+found|search for jobs page is loaded|not found/i.test(finalText)
      )
    );
    if (shouldTryWorkdayFallback) {
      const workdayFallback = await extractWorkdayFallback(page, finalUrl);
      if (workdayFallback?.text && workdayFallback.text.length > finalText.length) {
        fallback = workdayFallback;
        finalText = workdayFallback.text;
        liveness = {
          result: 'active',
          reason: 'workday cxs fallback extracted posting',
        };
      }
    }

    return {
      title,
      url: finalUrl,
      text: finalText,
      bodyTextChars: finalText.length,
      applyDetected: liveness.result === 'active',
      liveness,
      fallback,
    };
  } finally {
    await browser.close();
  }
}

function parseGeminiEvalOutput(stdout) {
  const reportMatch = stdout.match(/Report saved:\s+reports\/([^\r\n]+)/i);
  const scoreLine = stdout.match(/Score:\s+([0-9.]+)\/5\s+\|\s+Archetype:\s+(.+?)\s+\|\s+Legitimacy:\s+(.+)/i);
  return {
    reportRel: reportMatch ? `reports/${reportMatch[1].trim()}` : null,
    score: scoreLine ? scoreLine[1].trim() : null,
    archetype: scoreLine ? scoreLine[2].trim() : null,
    legitimacy: scoreLine ? scoreLine[3].trim() : null,
  };
}

function patchReportHeader(reportPath, url, pdfLabel = 'pending') {
  const content = readFileSync(reportPath, 'utf-8');
  if (content.includes('**URL:**')) return false;
  const lines = content.split(/\r?\n/);
  const output = [];
  let inserted = false;
  for (const line of lines) {
    output.push(line);
    if (!inserted && /^\*\*Score:\*\*/.test(line)) {
      output.push(`**URL:** ${url || 'inline text'}`);
      inserted = true;
    }
  }
  if (!content.includes('**PDF:**')) {
    output.splice(5, 0, `**PDF:** ${pdfLabel}`);
  }
  writeFileSync(reportPath, output.join('\n'), 'utf-8');
  return true;
}

function parseReportMeta(reportPath) {
  const content = readFileSync(reportPath, 'utf-8');
  const title = content.match(/^#\s+Evaluation:\s+(.+?)\s+—\s+(.+)$/m);
  return {
    company: title ? title[1].trim() : 'Unknown Company',
    role: title ? title[2].trim() : 'Unknown Role',
    content,
  };
}

function buildHybridBridgePayload(args, extracted, tmpFile, sourceKind, sourceUrl) {
  const bodyText = extracted?.text || readFileSync(tmpFile, 'utf-8');
  const recommendedProfileMode = inferProfileMode(bodyText, sourceUrl || args.url || '');
  return {
    ok: true,
    mode: 'hybrid-preflight',
    source_kind: sourceKind,
    requested_url: args.url || null,
    final_url: extracted?.url || sourceUrl || null,
    page_title: extracted?.title || null,
    result: extracted?.liveness?.result || (sourceKind === 'url' ? 'uncertain' : 'provided'),
    reason: extracted?.liveness?.reason || (sourceKind === 'url' ? 'extracted without liveness detail' : 'provided text or file'),
    apply_detected: extracted?.applyDetected ?? null,
    body_text: bodyText,
    body_text_chars: extracted?.bodyTextChars ?? bodyText.trim().length,
    jd_file: tmpFile,
    extraction_fallback: extracted?.fallback || null,
    work_arrangement: extracted?.fallback?.workArrangement || inferWorkArrangementFromText(extracted?.text || ''),
    location_signal: extracted?.fallback?.jobRequisitionLocationDescriptor || null,
    profile_mode: 'tstc',
    recommended_cv_source: 'cv-tstc.md',
    next_step: args.withPackage
      ? 'Use the extracted posting to evaluate in conversation, persist with record_evaluation, then build the package through the hybrid package flow.'
      : 'Use the extracted posting to evaluate in conversation, then persist the result with record_evaluation.',
  };
}

async function main() {
  const args = parseArgs(process.argv);
  mkdirSync(PATHS.output, { recursive: true });

  let jdText = '';
  let sourceUrl = args.url || null;
  let extracted = null;
  let sourceKind = 'text';
  if (args.url) {
    sourceKind = 'url';
    extracted = await extractFromUrl(args.url);
    jdText = extracted.text;
    sourceUrl = extracted.url;
  } else if (args.jdFile) {
    sourceKind = 'jd-file';
    jdText = readFileSync(resolve(args.jdFile), 'utf-8');
  } else {
    jdText = String(args.text || '');
  }

  if (!jdText.trim()) {
    console.error('Job description is empty after extraction.');
    process.exit(1);
  }

  const tmpFile = join(PATHS.output, `jd-${slugify(sourceUrl || 'inline')}-${todayIso()}.txt`);
  writeFileSync(tmpFile, jdText, 'utf-8');

  if (shouldUseHybridBridge(args.client)) {
    console.log(JSON.stringify(buildHybridBridgePayload(args, extracted, tmpFile, sourceKind, sourceUrl), null, 2));
    return;
  }

  const evalRun = runNodeScript('gemini-eval.mjs', ['--file', tmpFile], { timeout_ms: 600000 });
  if (!evalRun.ok) {
    console.error(evalRun.stderr || evalRun.stdout || 'Gemini evaluation failed.');
    logAction({
      actor: 'gemini-auto-pipeline',
      action: 'evaluate',
      url: sourceUrl,
      status: 'failed',
      error: evalRun.stderr || evalRun.stdout || 'Gemini evaluation failed.',
    });
    process.exit(evalRun.status || 1);
  }

  const parsed = parseGeminiEvalOutput(evalRun.stdout);
  if (!parsed.reportRel) {
    console.error('Could not determine saved report path from gemini-eval output.');
    process.exit(1);
  }

  const reportPath = join(PATHS.root, parsed.reportRel);
  patchReportHeader(reportPath, sourceUrl, args.withPackage ? 'package pending' : '❌');
  const reportMeta = parseReportMeta(reportPath);

  const score = parsed.score ? `${parsed.score}/5` : 'N/A';
  const trackerNum = nextTrackerNumber();
  const date = todayIso();
  const reportNumMatch = parsed.reportRel.match(/reports\/(\d{3})-/);
  const reportNum = reportNumMatch ? reportNumMatch[1] : String(trackerNum).padStart(3, '0');
  const reportCell = `[${reportNum}](${parsed.reportRel.replace(/\\/g, '/')})`;
  const note = `Gemini eval ${score}. Legitimacy: ${parsed.legitimacy || 'unknown'}.`;

  let packageRun = null;
  let pdfEmoji = '❌';
  if (args.withPackage && !args.dryRun) {
    packageRun = runNodeScript('gemini-package.mjs', [
      '--jd-file', tmpFile,
      '--report', reportPath,
      '--company', reportMeta.company,
      '--role', reportMeta.role,
      ...(sourceUrl ? ['--url', sourceUrl] : []),
    ], { timeout_ms: 600000 });
    if (!packageRun.ok) {
      console.error(packageRun.stderr || packageRun.stdout || 'Package generation failed.');
      process.exit(packageRun.status || 1);
    }
    pdfEmoji = '✅';
  }

  if (!args.dryRun) {
    const additionPath = writeTrackerAddition({
      num: trackerNum,
      date,
      company: reportMeta.company,
      role: reportMeta.role,
      status: 'Evaluated',
      score,
      pdf: pdfEmoji,
      report: reportCell,
      notes: note,
    });
    const merge = mergeTrackerAndVerify();
    if (!merge.ok) {
      console.error(merge.verify?.stdout || merge.merge.stdout || 'Tracker merge/verify failed.');
      process.exit(1);
    }

    logAction({
      actor: 'gemini-auto-pipeline',
      action: 'evaluate',
      url: sourceUrl,
      company: reportMeta.company,
      role: reportMeta.role,
      score,
      report: reportPath,
      tracker_addition: additionPath,
      package_generated: Boolean(packageRun),
    });
  }

  console.log(JSON.stringify({
    ok: true,
    company: reportMeta.company,
    role: reportMeta.role,
    score,
    legitimacy: parsed.legitimacy,
    archetype: parsed.archetype,
    report: reportPath,
    jd_file: tmpFile,
    package: packageRun && packageRun.ok ? JSON.parse(packageRun.stdout) : null,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
