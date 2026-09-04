# glm-token-proxy

Local proxy that sits between any OpenAI-format client and a GLM API that uses OAuth `client_credentials` with short-lived tokens (1800s).

**Problem:** the GLM API has no static API key — the OAuth token expires every 30 minutes.

**Solution:** this proxy owns the token — fetches it, caches it, refreshes it 300s before expiry, retries once on 401 — and forwards requests to the GLM chat completions endpoint with a fresh `Bearer` header. Clients just talk to `localhost` with any static key.

```
Your client (OpenAI format) → glm-token-proxy (auth) → GLM API
```

Zero npm dependencies. Node 18+.

## Setup

```bash
cp .env.example .env
# fill in GLM_TOKEN_URL, GLM_API_URL, GLM_CLIENT_ID, GLM_CLIENT_SECRET
npm start
```

You should see:

```
glm-token-proxy listening on http://127.0.0.1:8787
[token] refreshed, valid ~1800s (will refresh 300s early)
```

Health check: `curl http://127.0.0.1:8787` shows token cache status.

Or with Docker:

```bash
docker compose up -d
```

> If your network does HTTPS inspection (e.g. FortiGate), drop the firewall's root CA cert next to the Dockerfile and mount it via `NODE_EXTRA_CA_CERTS` (already wired in `docker-compose.yml`).

## Token response format

`server.js` expects the token endpoint to return one of `accessToken` / `access_token` / `token` (optionally nested under `data`), plus `expiresIn` / `expires_in`. If your provider uses different field names, adjust the marked section in `fetchToken()`.

## Keep it running (optional)

pm2:

```bash
pm2 start server.js --name glm-proxy
pm2 save
```
