#!/usr/bin/env node

/**
 * build-cover-letter.mjs — Structured cover letter JSON -> HTML -> optional PDF
 *
 * Usage:
 *   node build-cover-letter.mjs <letter.json> [--html <output.html>] [--pdf <output.pdf>] [--format=letter|a4]
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, parse, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
const PDF_SCRIPT_PATH = join(ROOT, 'generate-pdf.mjs');

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    inputPath: null,
    htmlPath: null,
    pdfPath: null,
    format: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!parsed.inputPath && !arg.startsWith('--')) {
      parsed.inputPath = arg;
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
    }
  }

  if (!parsed.inputPath) {
    console.error('Usage: node build-cover-letter.mjs <letter.json> [--html <output.html>] [--pdf <output.pdf>] [--format=letter|a4]');
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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inferOutputPath(inputPath, explicitPath, extension) {
  if (explicitPath) return resolve(explicitPath);
  const parsed = parse(inputPath);
  const stem = parsed.name.replace(/\.letter$/, '');
  return resolve(parsed.dir, `${stem}.${extension}`);
}

function runPdfGenerator(htmlPath, pdfPath, format) {
  const result = spawnSync(process.execPath, [PDF_SCRIPT_PATH, htmlPath, pdfPath, `--format=${format}`], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function renderParagraphs(paragraphs) {
  return paragraphs.map((paragraph) => `    <p>${escapeHtml(paragraph)}</p>`).join('\n\n');
}

function buildHtml({ candidate, letter, format }) {
  const recipientLines = (letter.recipient_lines || []).map((line) => `      <div>${escapeHtml(line)}</div>`).join('\n');
  return `<!DOCTYPE html>
<html lang="${escapeHtml(letter.language || 'en')}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(candidate.full_name || '')} - Cover Letter</title>
<style>
  body {
    font-family: Georgia, "Times New Roman", serif;
    color: #111;
    background: #fff;
    margin: 0;
    padding: 0;
  }
  .page {
    max-width: ${format === 'letter' ? '8.5in' : '210mm'};
    margin: 0 auto;
    padding: 0.75in;
    line-height: 1.55;
    font-size: 12pt;
  }
  .header, .meta {
    margin-bottom: 24px;
  }
  .header div, .meta div {
    margin-bottom: 4px;
  }
  p {
    margin: 0 0 14px 0;
  }
</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div><strong>${escapeHtml(candidate.full_name || '')}</strong></div>
      <div>${escapeHtml(candidate.location || '')}</div>
      <div>${escapeHtml(candidate.email || '')}</div>
      <div>${escapeHtml(candidate.phone || '')}</div>
      <div>${escapeHtml((candidate.linkedin || '').startsWith('http') ? candidate.linkedin : `https://${candidate.linkedin || ''}`)}</div>
    </div>

    <div class="meta">
      <div>${escapeHtml(letter.date || '')}</div>
${recipientLines}
    </div>

    <p>${escapeHtml(letter.greeting || 'Dear Hiring Team,')}</p>

${renderParagraphs(letter.paragraphs || [])}

    <p>${escapeHtml(letter.closing || 'Sincerely,')}</p>

    <p>${escapeHtml(candidate.full_name || '')}</p>
  </div>
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = resolve(args.inputPath);
  const letter = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const profile = parseSimpleYaml(readFileSync(PROFILE_PATH, 'utf-8'));
  const candidate = profile.candidate || {};
  const format = (args.format || letter.format || 'letter').toLowerCase();

  if (!['letter', 'a4'].includes(format)) {
    console.error(`Invalid format "${format}". Use letter or a4.`);
    process.exit(1);
  }

  const htmlPath = inferOutputPath(inputPath, args.htmlPath || letter.html_path, 'html');
  const pdfPath = args.pdfPath || letter.pdf_path ? inferOutputPath(inputPath, args.pdfPath || letter.pdf_path, 'pdf') : null;

  const html = buildHtml({ candidate, letter, format });
  writeFileSync(htmlPath, html);

  const summary = {
    letter: inputPath,
    html: htmlPath,
    pdf: pdfPath,
    format,
  };

  if (pdfPath) runPdfGenerator(htmlPath, pdfPath, format);

  console.log(JSON.stringify(summary, null, 2));
}

main();
