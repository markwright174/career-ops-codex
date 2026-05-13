#!/usr/bin/env node

import http from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROOT, logAction, runNodeScript } from './repo-ops-lib.mjs';

const HOST = process.env.CAREER_OPS_MCP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.CAREER_OPS_MCP_PORT || '8790', 10);
const TOKEN = (process.env.CAREER_OPS_MCP_TOKEN || '').trim();
const ALLOW_WRITE = process.env.CAREER_OPS_MCP_ALLOW_WRITE === '1';
const MAX_BODY_BYTES = parseInt(process.env.CAREER_OPS_MCP_MAX_BODY_BYTES || '262144', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.CAREER_OPS_MCP_RATE_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.CAREER_OPS_MCP_RATE_MAX_REQUESTS || '60', 10);

const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];
const LATEST_PROTOCOL_VERSION = '2025-11-25';

const VERSION = readFileSync(join(ROOT, 'VERSION'), 'utf-8').trim();
const rateLimitState = new Map();

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendNoContent(res, status = 204) {
  res.writeHead(status);
  res.end();
}

function makeError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', error, id: id ?? null };
}

function makeResult(id, result) {
  return { jsonrpc: '2.0', result, id };
}

function isAuthorized(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${TOKEN}`;
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
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, retry_after_ms: RATE_LIMIT_WINDOW_MS - (now - entry.startedAt) };
  }

  entry.count += 1;
  return { allowed: true };
}

function readJsonBody(req) {
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
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
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
    if (value === true) {
      args.push(`--${key}`);
    } else {
      args.push(`--${key}`, String(value));
    }
  }
  return args;
}

function normalizeToolArgName(key) {
  return key.replace(/_/g, '-');
}

function toolText(name, payload) {
  const summary = [`Tool \`${name}\` completed.`];

  if (payload && typeof payload === 'object') {
    if (typeof payload.action === 'string') summary.push(`Action: ${payload.action}`);
    if (payload.ok === false) summary.push('Result indicates a failure.');
    if (typeof payload.total === 'number') summary.push(`Total: ${payload.total}`);
    if (typeof payload.filtered_total === 'number') summary.push(`Filtered total: ${payload.filtered_total}`);
    if (typeof payload.pending_count === 'number') summary.push(`Pending inbox: ${payload.pending_count}`);
    if (payload.scan_summary?.new_offers_added !== undefined) {
      summary.push(`New offers added: ${payload.scan_summary.new_offers_added}`);
    }
    if (payload.shortlist?.shortlist?.length !== undefined) {
      summary.push(`Shortlist count: ${payload.shortlist.shortlist.length}`);
    }
  }

  return `${summary.join('\n')}\n\n${JSON.stringify(payload, null, 2)}`;
}

function toolSuccess(name, payload) {
  return {
    content: [
      {
        type: 'text',
        text: toolText(name, payload),
      },
    ],
    structuredContent: payload,
  };
}

function toolError(message, details = {}) {
  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    structuredContent: details,
    isError: true,
  };
}

function runChatOps(action, flags = {}, positionals = []) {
  const cliArgs = [action, ...flagsToArgs(flags), ...positionals];
  const run = runNodeScript('chat-ops.mjs', cliArgs, { timeout_ms: 900000 });
  let parsed;
  try {
    parsed = run.stdout.trim() ? JSON.parse(run.stdout) : {};
  } catch {
    parsed = {
      raw_stdout: run.stdout.trim(),
      raw_stderr: run.stderr.trim(),
    };
  }

  return {
    ok: run.ok,
    exit_code: run.status,
    payload: parsed,
    stdout: run.stdout.trim(),
    stderr: run.stderr.trim(),
  };
}

