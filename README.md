# Auto-Poster

LinkedIn post automation for multiple clients. Claude AI writes the posts. WhatsApp is the control interface. GitHub Actions runs the pipeline. LinkedIn API publishes.

---

## How it works

```
WhatsApp "new post"
  → Cloudflare Worker (webhook)
    → GitHub Actions (generate.yml)
      → Claude API (topic + post)
        → WhatsApp (draft preview + buttons)
          → [Post it]      → GitHub Actions (post.yml) → LinkedIn
          → [Regenerate]   → GitHub Actions (generate.yml) → new draft
          → "edit: [instruction]" → GitHub Actions (edit.yml) → Claude rewrites → new preview
```

1. Send **"new post"** on WhatsApp
2. Pick client (Irfan / Alex) and content pillar via interactive buttons
3. Optionally provide a topic seed, or let Claude pick
4. Receive full draft preview on WhatsApp
5. Tap **Post it**, **Skip**, or **Regenerate** — or reply `edit: [instruction]` to refine

---

## Tech stack

| Layer | Tool |
|-------|------|
| AI generation | Anthropic Claude (`claude-sonnet-4-6` writing, `claude-haiku-4-5` topic picking) |
| Control interface | Meta WhatsApp Cloud API |
| Webhook handler | Cloudflare Worker + Cloudflare KV (state) |
| Pipeline runner | GitHub Actions |
| Publishing | LinkedIn UGC Posts API |
| Scheduling | GitHub Actions cron (token check, 24h stats) |

---

## Clients

| Client | Posting days | Time | Pillars |
|--------|-------------|------|---------|
| Irfan Sheikh | Tue–Thu | 08:30 UK | The Delivery Lens, Where It Breaks, Sharp Takes |
| Alex (Adarsh) | Mon–Fri | 09:00 IST | AI Watch, Policy & Power, Building in Public, The Notebook, Sharp Takes |

Pillars are weighted by `frequency` and `last_posted` — the most overdue pillar is selected automatically. Pillars with `frequency: 0` are excluded from automatic selection (manual only).

Adding a client is config-only: drop a `clients/<id>.json` file (same shape as the existing ones) — no code changes needed. To surface it in the WhatsApp bot, also add it to `CLIENTS` in `worker/index.js`.

---

## Project structure

```
src/
  generate.js     — Claude topic selection + post writing + pillar rotation
  post.js         — LinkedIn publishing
  edit.js         — Apply a targeted edit instruction to an existing draft
  run.js          — CLI entrypoint (generate + optional post + Worker callback)
  linkedin.js     — LinkedIn API client
  whatsapp.js     — WhatsApp notification sender (preview + buttons)
  auth.js         — LinkedIn OAuth flow (run once per client, ~60 days)
  analytics.js    — Engagement metrics for published posts (CLI + feedback loop)
  notify-stats.js — WhatsApp 24h engagement summary for recent posts
  check-tokens.js — LinkedIn token expiry checker (sends WhatsApp warning)
  cli-utils.js    — Shared CLI argument parsing

scripts/
  pre-deploy.js   — Worker pre-deployment validation

worker/
  index.js        — Cloudflare Worker: WhatsApp bot + /callback endpoint
  wrangler.toml   — Cloudflare deployment config

clients/
  irfan.json      — Irfan's voice profile, pillars, posting schedule
  alex.json       — Alex's voice profile, pillars, posting schedule

drafts/           — Generated posts (JSON), committed to git
  history.json    — Published post log (topic deduplication)

.github/workflows/
  generate.yml         — Generate a post (dispatched by Worker / manual)
  post.yml             — Post latest draft to LinkedIn (dispatched by Worker / manual)
  edit.yml             — Apply edit instruction to latest draft (dispatched by Worker / manual)
  token-check.yml      — Check LinkedIn token expiry (every Monday 08:00 UTC)
  analytics-notify.yml — WhatsApp 24h stats for posts published yesterday (daily 08:30 UTC)
```

---

## Environment variables

### `.env` (local) — never committed

