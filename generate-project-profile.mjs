#!/usr/bin/env node

/**
 * generate-project-profile.mjs — build a ChatGPT-friendly profile mirror
 *
 * Generates docs/PROJECT_PROFILE.md from:
 * - config/profile.yml
 * - modes/_profile.md
 * - article-digest.md
 *
 * This file is meant to be attached to ChatGPT Projects when direct YAML
 * sources are inconvenient or unsupported.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
const USER_PROFILE_PATH = join(ROOT, 'modes', '_profile.md');
const ARTICLE_DIGEST_PATH = join(ROOT, 'article-digest.md');
const OUTPUT_PATH = join(ROOT, 'docs', 'PROJECT_PROFILE.md');

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function extractSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
  const match = markdown.match(regex);
  return match ? match[1].trim() : '';
}

function cleanBullet(line) {
  return line
    .replace(/^\s*[-*]\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/\*\*/g, '')
    .trim();
}

function firstBullets(section, limit = 6) {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map(cleanBullet)
    .slice(0, limit);
}

function firstBulletsUntil(section, stopPattern, limit = 6) {
  const lines = section.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (stopPattern.test(line)) break;
    if (/^[-*]\s+/.test(line.trim())) kept.push(cleanBullet(line));
    if (kept.length >= limit) break;
  }
  return kept;
}

function beforeMarker(section, marker) {
  const idx = section.toLowerCase().indexOf(marker.toLowerCase());
  return idx === -1 ? section : section.slice(0, idx);
}

function parseTargetRoles(markdown) {
  const section = extractSection(markdown, 'Target Roles');
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (trimmed.includes('Archetype') || trimmed.includes('---')) continue;
    const parts = trimmed.split('|').map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 3) {
      rows.push({
        archetype: parts[0].replace(/\*\*/g, ''),
        fit: parts[1],
        value: parts[2],
      });
    }
  }
  return rows;
}

function parseAdaptiveFraming(markdown) {
  const section = extractSection(markdown, 'Adaptive Framing');
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (trimmed.includes('If the role is') || trimmed.includes('---')) continue;
    const parts = trimmed.split('|').map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      rows.push({
        role: parts[0],
        emphasize: parts[1],
      });
    }
  }
  return rows;
}

function compact(values) {
  return values.filter(Boolean);
}

function renderList(items) {
  if (!items.length) return '- None listed';
  return items.map((item) => `- ${item}`).join('\n');
}

