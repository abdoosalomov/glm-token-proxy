# glm-token-proxy

Local proxy between [claude-code-router](https://github.com/musistudio/claude-code-router) (CCR) and a GLM API that uses OAuth `client_credentials` with short-lived tokens (1800s).

**Problem:** CCR only accepts a static API key. The GLM token expires every 30 minutes.

**Solution:** this proxy owns the token — fetches it, caches it, refreshes it 300s before expiry, retries once on 401 — and forwards requests to the GLM chat completions endpoint with a fresh `Bearer` header. CCR just talks to `localhost` with a dummy key.

```
Claude Code → CCR (Anthropic→OpenAI format) → glm-token-proxy (auth) → GLM API
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

## Wire up claude-code-router

`~/.claude-code-router/config.json`:

```json
{
  "Providers": [
    {
      "name": "glm",
      "api_base_url": "http://127.0.0.1:8787/v1/chat/completions",
      "api_key": "dummy",
      "models": ["zai-org/GLM-5.3-Flash"]
    }
  ],
  "Router": {
    "default": "glm,zai-org/GLM-5.3-Flash"
  }
}
```

Then:

```bash
ccr restart
ccr code   # launches Claude Code routed through GLM
```

**Important:** only launch GLM sessions with `ccr code`. Do not put `ANTHROPIC_BASE_URL` or related overrides into `~/.claude/settings.json` or shell profiles — that hijacks every Claude client globally. Plain `claude` should keep using your normal Anthropic account.

## Token response format

`server.js` expects the token endpoint to return one of `accessToken` / `access_token` / `token` (optionally nested under `data`), plus `expiresIn` / `expires_in`. If your provider uses different field names, adjust the marked section in `fetchToken()`.

## Keep it running (optional)

pm2:

```bash
pm2 start server.js --name glm-proxy
pm2 save
```
