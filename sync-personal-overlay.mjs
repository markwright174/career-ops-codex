#!/usr/bin/env node

/**
 * sync-personal-overlay.mjs
 *
 * Renders the active personal profile from a private local overlay file.
 *
 * This is intentionally small. It lets the user keep profile-specific state in
 * one ignored file while still writing the canonical repo files that Chat and
 * the rest of the pipeline already read.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOCAL_DIR = join(ROOT, 'local');
const OVERLAY_PATH = join(LOCAL_DIR, 'personal-overlay.yml');
const OVERLAY_EXAMPLE_PATH = join(LOCAL_DIR, 'personal-overlay.example.yml');

function parseArgs(argv) {
  const args = {
    profile: null,
    dryRun: false,
    list: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--dry-run') {
      args.dryRun = true;
    } else if (value === '--list') {
      args.list = true;
    } else if (value === '--profile') {
      args.profile = argv[i + 1] || null;
      i += 1;
    } else if (value.startsWith('--profile=')) {
      args.profile = value.slice('--profile='.length) || null;
    }
  }

  return args;
}

function loadOverlay() {
  const sourcePath = existsSync(OVERLAY_PATH) ? OVERLAY_PATH : OVERLAY_EXAMPLE_PATH;
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Missing local overlay. Create ${OVERLAY_PATH} from the example file in local/.`
    );
  }

  const raw = readFileSync(sourcePath, 'utf8');
  const data = yaml.load(raw) || {};
  return { sourcePath, data };
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimEnd() + '\n';
}

function renderYaml(value) {
  if (!value) return '';
  if (typeof value === 'string') return normalizeText(value);
  return normalizeText(yaml.dump(value, { lineWidth: 120, noRefs: true }));
}

function ensureParent(relativePath) {
  const absPath = join(ROOT, relativePath);
  mkdirSync(dirname(absPath), { recursive: true });
  return absPath;
}

function writeText(relativePath, value, dryRun, label) {
  const normalized = normalizeText(value);
  const absPath = ensureParent(relativePath);
  if (dryRun) {
    console.log(`Would write ${label}: ${relativePath}`);
    return;
  }
  writeFileSync(absPath, normalized, 'utf8');
  console.log(`Wrote ${label}: ${relativePath}`);
}

function copyManagedFile(relativeSource, relativeTarget, dryRun, label) {
  const absSource = join(ROOT, relativeSource);
  const absTarget = ensureParent(relativeTarget);
  if (!existsSync(absSource)) {
    throw new Error(`Missing source file for ${label}: ${relativeSource}`);
  }
  if (dryRun) {
    console.log(`Would copy ${label}: ${relativeSource} -> ${relativeTarget}`);
    return;
  }
  copyFileSync(absSource, absTarget);
  console.log(`Copied ${label}: ${relativeSource} -> ${relativeTarget}`);
}

function selectProfile(data, requestedProfile) {
  const profiles = data.profiles || {};
  const active = requestedProfile || data.active_profile;
  if (!active) {
    throw new Error('No active profile selected. Set active_profile in local/personal-overlay.yml.');
  }
  if (!profiles[active]) {
    throw new Error(
      `Unknown profile "${active}". Available profiles: ${Object.keys(profiles).join(', ') || 'none'}`
    );
  }
  return { name: active, profile: profiles[active] };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const overlay = loadOverlay();

  if (args.list) {
    const profiles = overlay.data.profiles || {};
    console.log(`Overlay source: ${overlay.sourcePath}`);
    console.log(`Active profile: ${overlay.data.active_profile || '(none)'}`);
    for (const [name, profile] of Object.entries(profiles)) {
      const marker = name === overlay.data.active_profile ? '*' : ' ';
      const label = profile.label || name;
      console.log(`${marker} ${name}: ${label}`);
    }
    return;
  }

  const { name, profile } = selectProfile(overlay.data, args.profile);
  const cvSource = profile.cv_source;
  const cvTarget = profile.cv_target || 'cv.md';

  if (!cvSource) {
    throw new Error(`Profile "${name}" is missing cv_source in ${overlay.sourcePath}`);
  }

  console.log(`Active profile: ${name}`);
  console.log(`Overlay source: ${overlay.sourcePath}`);

  copyManagedFile(cvSource, cvTarget, args.dryRun, 'CV');

  if (profile.profile_yaml) {
    writeText('config/profile.yml', renderYaml(profile.profile_yaml), args.dryRun, 'profile YAML');
  }
  if (profile.profile_md) {
    writeText('modes/_profile.md', profile.profile_md, args.dryRun, 'profile mode');
  }
  if (profile.article_digest_md) {
    writeText('article-digest.md', profile.article_digest_md, args.dryRun, 'article digest');
  }

  if (profile.notes) {
    console.log(`Note: ${profile.notes}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
