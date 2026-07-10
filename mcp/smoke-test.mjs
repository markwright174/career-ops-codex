#!/usr/bin/env node

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { flags: {}, positionals: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, inlineValue] = arg.slice(2).split('=', 2);
      if (inlineValue !== undefined) {
        result.flags[key] = inlineValue;
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          result.flags[key] = next;
          i++;
        } else {
          result.flags[key] = true;
        }
      }
    } else {
      result.positionals.push(arg);
    }
  }

  return result;
}

async function postJson(url, body, token) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: parsed,
  };
}

async function getJson(url, token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: parsed,
  };
}

async function main() {
  const { flags } = parseArgs(process.argv);
  const endpoint = String(flags.url || 'http://127.0.0.1:8790/mcp');
  const token = flags.token ? String(flags.token) : '';
  const toolName = String(flags.tool || 'show_inbox');
  const argsJson = flags.args ? JSON.parse(String(flags.args)) : {};
  const protocolVersion = String(flags.protocol || '2025-03-26');

  const healthUrl = endpoint.replace(/\/mcp\/?$/, '/health');

  const health = await getJson(healthUrl, token);
  const initialize = await postJson(endpoint, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: {
        name: 'career-ops-smoke-test',
        version: '0.1.0',
      },
    },
  }, token);
  const tools = await postJson(endpoint, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }, token);
  const toolCall = await postJson(endpoint, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: argsJson,
    },
  }, token);

  console.log(JSON.stringify({
    endpoint,
    protocol_requested: protocolVersion,
    health,
    initialize,
    tools,
    tool_call: {
      tool: toolName,
      response: toolCall,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