function objectSchema(properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

const TOOLS = [
  {
    name: 'scan_safe_shortlist',
    title: 'Scan Safe Shortlist',
    kind: 'read',
    description: 'Run the repo scan, liveness-check new roles, and return shortlist buckets.',
    inputSchema: objectSchema({
      company: { type: 'string', description: 'Optional company slug/name filter for scan.mjs.' },
      mark_expired: { type: 'boolean', description: 'Mark expired inbox URLs as [!] in data/pipeline.md.' },
      include_issues: { type: 'boolean', description: 'Include already-flagged issue items in shortlist output.' },
    }),
    invoke(args = {}) {
      const flags = { shortlist: true };
      if (args.company) flags.company = args.company;
      if (args.mark_expired) flags['mark-expired'] = true;
      if (args.include_issues) flags['include-issues'] = true;
      return { action: 'scan-safe', flags };
    },
  },
  {
    name: 'show_inbox',
    title: 'Show Inbox',
    kind: 'read',
    description: 'Show pending and issue items from data/pipeline.md.',
    inputSchema: objectSchema({}),
    invoke() {
      return { action: 'inbox' };
    },
  },
  {
    name: 'shortlist_inbox',
    title: 'Shortlist Inbox',
    kind: 'read',
    description: 'Heuristically bucket inbox roles into shortlist, review, and reject.',
    inputSchema: objectSchema({
      include_issues: { type: 'boolean', description: 'Include already-flagged issue items in the triage pass.' },
    }),
    invoke(args = {}) {
      const flags = {};
      if (args.include_issues) flags['include-issues'] = true;
      return { action: 'shortlist', flags };
    },
  },
  {
    name: 'show_tracker',
    title: 'Show Tracker',
    kind: 'read',
    description: 'Summarize tracker rows with optional filters.',
    inputSchema: objectSchema({
      status: { type: 'string', description: 'Optional tracker status filter such as Applied or Evaluated.' },
      limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum number of rows to return.' },
      min_score: { type: 'number', minimum: 0, maximum: 5, description: 'Optional minimum score filter.' },
    }),
    invoke(args = {}) {
      const flags = {};
      if (args.status) flags.status = args.status;
      if (args.limit !== undefined) flags.limit = args.limit;
      if (args.min_score !== undefined) flags['min-score'] = args.min_score;
      return { action: 'tracker', flags };
    },
  },
  {
    name: 'show_applied',
    title: 'Show Applied',
    kind: 'read',
    description: 'Show the most recent Applied tracker rows.',
    inputSchema: objectSchema({
      limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum number of rows to return.' },
      min_score: { type: 'number', minimum: 0, maximum: 5, description: 'Optional minimum score filter.' },
    }),
    invoke(args = {}) {
      const flags = {};
      if (args.limit !== undefined) flags.limit = args.limit;
      if (args.min_score !== undefined) flags['min-score'] = args.min_score;
      return { action: 'applied', flags };
    },
  },
  {
    name: 'show_evaluated',
    title: 'Show Evaluated',
    kind: 'read',
    description: 'Show the most recent Evaluated tracker rows.',
    inputSchema: objectSchema({
      limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum number of rows to return.' },
      min_score: { type: 'number', minimum: 0, maximum: 5, description: 'Optional minimum score filter.' },
    }),
    invoke(args = {}) {
      const flags = {};
      if (args.limit !== undefined) flags.limit = args.limit;
      if (args.min_score !== undefined) flags['min-score'] = args.min_score;
      return { action: 'evaluated', flags };
    },
  },
  {
    name: 'show_patterns',
    title: 'Show Patterns',
    kind: 'read',
    description: 'Return structured pattern analysis from analyze-patterns.mjs.',
    inputSchema: objectSchema({}),
    invoke() {
      return { action: 'patterns' };
    },
  },
  {
    name: 'show_quick_apply',
    title: 'Show Quick Apply',
    kind: 'read',
    description: 'Return the current default CV and cover-letter artifact paths.',
    inputSchema: objectSchema({}),
    invoke() {
      return { action: 'quick-apply' };
    },
  },
  {
    name: 'verify_pipeline',
    title: 'Verify Pipeline',
    kind: 'read',
    description: 'Run verify-pipeline.mjs and return pass/fail with captured output.',
    inputSchema: objectSchema({}),
    invoke() {
      return { action: 'verify' };
    },
  },
  {
    name: 'check_liveness',
    title: 'Check Liveness',
    kind: 'read',
    description: 'Run Playwright liveness checks on one or more job URLs.',
    inputSchema: objectSchema({
      urls: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'One or more job URLs to check.',
      },
    }, ['urls']),
    invoke(args = {}) {
      return { action: 'liveness', positionals: Array.isArray(args.urls) ? args.urls : [] };
    },
  },
  {
    name: 'show_project_profile',
    title: 'Show Project Profile',
    kind: 'read',
    description: 'Generate and return the ChatGPT-friendly profile mirror.',
    inputSchema: objectSchema({}),
    invoke() {
      return { action: 'project-profile' };
    },
  },
  {
    name: 'show_reports',
    title: 'Show Reports',
    kind: 'read',
    description: 'Show recent evaluation reports.',
    inputSchema: objectSchema({
      limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum number of reports to return.' },
    }),
    invoke(args = {}) {
      const flags = {};
      if (args.limit !== undefined) flags.limit = args.limit;
      return { action: 'reports', flags };
    },
  },
  {
    name: 'evaluate_role',
    title: 'Evaluate Role',
    kind: 'write',
    description: 'Run the Gemini-backed evaluation pipeline for a role URL, JD file, or pasted JD text.',
    inputSchema: objectSchema({
      url: { type: 'string', description: 'Job posting URL.' },
      jd_file: { type: 'string', description: 'Absolute or repo-relative path to a JD text file.' },
      text: { type: 'string', description: 'Raw job description text.' },
      with_package: { type: 'boolean', description: 'Also generate the tailored package after evaluation.' },
    }),
    invoke(args = {}) {
      const flags = {};
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) flags[normalizeToolArgName(key)] = value;
      }
      return { action: 'evaluate', flags };
    },
  },
  {
    name: 'prepare_package',
    title: 'Prepare Package',
    kind: 'write',
    description: 'Generate a tailored CV and cover letter package from a JD and optional report context.',
    inputSchema: objectSchema({
      jd_file: { type: 'string', description: 'Absolute or repo-relative path to a JD text file.' },
      text: { type: 'string', description: 'Raw job description text.' },
      report: { type: 'string', description: 'Path to a saved report markdown file.' },
      company: { type: 'string', description: 'Company name.' },
      role: { type: 'string', description: 'Role title.' },
      url: { type: 'string', description: 'Original job URL for context.' },
    }),
    invoke(args = {}) {
      const flags = {};
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) flags[normalizeToolArgName(key)] = value;
      }
      return { action: 'package', flags };
    },
  },
  {
    name: 'prepare_application',
    title: 'Prepare Application',
    kind: 'write',
    description: 'Run evaluation and package generation together for a role URL, JD file, or pasted JD text.',
    inputSchema: objectSchema({
      url: { type: 'string', description: 'Job posting URL.' },
      jd_file: { type: 'string', description: 'Absolute or repo-relative path to a JD text file.' },
      text: { type: 'string', description: 'Raw job description text.' },
    }),
    invoke(args = {}) {
      const flags = {};
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) flags[normalizeToolArgName(key)] = value;
      }
      return { action: 'apply-prep', flags };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

