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
const HOST = process.env.CAREER_OPS_BRIDGE_HOST || '127.0.0.1';
const TOKEN = (process.env.CAREER_OPS_BRIDGE_TOKEN || '').trim();
const ALLOW_WRITE = process.env.CAREER_OPS_BRIDGE_ALLOW_WRITE === '1';
const DEBUG_ERRORS = process.env.CAREER_OPS_BRIDGE_DEBUG === '1';
const MAX_BODY_BYTES = parseInt(process.env.CAREER_OPS_BRIDGE_MAX_BODY_BYTES || '65536', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.CAREER_OPS_BRIDGE_RATE_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.CAREER_OPS_BRIDGE_RATE_MAX_REQUESTS || '30', 10);
const rateLimitState = new Map();

const READ_ACTIONS = new Set([
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
]);

const WRITE_ACTIONS = new Set([
  'evaluate',
  'package',
  'apply-prep',
]);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${TOKEN}`;
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data, 'utf-8') > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
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

function classifyAction(action) {
  if (WRITE_ACTIONS.has(action)) return 'write';
  if (READ_ACTIONS.has(action)) return 'read';
  return null;
}

function clientKey(req) {
  const auth = req.headers.authorization || 'anonymous';
  const remote = req.socket.remoteAddress || 'unknown';
  return `${remote}|${auth}`;
}

function checkRateLimit(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = rateLimitState.get(key);
  if (!entry || (now - entry.startedAt) >= RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(key, { startedAt: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0, retry_after_ms: RATE_LIMIT_WINDOW_MS - (now - entry.startedAt) };
  }

  entry.count += 1;
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - entry.count };
}

function errorBody(action, message, run) {
  const body = {
    ok: false,
    action,
    error: message,
  };
  if (run) {
    body.exit_code = run.status;
  }
  if (DEBUG_ERRORS && run) {
    body.stdout = run.stdout.trim();
    body.stderr = run.stderr.trim();
  }
  return body;
}

if (!TOKEN) {
  console.error('CAREER_OPS_BRIDGE_TOKEN is required. Refusing to start without authentication.');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const requestHost = req.headers.host || `${HOST}:${PORT}`;
  const url = new URL(req.url || '/', `http://${requestHost}`);

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const rate = checkRateLimit(req);
  if (!rate.allowed) {
    return sendJson(res, 429, {
      ok: false,
      error: 'Rate limit exceeded',
      retry_after_ms: rate.retry_after_ms,
    });
  }

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'career-ops-bridge',
      host: HOST,
      port: PORT,
      write_actions_enabled: ALLOW_WRITE,
    });
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
  const actionType = classifyAction(action);
  if (!actionType) {
    return sendJson(res, 400, { ok: false, error: `Action "${action}" is not allowed.` });
  }
  if (actionType === 'write' && !ALLOW_WRITE) {
    return sendJson(res, 403, {
      ok: false,
      action,
      error: 'Write actions are disabled. Set CAREER_OPS_BRIDGE_ALLOW_WRITE=1 to enable them.',
    });
  }
  if (payload.flags !== undefined && (typeof payload.flags !== 'object' || Array.isArray(payload.flags))) {
    return sendJson(res, 400, { ok: false, action, error: 'flags must be a JSON object.' });
  }

  const args = [action, ...flagsToArgs(payload.flags || {})];
  const requestedTimeout = Number.isFinite(payload.timeout_ms) ? payload.timeout_ms : 900000;
  const run = runNodeScript('chat-ops.mjs', args, {
    timeout_ms: Math.max(1000, Math.min(requestedTimeout, 900000)),
  });

  logAction({
    actor: 'bridge-server',
    action: `bridge:${action}`,
    action_type: actionType,
    request_flags: payload.flags || {},
    ok: run.ok,
    exit_code: run.status,
  });

  if (!run.ok) {
    return sendJson(res, 500, errorBody(action, 'Underlying action failed.', run));
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
    host: HOST,
    port: PORT,
    token_required: true,
    write_actions_enabled: ALLOW_WRITE,
    endpoint: `http://${HOST}:${PORT}/action`,
  }, null, 2));
});
