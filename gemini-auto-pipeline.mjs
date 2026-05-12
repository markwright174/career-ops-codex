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
    withPackage: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url') parsed.url = args[++i];
    else if (arg === '--jd-file') parsed.jdFile = args[++i];
    else if (arg === '--text') parsed.text = args[++i];
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

async function extractFromUrl(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    return {
      title,
      url: page.url(),
      text: bodyText.trim(),
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

async function main() {
  const args = parseArgs(process.argv);
  mkdirSync(PATHS.output, { recursive: true });

  let jdText = '';
  let sourceUrl = args.url || null;
  if (args.url) {
    const extracted = await extractFromUrl(args.url);
    jdText = extracted.text;
    sourceUrl = extracted.url;
  } else if (args.jdFile) {
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