```
ANTHROPIC_API_KEY

IRFAN_LINKEDIN_ACCESS_TOKEN
IRFAN_LINKEDIN_PERSON_URN
IRFAN_LINKEDIN_TOKEN_EXPIRES_AT
IRFAN_LINKEDIN_CLIENT_ID
IRFAN_LINKEDIN_CLIENT_SECRET

ALEX_LINKEDIN_ACCESS_TOKEN
ALEX_LINKEDIN_PERSON_URN
ALEX_LINKEDIN_TOKEN_EXPIRES_AT
ALEX_LINKEDIN_CLIENT_ID
ALEX_LINKEDIN_CLIENT_SECRET

WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_RECIPIENT_NUMBER
```

### GitHub Actions secrets (`Settings → Secrets → Actions`)

All of the above, plus:

```
WORKER_URL               — Cloudflare Worker https URL
WORKER_CALLBACK_SECRET   — shared secret for Worker ↔ Actions callbacks
```

### Cloudflare Worker secrets (`wrangler secret put <NAME>`)

```
WHATSAPP_VERIFY_TOKEN
WHATSAPP_APP_SECRET
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_OWNER_NUMBER
GITHUB_TOKEN
WORKER_CALLBACK_SECRET   — same value as GitHub Actions secret
```

---

## WhatsApp bot commands

| Command | Action |
|---------|--------|
| `new post` | Start guided post generation |
| `post` | Publish latest draft to LinkedIn |
| `skip` | Discard latest draft |
| `regenerate` | Rewrite with same topic |
| `edit: [instruction]` | Refine current draft — e.g. `edit: sharpen the hook` |
| `status` | Check bot is running |
| `help` | Show all commands |

The edit command is stateful — you can edit multiple times before posting. Each edit targets the same draft file.

---

## Analytics

```bash
npm run analytics -- --client irfan            # reactions/comments/shares for published posts
npm run analytics -- --client irfan --count 5
```

Engagement data also feeds back into generation automatically — recent high/low performers are shown to Claude during topic selection. A daily cron (`analytics-notify.yml`) sends a WhatsApp summary for posts published ~24h ago.

---

## Token expiry

Tokens expire every ~60 days. A GitHub Actions cron runs every Monday at 08:00 UTC and sends a WhatsApp warning if either token expires within 14 days.

To re-auth manually:

```bash
npm run auth -- --client irfan
npm run auth -- --client alex
```

Then update `IRFAN_LINKEDIN_ACCESS_TOKEN` / `ALEX_LINKEDIN_ACCESS_TOKEN` in GitHub Secrets.

---

## Deploying the Worker

Always deploy via the gated command — it runs pre-deploy checks first and refuses to deploy if anything is wrong:

```bash
npm run deploy-worker
```

This blocks on:
- `DEBUG_SKIP_SIG` left in `wrangler.toml` or `worker/index.js`
- Any required Cloudflare secret not set
- Missing GitHub Actions workflow files

To check config independently without deploying:

```bash
npm run pre-deploy
```

### Health endpoint

After deploying, verify all secrets are configured:

```
GET https://auto-poster-webhook.auto-poster.workers.dev/health
```

Returns `200 ok` when all secrets are set, `503 degraded` with a checklist of what's missing:

```json
{
  "status": "degraded",
  "checks": {
    "WHATSAPP_VERIFY_TOKEN": true,
    "WHATSAPP_APP_SECRET": false,
    "WHATSAPP_ACCESS_TOKEN": true,
    ...
  }
}
```

Run this immediately after every deploy to confirm nothing is missing.

### Manual secret rotation

If a secret changes (e.g. new WhatsApp access token), update it in both places:

```bash
# Cloudflare Worker
cd worker && npx wrangler secret put WHATSAPP_ACCESS_TOKEN

# GitHub Actions → Settings → Secrets → Actions → update the same key
```

Then redeploy and check `/health`.

---

## Local usage

```bash
npm run run -- --client alex
npm run run -- --client alex --pillar ai-watch
npm run run -- --client alex --seed "FloodReady Delhi launch"
npm run run -- --client alex --format story
npm run run -- --client alex --url "https://example.com/article"   # Claude reads it as source material
npm run run -- --client alex --post        # generate + post immediately
npm run run -- --client alex --dry-run     # preview without posting

npm run edit -- --client alex --instruction "make it shorter"
npm run edit -- --client alex --instruction "sharpen the hook" --draft ./drafts/2026-06-09T09-00-00-alex.json
```