function normalizeLane(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function laneMatches(role, lanes) {
  const normalizedRole = normalizeLane(role);
  return lanes.some((lane) => {
    const normalizedLane = normalizeLane(lane);
    return normalizedLane === normalizedRole
      || normalizedLane.includes(normalizedRole)
      || normalizedRole.includes(normalizedLane);
  });
}

function detectInconsistencies(primary, secondary, targetRoleRows) {
  const notes = [];

  for (const row of targetRoleRows) {
    const fit = String(row.fit || '').toLowerCase();
    if (fit === 'primary' && !laneMatches(row.archetype, primary)) {
      notes.push(`Target role framing marks "${row.archetype}" as Primary, but it is not listed in target_roles.primary.`);
    }
    if (fit === 'secondary' && !laneMatches(row.archetype, [...primary, ...secondary])) {
      notes.push(`Target role framing marks "${row.archetype}" as Secondary, but it is not listed in target_roles.primary or target_roles.secondary.`);
    }
  }

  return notes;
}

function main() {
  if (!existsSync(PROFILE_PATH)) {
    console.error(`Missing required file: ${PROFILE_PATH}`);
    process.exit(1);
  }

  const profile = yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
  const userProfile = readOptional(USER_PROFILE_PATH);
  const articleDigest = readOptional(ARTICLE_DIGEST_PATH);

  const candidate = profile.candidate || {};
  const targetRoles = profile.target_roles || {};
  const narrative = profile.narrative || {};
  const compensation = profile.compensation || {};
  const location = profile.location || {};
  const preferences = narrative.preferences || {};

  const targetRoleRows = parseTargetRoles(userProfile);
  const framingRows = parseAdaptiveFraming(userProfile);
  const crossCutting = firstBullets(extractSection(userProfile, 'Cross-Cutting Advantage'), 8);
  const evidenceBoundaries = firstBullets(
    beforeMarker(extractSection(userProfile, 'Evidence Boundaries'), 'Confirmed authoring and creative tools:'),
    8
  );
  const aiWorkflow = firstBullets(
    beforeMarker(extractSection(articleDigest, 'AI-Supported Learning Workflow'), 'Evidence boundaries:'),
    8
  );
  const healthcareDomain = firstBullets(extractSection(articleDigest, 'Healthcare Education Domain'), 5);
  const toolAdditions = firstBullets(
    beforeMarker(extractSection(articleDigest, 'Confirmed Tool Additions'), 'Evidence boundaries:'),
    5
  );

  const primary = Array.isArray(targetRoles.primary) ? targetRoles.primary : [];
  const secondary = Array.isArray(targetRoles.secondary) ? targetRoles.secondary : [];
  const inconsistencies = detectInconsistencies(primary, secondary, targetRoleRows);

  const generatedAt = new Date().toISOString().slice(0, 10);

  const content = `# Project Profile

_Generated from \`config/profile.yml\`, \`modes/_profile.md\`, and \`article-digest.md\` on ${generatedAt}. Regenerate with \`node generate-project-profile.mjs\` after profile changes._

## Identity

- Name: ${candidate.full_name || 'Unknown'}
- Location: ${candidate.location || location.city || 'Unknown'}
- Timezone: ${location.timezone || 'Unknown'}
- Work authorization: ${location.visa_status || 'Unknown'}
- LinkedIn: ${candidate.linkedin || 'Not listed'}

## Compensation And Location Policy

- Target range: ${compensation.target_range || 'Not listed'}
- Minimum: ${compensation.minimum || 'Not listed'}
- Currency: ${compensation.currency || 'Not listed'}
- Location preference: ${compensation.location_flexibility || 'Not listed'}
- Remote U.S. roles are preferred.
- Hybrid roles outside Houston should score down.
- On-site roles outside Houston should usually be treated as SKIP.

## Target Lanes

### Primary
${renderList(primary)}

### Secondary
${renderList(secondary)}

### Target Role Framing
${renderList(targetRoleRows.slice(0, 10).map((row) => `${row.archetype} (${row.fit}): ${row.value}`))}

## Core Positioning

- Headline: ${narrative.headline || 'Not listed'}
- Exit story: ${narrative.exit_story || 'Not listed'}

### Superpowers
${renderList(Array.isArray(narrative.superpowers) ? narrative.superpowers : [])}

### Cross-Cutting Advantages
${renderList(crossCutting)}

## Scoring Preferences

- Do not score down solely because a role is individual contributor if compensation, scope, and fit are strong.
- Great-fit roles near the compensation floor can still be considered when the work is unusually strong.
- Role level flexibility: ${preferences.role_level_flexibility || 'Not listed'}

## Adaptive Framing
${renderList(framingRows.slice(0, 8).map((row) => `${row.role}: emphasize ${row.emphasize}`))}

## Verified Strengths
${renderList(compact([
  ...aiWorkflow,
  ...healthcareDomain,
  ...toolAdditions,
]))}

## Evidence Boundaries
${renderList(evidenceBoundaries)}

## Quick Guidance For ChatGPT Frontend

- Use the repo command layer first: \`npm run chat -- <action>\`.
- Default scan action: \`npm run chat -- scan-safe --shortlist\`.
- Use \`npm run chat -- shortlist\` before escalating roles for deeper review.
- Use \`npm run chat -- quick-apply\` when the user asks for the current default resume or cover letter.
- Do not invent a parallel tracker, scanner, or resume pipeline.
- Never submit applications on the user's behalf.
`;

  writeFileSync(OUTPUT_PATH, content, 'utf-8');
  console.log(JSON.stringify({
    ok: true,
    output: OUTPUT_PATH,
    generated_at: generatedAt,
    primary_roles: primary.length,
    secondary_roles: secondary.length,
    framing_rows: targetRoleRows.length,
    candidate: {
      full_name: candidate.full_name || null,
      location: candidate.location || location.city || null,
      timezone: location.timezone || null,
      work_authorization: location.visa_status || null,
      linkedin: candidate.linkedin || null,
    },
    compensation: {
      target_range: compensation.target_range || null,
      minimum: compensation.minimum || null,
      currency: compensation.currency || null,
      location_flexibility: compensation.location_flexibility || null,
    },
    location_policy: {
      remote_preferred: true,
      hybrid_outside_houston_scores_down: true,
      onsite_outside_houston_usually_skip: true,
    },
    target_lanes: {
      primary,
      secondary,
    },
    target_role_rows: targetRoleRows,
    positioning: {
      headline: narrative.headline || null,
      exit_story: narrative.exit_story || null,
      superpowers: Array.isArray(narrative.superpowers) ? narrative.superpowers : [],
      cross_cutting_advantages: crossCutting,
    },
    scoring_preferences: {
      no_ic_penalty_for_strong_fit: true,
      near_floor_roles_can_still_be_considered: true,
      role_level_flexibility: preferences.role_level_flexibility || null,
      individual_contributor_rule: preferences.individual_contributor_rule || null,
      low_comp_exception_rule: preferences.low_comp_exception_rule || null,
    },
    adaptive_framing: framingRows,
    verified_strengths: compact([
      ...aiWorkflow,
      ...healthcareDomain,
      ...toolAdditions,
    ]),
    evidence_boundaries: evidenceBoundaries,
    inconsistencies,
  }, null, 2));
}

main();
