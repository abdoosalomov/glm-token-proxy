#!/usr/bin/env node
/**
 * glm-token-proxy
 * Sits between claude-code-router (or any OpenAI-format client) and the GLM API.
 * Owns the OAuth client_credentials token, refreshes it before the 1800s expiry,
 * and injects a fresh Bearer header on every forwarded request.
 *
 * Config lives in .env (see .env.example). Zero npm dependencies.
 *
 *   node server.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---- tiny .env loader (no dotenv dependency) ----
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = Number(process.env.PORT || 8787);
const TOKEN_URL = process.env.GLM_TOKEN_URL;
const API_URL = process.env.GLM_API_URL;
const CLIENT_ID = process.env.GLM_CLIENT_ID;
const CLIENT_SECRET = process.env.GLM_CLIENT_SECRET;
const REFRESH_MARGIN_S = Number(process.env.REFRESH_MARGIN_S || 300);

if (!TOKEN_URL || !API_URL || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing config. Copy .env.example to .env and fill in:');
  console.error('  GLM_TOKEN_URL, GLM_API_URL, GLM_CLIENT_ID, GLM_CLIENT_SECRET');
  process.exit(1);
}

let cached = { token: null, expiresAt: 0 };
let refreshing = null;

function fetchToken() {
  if (refreshing) return refreshing; // dedupe concurrent refreshes
  refreshing = new Promise((resolve, reject) => {
    const u = new URL(TOKEN_URL);
    const body = JSON.stringify({
      grantType: 'client_credentials',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              return reject(new Error(`token endpoint ${res.statusCode}: ${data.slice(0, 500)}`));
            }
            const json = JSON.parse(data);
            // adjust field names here if your token response differs
            const token =
              json.accessToken || json.access_token || json.token ||
              (json.data && (json.data.accessToken || json.data.access_token || json.data.token));
            const expiresIn =
              json.expiresIn || json.expires_in ||
              (json.data && (json.data.expiresIn || json.data.expires_in)) || 1800;
            if (!token) return reject(new Error(`no token field in response: ${data.slice(0, 500)}`));
            cached = {
              token,
              expiresAt: Date.now() + (expiresIn - REFRESH_MARGIN_S) * 1000,
            };
            console.log(`[token] refreshed, valid ~${expiresIn}s (will refresh ${REFRESH_MARGIN_S}s early)`);
            resolve(token);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  }).finally(() => (refreshing = null));
  return refreshing;
}

async function getToken(force = false) {
  if (!force && cached.token && Date.now() < cached.expiresAt) return cached.token;
  return fetchToken();
}

function forward(clientReq, clientRes, bodyBuf, token, isRetry) {
  if (process.env.DEBUG_CAPTURE) {
    fs.writeFileSync(`/tmp/glm-proxy-last-req.json`, bodyBuf);
    console.log(`[debug] captured ${bodyBuf.length} bytes`);
  }
  const u = new URL(API_URL);
  const headers = { ...clientReq.headers };
  delete headers.host;
  delete headers['content-length'];
  headers.authorization = `Bearer ${token}`;
  headers['content-type'] = 'application/json';
  headers['content-length'] = Buffer.byteLength(bodyBuf);

  const upstream = (u.protocol === 'https:' ? https : http).request(
    u,
    { method: 'POST', headers },
    async (upRes) => {
      // token died mid-window -> force refresh and retry once
      if (upRes.statusCode === 401 && !isRetry) {
        upRes.resume();
        console.log('[proxy] got 401, forcing token refresh and retrying');
        try {
          const fresh = await getToken(true);
          return forward(clientReq, clientRes, bodyBuf, fresh, true);
        } catch (e) {
          clientRes.writeHead(502, { 'content-type': 'application/json' });
          return clientRes.end(JSON.stringify({ error: `token refresh failed: ${e.message}` }));
        }
      }
      clientRes.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(clientRes); // streams SSE fine
    }
  );
  upstream.on('error', (e) => {
    console.error('[proxy] upstream error:', e.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
    }
    clientRes.end(JSON.stringify({ error: e.message }));
  });
  upstream.end(bodyBuf);
}

const server = http.createServer((req, res) => {
  // health check
  if (req.method !== 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        ok: true,
        proxy: 'glm-token-proxy',
        tokenCached: Boolean(cached.token),
        tokenValidForS: cached.token ? Math.max(0, Math.round((cached.expiresAt - Date.now()) / 1000)) : 0,
      })
    );
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    try {
      const token = await getToken();
      forward(req, res, body, token, false);
    } catch (e) {
      console.error('[proxy] token error:', e.message);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `token fetch failed: ${e.message}` }));
    }
  });
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`glm-token-proxy listening on http://127.0.0.1:${PORT}`);
  getToken().catch((e) => console.error('[token] initial fetch failed:', e.message));
});
