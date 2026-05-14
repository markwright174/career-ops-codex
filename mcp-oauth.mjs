#!/usr/bin/env node

import crypto from 'crypto';

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function base64UrlDecode(input) {
  let normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4 !== 0) normalized += '=';
  return Buffer.from(normalized, 'base64').toString('utf-8');
}

function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT');
  }

  return {
    header: JSON.parse(base64UrlDecode(parts[0])),
    payload: JSON.parse(base64UrlDecode(parts[1])),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: parts[2],
  };
}

function scopeList(payload) {
  const raw = payload?.scope || payload?.scp || '';
  if (Array.isArray(raw)) return raw.map((item) => String(item));
  return String(raw)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildProtectedResourceMetadataPath(publicPath) {
  const normalized = `/${String(publicPath || '/mcp').replace(/^\/+/, '')}`;
  if (normalized === '/') return '/.well-known/oauth-protected-resource';
  return `/.well-known/oauth-protected-resource${normalized}`;
}

function makeChallengeHeader(metadataUrl, extras = {}) {
  const params = [
    ['realm', 'career-ops-mcp'],
    ['resource_metadata', metadataUrl],
  ];

  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined && value !== null && value !== '') {
      params.push([key, String(value)]);
    }
  }

  const formatted = params.map(([key, value]) => `${key}="${String(value).replace(/"/g, '\\"')}"`);
  return `Bearer ${formatted.join(', ')}`;
}

export function buildOAuthConfig(env = process.env) {
  const issuer = trimSlash(env.CAREER_OPS_MCP_OAUTH_ISSUER || '');
  const audience = String(env.CAREER_OPS_MCP_OAUTH_AUDIENCE || '').trim();
  const publicBaseUrl = trimSlash(env.CAREER_OPS_MCP_PUBLIC_BASE_URL || '');
  const publicPath = env.CAREER_OPS_MCP_PUBLIC_PATH || '/mcp';
  const readScope = String(env.CAREER_OPS_MCP_READ_SCOPE || 'career_ops:read').trim();
  const writeScope = String(env.CAREER_OPS_MCP_WRITE_SCOPE || 'career_ops:write').trim();

  const enabled = Boolean(issuer && audience && publicBaseUrl);
  const metadataPath = buildProtectedResourceMetadataPath(publicPath);
  const metadataUrl = publicBaseUrl ? `${publicBaseUrl}${metadataPath}` : null;

  return {
    enabled,
    issuer,
    audience,
    publicBaseUrl,
    publicPath,
    metadataPath,
    metadataUrl,
    readScope,
    writeScope,
    openidConfigUrl: issuer ? `${issuer}/.well-known/openid-configuration` : null,
  };
}

const cache = {
  openid: null,
  openidFetchedAt: 0,
  jwks: null,
  jwksFetchedAt: 0,
};

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return response.json();
}

async function getOpenIdConfig(config) {
  const now = Date.now();
  if (cache.openid && (now - cache.openidFetchedAt) < 300000) {
    return cache.openid;
  }

  const json = await fetchJson(config.openidConfigUrl);
  cache.openid = json;
  cache.openidFetchedAt = now;
  return json;
}

async function getJwks(config) {
  const now = Date.now();
  if (cache.jwks && (now - cache.jwksFetchedAt) < 300000) {
    return cache.jwks;
  }

  const openid = await getOpenIdConfig(config);
  if (!openid.jwks_uri) {
    throw new Error('OpenID configuration did not include jwks_uri');
  }

  const json = await fetchJson(openid.jwks_uri);
  cache.jwks = json;
  cache.jwksFetchedAt = now;
  return json;
}

function normalizeAudience(aud) {
  if (Array.isArray(aud)) return aud.map((value) => String(value));
  if (aud === undefined || aud === null) return [];
  return [String(aud)];
}

function hasRequiredScope(payload, scope) {
  if (!scope) return true;
  return scopeList(payload).includes(scope);
}

function verifyJwtSignature(token, jwk) {
  const parsed = parseJwt(token);
  if (parsed.header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT alg: ${parsed.header.alg}`);
  }

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(parsed.signingInput);
  verifier.end();

  const signature = Buffer.from(parsed.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const valid = verifier.verify(publicKey, signature);
  if (!valid) {
    throw new Error('JWT signature verification failed');
  }

  return parsed.payload;
}

export async function validateAccessToken(token, config, requiredScope) {
  if (!config.enabled) {
    return {
      ok: true,
      claims: null,
      scopes: [],
      authMode: 'disabled',
    };
  }

  if (!token) {
    return {
      ok: false,
      status: 401,
      error: 'missing_token',
      errorDescription: 'Missing bearer token.',
    };
  }

  let parsed;
  try {
    parsed = parseJwt(token);
  } catch (err) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      errorDescription: err.message,
    };
  }

  const jwks = await getJwks(config);
  const jwk = Array.isArray(jwks.keys)
    ? jwks.keys.find((candidate) => candidate.kid === parsed.header.kid)
    : null;

  if (!jwk) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      errorDescription: 'Signing key not found for JWT kid.',
    };
  }

  let payload;
  try {
    payload = verifyJwtSignature(token, jwk);
  } catch (err) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      errorDescription: err.message,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const issuer = trimSlash(payload.iss || '');
  if (issuer !== config.issuer) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      errorDescription: 'JWT issuer did not match configured OAuth issuer.',
    };
  }

  const audiences = normalizeAudience(payload.aud);
  if (!audiences.includes(config.audience)) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      errorDescription: 'JWT audience did not match configured MCP audience.',
    };
  }

  if (payload.exp && now >= payload.exp) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      errorDescription: 'JWT is expired.',
    };
  }

  if (payload.nbf && now < payload.nbf) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      errorDescription: 'JWT is not valid yet.',
    };
  }

  if (!hasRequiredScope(payload, requiredScope)) {
    return {
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      errorDescription: `Token is missing required scope: ${requiredScope}`,
      scopes: scopeList(payload),
    };
  }

  return {
    ok: true,
    claims: payload,
    scopes: scopeList(payload),
    authMode: 'oauth',
  };
}

export function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function buildProtectedResourceMetadata(config) {
  return {
    resource: `${config.publicBaseUrl}${config.publicPath}`,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'],
    resource_documentation: `${config.publicBaseUrl}${config.publicPath}`,
    scopes_supported: [config.readScope, config.writeScope].filter(Boolean),
  };
}

export function buildAuthChallengeHeaders(config, extras = {}) {
  if (!config.enabled || !config.metadataUrl) return {};
  return {
    'WWW-Authenticate': makeChallengeHeader(config.metadataUrl, extras),
  };
}
