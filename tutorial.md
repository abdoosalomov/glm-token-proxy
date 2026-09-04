# GLM in Claude Code — Setup Tutorial

Full chain: **Claude Code → ccr → glm-proxy → GLM API**. Plus the opencode alternative for image support.

## Architecture

```
Claude Code ──> ccr (:3456) ──> glm-proxy (:8787) ──> GLM API
     (Anthropic→OpenAI)      (OAuth token mgmt)

opencode ─────────────────────> glm-proxy (:8787) ──> GLM API
     (OpenAI native, no ccr)
```

## 1. glm-proxy (this repo)

Docker container `glm-proxy` on `127.0.0.1:8787`. Zero npm deps, pure Node.

- Owns the OAuth `client_credentials` token, refreshes 300s before the 1800s expiry
- Injects `Authorization: Bearer <token>` on every forwarded request
- Retries once on 401 with forced token refresh
- Pure pass-through for body bytes (images included)

Config: `.env` — `GLM_TOKEN_URL`, `GLM_API_URL`, `GLM_CLIENT_ID`, `GLM_CLIENT_SECRET`.

```bash
docker compose up -d          # start
curl http://127.0.0.1:8787/   # health: {"ok":true,...}
```

## 2. claude-code-router (ccr)

Global npm package, proxies Anthropic ↔ OpenAI format.

`~/.claude-code-router/config.json`:

```json
{
  "Providers": [
    {
      "name": "glm",
      "api_base_url": "http://127.0.0.1:8787/v1/chat/completions",
      "api_key": "dummy",
      "models": ["zai-org/GLM-5.3-Flash"],
      "modelMetadata": {
        "zai-org/GLM-5.3-Flash": { "contextWindow": 1000000 }
      }
    }
  ],
  "Router": { "default": "glm,zai-org/GLM-5.3-Flash" }
}
```

`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3456",
    "ANTHROPIC_AUTH_TOKEN": "<any key ccr accepts>"
  }
}
```

Restart: `ccr stop && ccr start`.

`modelMetadata.contextWindow` — tells Claude Code the real window (default otherwise: 200k "unrecognized model"). Set it to match what the AI lead deploys.

## 3. opencode (image support — required, see "Known bug")

ccr 3.0.22 **silently drops all images** during Anthropic→OpenAI conversion. GLM vision works fine when reached directly. opencode connects to glm-proxy directly, no ccr.

Install: `brew install opencode`

`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "glm": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "dummy" },
      "models": { "zai-org/GLM-5.3-Flash": {} }
    }
  },
  "model": "glm/zai-org/GLM-5.3-Flash",
  "instructions": [
    "/Users/user/.claude/rules/common/coding-style.md",
    "/Users/user/.claude/rules/common/git-workflow.md",
    "/Users/user/.claude/rules/common/testing.md",
    "/Users/user/.claude/rules/common/performance.md",
    "/Users/user/.claude/rules/common/patterns.md",
    "/Users/user/.claude/rules/common/hooks.md",
    "/Users/user/.claude/rules/common/agents.md",
    "/Users/user/.claude/rules/common/security.md",
    "/Users/user/.claude/rules/common/development-workflow.md",
    "/Users/user/.claude/rules/typescript/coding-style.md",
    "/Users/user/.claude/rules/typescript/testing.md",
    "/Users/user/.claude/rules/typescript/patterns.md",
    "/Users/user/.claude/rules/typescript/hooks.md",
    "/Users/user/.claude/rules/typescript/security.md"
  ],
  "mcp": {
    "jira": {
      "type": "local",
      "command": ["node", "/Users/user/Desktop/mcp-servers/index.js"],
      "environment": {
        "JIRA_BASE_URL": "https://itjira.agrobank.uz",
        "JIRA_EMAIL": "<email>",
        "JIRA_PASSWORD": "<password>"
      }
    },
    "confluence": {
      "type": "local",
      "command": ["node", "/Users/user/Desktop/mcp-servers/confluence.js"],
      "environment": {
        "CONFLUENCE_BASE_URL": "https://itjira.agrobank.uz/confluence",
        "CONFLUENCE_EMAIL": "<email>",
        "CONFLUENCE_PASSWORD": "<password>"
      }
    },
    "context7": {
      "type": "local",
      "command": ["npx", "-y", "@upstash/context7-mcp", "--api-key", "<key>"]
    }
  }
}
```

What ports over automatically:

| Feature | Status |
|---|---|
| Skills (`~/.claude/skills/`, `.claude/skills/`) | ✅ native, same SKILL.md format |
| `~/.claude/CLAUDE.md` + project `CLAUDE.md` | ✅ fallback when no `AGENTS.md` exists |
| Rules (`~/.claude/rules/**`) | manual, via `instructions` array (above) |
| MCP servers | manual re-registration (above) |
| Custom agents (`.claude/agents/`) | ❌ own format, port by hand if needed |
| Plugins (ponytail, caveman, ecc) | ❌ incompatible API, drop or rewrite |

Verify:

```bash
opencode run "Say OPENCODE-GLM-OK"                  # model chain
opencode run "Name 3 MCP tools you see"             # mcp loaded
opencode run "What's the max file lines rule?"      # rules loaded
```

## Known bug — ccr drops images (as of 2026-09-03)

In ccr's dependency `@the-next-ai/ai-gateway/dist/index.js`, function `Sq()` (Anthropic→standard content converter) has **no branch for `type:"image"` blocks**. Image blocks fall through to a text extractor that returns `""` and get silently deleted. GLM then receives text-only messages and hallucinates image content.

- Verified by: capture-proxy on the ccr→glm-proxy hop (image data absent from forwarded request, `input_tokens: 20` for a message containing an image)
- Fix: patch `Sq()` to map image blocks to `input_image` / `image_url` parts, or upgrade ccr, or use opencode for anything with images
- Model vision itself is confirmed working: direct curl to glm-proxy with `image_url` part describes images perfectly

## Debugging tricks that worked

- **Token health**: `curl http://127.0.0.1:8787/` → `tokenValidForS`
- **What ccr forwards**: capture proxy (MITM between ccr and glm-proxy), writes bodies to `/tmp/captured-req-N.json`
- **ccr request logs**: `~/.claude-code-router/app-data/request-logs.sqlite` + `request-log-bodies/` (note: ccr truncates base64 image data in its logs with `[base64 image omitted from log]` — the log lie, not the request)
- **Direct GLM test** (bypasses ccr): build OpenAI-format JSON with `image_url` data URI, POST to `http://127.0.0.1:8787/v1/chat/completions`
- **Model hallucination warning**: if GLM "describes" an image but the pipeline is broken, it's confabulating. Always verify with a capture that the image data actually left the client.
