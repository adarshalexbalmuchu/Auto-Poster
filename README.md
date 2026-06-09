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
          → [Post it] → GitHub Actions (post.yml) → LinkedIn
```

1. Send **"new post"** on WhatsApp
2. Pick client (Irfan / Alex) and content pillar via interactive buttons
3. Optionally provide a topic seed, or let Claude pick
4. Receive full draft preview on WhatsApp
5. Tap **Post it**, **Skip**, or **Regenerate**

---

## Tech stack

| Layer | Tool |
|-------|------|
| AI generation | Anthropic Claude (`claude-sonnet-4-6`) |
| Control interface | Meta WhatsApp Cloud API |
| Webhook handler | Cloudflare Worker + Cloudflare KV (state) |
| Pipeline runner | GitHub Actions |
| Publishing | LinkedIn UGC Posts API / REST Posts API |
| Scheduling | GitHub Actions cron |

---

## Clients

| Client | Posting days | Time | Pillars |
|--------|-------------|------|---------|
| Irfan Sheikh | Tue–Thu | 08:30 UK | AI & Enterprise Ops, Human Side of AI, Europe vs Asia AI, Future Enterprise |
| Alex (Adarsh) | Mon–Fri | flexible | Civic Tech, Building in Public, The Notebook, AI & Tools, Trading & Markets |

---

## Project structure

```
src/
  generate.js     — Claude topic selection + post writing
  post.js         — LinkedIn publishing
  linkedin.js     — LinkedIn API client
  whatsapp.js     — WhatsApp notification sender
  auth.js         — LinkedIn OAuth flow (run once per client)
  run.js          — CLI entrypoint (generate + optional post)

worker/
  index.js        — Cloudflare Worker: WhatsApp webhook bot
  wrangler.toml   — Cloudflare deployment config

clients/
  irfan.json      — Irfan's voice profile, pillars, posting schedule
  alex.json       — Alex's voice profile, pillars, posting schedule

drafts/           — Generated posts (JSON), committed to git
.github/
  workflows/
    generate.yml  — Generate a post (scheduled + manual trigger)
    post.yml      — Post latest draft to LinkedIn (manual trigger)
```

---

## Environment variables

Stored in `.env` (never committed). Set in GitHub Actions and Cloudflare Worker as secrets.

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

---

## WhatsApp bot commands

| Command | Action |
|---------|--------|
| `new post` | Start guided post generation |
| `post` | Publish latest draft to LinkedIn |
| `skip` | Discard latest draft |
| `regenerate` | Rewrite with same topic |
| `status` | Check bot is running |
| `help` | Show all commands |

---

## LinkedIn re-auth

Tokens expire every ~60 days. Re-run:

```bash
npm run auth -- --client irfan
npm run auth -- --client alex
```

Then update `IRFAN_LINKEDIN_ACCESS_TOKEN` and `ALEX_LINKEDIN_ACCESS_TOKEN` in GitHub Secrets.

---

## Local usage

```bash
npm run run -- --client alex
npm run run -- --client alex --pillar civic-tech
npm run run -- --client alex --seed "FloodReady Delhi launch"
npm run run -- --client alex --post        # generate + post immediately
npm run run -- --client alex --dry-run     # preview without posting
```
