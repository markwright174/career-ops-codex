#!/usr/bin/env node

/**
 * bridge-server.mjs — local JSON bridge for career-ops
 *
 * This is a narrow HTTP wrapper around chat-ops.mjs and the explicit
 * repo actions. It is designed to be exposed later through a tunnel or
 * wrapped by an MCP server, but it is safe enough to run locally first.
 */

import http from 'http';
import { URL } from 'url';
import { logAction, ROOT, runNodeScript } from './repo-ops-lib.mjs';

const PORT = parseInt(process.env.CAREER_OPS_BRIDGE_PORT || '8787', 10);
const TOKEN = process.env.CAREER_OPS_BRIDGE_TOKEN || '';

const ALLOWED_ACTIONS = new Set([
  'help',
  'scan',
  'scan-safe',
  'inbox',
  'shortlist',
  'tracker',
  'applied',
  'evaluated',
  'verify',
  'sync-check',
  'project-profile',
  'patterns',
  'quick-apply',
  'reports',
  'liveness',
  'evaluate',
  'package',
  'apply-prep',
]);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function isAuthorized(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${TOKEN}`;
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function flagsToArgs(flags = {}) {
  const args = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value === false || value === null || value === undefined) continue;
    if (value === true) args.push(`--${key}`);
    else args.push(`--${key}`, String(value));
  }
  return args;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'career-ops-bridge', cwd: ROOT });
  }

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST' || url.pathname !== '/action') {
    return sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  let payload;
  try {
    payload = await bodyJson(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
  }

  const action = payload.action;
  if (!ALLOWED_ACTIONS.has(action)) {
    return sendJson(res, 400, { ok: false, error: `Action "${action}" is not allowed.` });
  }

  const args = [action, ...flagsToArgs(payload.flags || {})];
  const run = runNodeScript('chat-ops.mjs', args, { timeout_ms: payload.timeout_ms || 900000 });

  logAction({
    actor: 'bridge-server',
    action: `bridge:${action}`,
    request_flags: payload.flags || {},
    ok: run.ok,
    exit_code: run.status,
  });

  if (!run.ok) {
    return sendJson(res, 500, {
      ok: false,
      action,
      exit_code: run.status,
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    });
  }

  try {
    return sendJson(res, 200, {
      ok: true,
      action,
      result: JSON.parse(run.stdout),
    });
  } catch {
    return sendJson(res, 200, {
      ok: true,
      action,
      result: {
        raw_stdout: run.stdout.trim(),
        raw_stderr: run.stderr.trim(),
      },
    });
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({
    ok: true,
    service: 'career-ops-bridge',
    port: PORT,
    token_required: Boolean(TOKEN),
    endpoint: `http://127.0.0.1:${PORT}/action`,
  }, null, 2));
});