function toolListResult() {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function negotiateProtocolVersion(requestedVersion) {
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
    return requestedVersion;
  }
  return LATEST_PROTOCOL_VERSION;
}

async function executeTool(toolName, args = {}) {
  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    return toolError(`Unknown tool "${toolName}".`, { available_tools: TOOLS.map((item) => item.name) });
  }

  if (tool.kind === 'write' && !ALLOW_WRITE) {
    return toolError(
      `Tool "${toolName}" is disabled because CAREER_OPS_MCP_ALLOW_WRITE is not set to 1.`,
      { tool: toolName, write_enabled: false }
    );
  }

  const call = tool.invoke(args);
  const run = runChatOps(call.action, call.flags || {}, call.positionals || []);

  logAction({
    actor: 'mcp-server',
    action: `mcp:${toolName}`,
    chat_ops_action: call.action,
    tool_kind: tool.kind,
    args,
    ok: run.ok,
    exit_code: run.exit_code,
  });

  if (!run.ok) {
    return toolError(`Tool "${toolName}" failed while running action "${call.action}".`, {
      tool: toolName,
      action: call.action,
      exit_code: run.exit_code,
      payload: run.payload,
      stderr: run.stderr,
    });
  }

  return toolSuccess(toolName, run.payload);
}

async function handleRpcRequest(message, req) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return makeError(null, -32600, 'Invalid Request');
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return makeError(message.id, -32600, 'Invalid Request');
  }

  const id = Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : undefined;
  const isNotification = id === undefined;

  if (message.method === 'notifications/initialized') {
    return isNotification ? null : makeResult(id, {});
  }

  if (message.method === 'ping') {
    return isNotification ? null : makeResult(id, {});
  }

  if (message.method === 'initialize') {
    const requestedVersion = message.params?.protocolVersion;
    const protocolVersion = negotiateProtocolVersion(requestedVersion);
    return makeResult(id, {
      protocolVersion,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: 'career-ops-mcp',
        version: VERSION,
      },
      instructions: [
        'Career-Ops MCP exposes named repo tools only.',
        'It reuses chat-ops.mjs and the existing tracker, scan, evaluation, and package pipelines.',
        'Write tools may be disabled unless CAREER_OPS_MCP_ALLOW_WRITE=1.',
        'Never submit applications on the user’s behalf.',
      ].join(' '),
    });
  }

  if (message.method === 'tools/list') {
    return isNotification ? null : makeResult(id, toolListResult());
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (typeof name !== 'string' || !name) {
      return makeError(id, -32602, 'Invalid params: tools/call requires a tool name.');
    }
    const args = message.params?.arguments;
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      return makeError(id, -32602, 'Invalid params: tool arguments must be an object.');
    }
    const result = await executeTool(name, args || {});
    return isNotification ? null : makeResult(id, result);
  }

  return makeError(id, -32601, `Method not found: ${message.method}`);
}

