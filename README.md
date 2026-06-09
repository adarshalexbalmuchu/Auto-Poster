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
| AI generation | Anthropic Claude (`claude-sonnet-4-6`) |
| Control interface | Meta WhatsApp Cloud API |
| Webhook handler | Cloudflare Worker + Cloudflare KV (state) |
| Pipeline runner | GitHub Actions |
| Publishing | LinkedIn UGC Posts API / REST Posts API |
| PDF generation | `pdf-lib` (carousel posts) |
| Scheduling | GitHub Actions cron |

---

## Clients

| Client | Posting days | Time | Pillars |
|--------|-------------|------|---------|
| Irfan Sheikh | Tue–Thu | 08:30 UK | AI at Work, Adoption Gap, Human Side of AI, Sharp Takes |
| Alex (Adarsh) | Mon–Fri | 09:00 IST | AI Watch (2×/wk), Policy & Power, Building in Public, The Notebook, Sharp Takes |

Pillars are weighted by `frequency` and `last_posted` — Claude automatically rotates to the most overdue pillar. `sharp-takes` is excluded from automatic selection (manual only).

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
  auth.js         — LinkedIn OAuth flow (run once per client)
  carousel.js     — PDF carousel builder (pdf-lib, 1080×1080 slides)
  check-tokens.js — LinkedIn token expiry checker (sends WhatsApp warning)

worker/
  index.js        — Cloudflare Worker: WhatsApp bot + /callback endpoint
  wrangler.toml   — Cloudflare deployment config

clients/
  irfan.json      — Irfan's voice profile, pillars, posting schedule
  alex.json       — Alex's voice profile, pillars, posting schedule

drafts/           — Generated posts (JSON), committed to git
  history.json    — Published post log (topic deduplication)

.github/workflows/
  generate.yml    — Generate a post (scheduled + manual)
  post.yml        — Post latest draft to LinkedIn (manual)
  edit.yml        — Apply edit instruction to latest draft (manual)
  token-check.yml — Check LinkedIn token expiry (every Monday 08:00 UTC)
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

## Carousel posts

Generate a 5-slide PDF carousel (uploaded to WhatsApp + LinkedIn):

```bash
npm run generate -- --client alex --format carousel
npm run run -- --client alex --format carousel
```

Or select carousel format via the WhatsApp bot seed step.

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

## Local usage

```bash
npm run run -- --client alex
npm run run -- --client alex --pillar ai-watch
npm run run -- --client alex --seed "FloodReady Delhi launch"
npm run run -- --client alex --format carousel
npm run run -- --client alex --post        # generate + post immediately
npm run run -- --client alex --dry-run     # preview without posting

npm run edit -- --client alex --instruction "make it shorter"
npm run edit -- --client alex --instruction "sharpen the hook" --draft ./drafts/2026-06-09T09-00-00-alex.json
```