async function handleMcp(req, res) {
  if (!isAuthorized(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  const rate = checkRateLimit(req);
  if (!rate.allowed) {
    return sendJson(res, 429, {
      error: 'Rate limit exceeded',
      retry_after_ms: rate.retry_after_ms,
    });
  }

  const protocolHeader = req.headers['mcp-protocol-version'];
  if (protocolHeader && !SUPPORTED_PROTOCOL_VERSIONS.includes(String(protocolHeader))) {
    return sendJson(
      res,
      400,
      makeError(null, -32000, `Unsupported protocol version: ${protocolHeader}`),
      { 'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION }
    );
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(
      res,
      400,
      makeError(null, -32700, err.message === 'Payload too large' ? 'Payload too large' : 'Parse error'),
      { 'MCP-Protocol-Version': String(protocolHeader || LATEST_PROTOCOL_VERSION) }
    );
  }

  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) {
    return sendJson(
      res,
      400,
      makeError(null, -32600, 'Invalid Request'),
      { 'MCP-Protocol-Version': String(protocolHeader || LATEST_PROTOCOL_VERSION) }
    );
  }

  const responses = [];
  for (const message of messages) {
    const response = await handleRpcRequest(message, req);
    if (response) responses.push(response);
  }

  const negotiatedHeader = String(protocolHeader || LATEST_PROTOCOL_VERSION);
  if (responses.length === 0) {
    return sendNoContent(res, 202);
  }

  return sendJson(
    res,
    200,
    Array.isArray(body) ? responses : responses[0],
    { 'MCP-Protocol-Version': negotiatedHeader }
  );
}

const server = http.createServer(async (req, res) => {
  if ((req.url || '') === '/health') {
    if (!isAuthorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    return sendJson(res, 200, {
      ok: true,
      service: 'career-ops-mcp',
      host: HOST,
      port: PORT,
      write_tools_enabled: ALLOW_WRITE,
      auth_mode: TOKEN ? 'bearer' : 'none',
      endpoint: `http://${HOST}:${PORT}/mcp`,
    });
  }

  if ((req.url || '') !== '/mcp') {
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, makeError(null, -32000, 'Method not allowed'));
  }

  try {
    await handleMcp(req, res);
  } catch (err) {
    console.error(err.stack || err.message);
    if (!res.headersSent) {
      return sendJson(res, 500, makeError(null, -32603, 'Internal server error'));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    ok: true,
    service: 'career-ops-mcp',
    host: HOST,
    port: PORT,
    auth_mode: TOKEN ? 'bearer' : 'none',
    write_tools_enabled: ALLOW_WRITE,
    endpoint: `http://${HOST}:${PORT}/mcp`,
    supported_protocol_versions: SUPPORTED_PROTOCOL_VERSIONS,
  }, null, 2));
});
