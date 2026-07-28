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
  post.js         — LinkedIn publishing (auto-finds the latest unposted draft if none given)
  edit.js         — Apply a targeted edit instruction to an existing draft
  drafts.js       — Shared "find latest unposted draft" helper (used by post.js / edit.js)
  run.js          — CLI entrypoint (generate + optional post + Worker callback)
  linkedin.js     — LinkedIn API client
  whatsapp.js     — WhatsApp notification sender (preview + buttons)
  auth.js         — LinkedIn OAuth flow (run once per client, ~60 days)
  analytics.js    — Engagement metrics for published posts (CLI + feedback loop)
  notify-stats.js — WhatsApp 24h engagement summary for recent posts
  check-comments.js      — Polls for new comments, drafts a reply, sends for WhatsApp approval
  post-comment-reply.js  — Publishes an approved comment reply
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
  mentions.json   — Manually maintained name → LinkedIn URN map for @mention tagging

drafts/           — Generated posts (JSON), committed to git
  history.json    — Published post log (topic deduplication)

.github/workflows/
  generate.yml         — Generate a post (dispatched by Worker / manual)
  post.yml             — Post latest draft to LinkedIn (dispatched by Worker / manual)
  edit.yml             — Apply edit instruction to latest draft (dispatched by Worker / manual)
  token-check.yml      — Check LinkedIn token expiry (every Monday 08:00 UTC)
  analytics-notify.yml — WhatsApp 24h stats for posts published yesterday (daily 08:30 UTC)
  comment-check.yml    — Poll for new comments and draft replies (every 30 min)
  reply-comment.yml    — Publish an approved comment reply (dispatched by Worker)
  ci.yml               — Syntax/JSON/worker-config sanity checks on every PR and push to main
```

---

## Environment variables

### `.env` (local) — never committed

```
ANTHROPIC_API_KEY
YOUTUBE_API_KEY             — optional; required only to read YouTube links as source material

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
| _(send a photo)_ | Attach an image — send more for a multi-image post (up to 9) |
| _(send a PDF)_ | Attach it as a document/carousel post instead (clears any attached images) |
| `clear attachments` | Remove any attached image(s)/document |
| `schedule: [when]` | Schedule the current draft instead of posting now — e.g. `schedule: 9am tomorrow` |
| `schedule list` | See pending scheduled posts |
| `cancel schedule [id]` | Cancel a pending scheduled post |
| `status` | Check bot is running |
| `help` | Show all commands |

The edit command is stateful — you can edit multiple times before posting. Each edit targets the same draft file.

### Scheduling a post

Once you have a draft ready, reply `schedule: [when]` instead of tapping **Post it**:

```
schedule: 9am tomorrow
schedule: tomorrow at 9:30am
schedule: 5pm today
schedule: in 2 hours
schedule: in 30 minutes
schedule: 2026-08-01 09:00
```

Times are interpreted in the client's own timezone (`postingSchedule.timezone` in `clients/<id>.json` — UK for Irfan, IST for Alex). A Cloudflare Cron Trigger checks every 15 minutes for due posts and fires them automatically — so scheduling is accurate to about ±15 minutes, not to the second. A bare time with no day (e.g. `schedule: 9am`) means today if that time hasn't passed yet, otherwise tomorrow.

Reply `schedule list` any time to see what's pending, and `cancel schedule [id]` (the id is the `YYYY-MM-DDTHH:MM` reference shown in the confirmation) to cancel one. If a schedule dispatch fails (e.g. a transient GitHub API error), it retries on the next 15-minute tick, up to 4 attempts, before giving up and notifying you.

### Attaching images or a document

Once you have a draft (preview received), just **send a photo in the chat**. The Worker downloads it, stores it in KV, and attaches it to the current draft. Send another photo and it's added to the same post — up to 9 images publish as a LinkedIn multi-image (carousel-style) share. Tap **Post it** and it publishes as a LinkedIn image share (text + image(s)).

Send a **PDF** instead to post it as a native document/carousel post. Images and a document are mutually exclusive — attaching one clears the other. Reply `clear attachments` to remove whatever's currently attached without starting a new draft.

- Supported image types: JPEG, PNG, GIF. Documents: PDF only.
- Media is bridged to the posting step (which runs in GitHub Actions) via an authenticated `/media/<key>` Worker endpoint — workflow inputs can't carry binary, so the Action fetches the bytes back at post time using `WORKER_CALLBACK_SECRET`.
- Starting a fresh `new post` detaches any previously attached media.
- No LinkedIn re-auth is needed — image shares use the same `w_member_social` scope as text.
- **Confidence note:** multi-image posts follow the same proven pattern as the original single-image feature (high confidence). Document/carousel posts use a less-documented part of LinkedIn's classic API (the `feedshare-document` recipe) that hasn't been verified against a live PDF post — if it fails, see the comment above `postDocument()` in `src/linkedin.js` for the two most likely fixes.

---

## Tagging companies or people in posts

LinkedIn's real @mention tagging (clickable, notifies the tagged company/person) requires knowing their LinkedIn URN — there's no accessible API for looking up an arbitrary company by name with this app's permissions (that needs LinkedIn's Marketing Developer Platform partner access, a separate application process). So tagging here is a **manually maintained allowlist**, not automatic for every name Claude happens to write.

Add entries to `clients/mentions.json`:

```json
{
  "Anthropic": { "type": "organization", "urn": "urn:li:organization:1234567" },
  "FloodReady Delhi": { "type": "organization", "urn": "urn:li:organization:7654321" }
}
```

- `type` is `"organization"` for a company page or `"person"` for an individual profile.
- The key (`"Anthropic"`) must match the exact text as it would appear in a generated post — matching is case-insensitive but whole-word, so `"Anthropic"` won't accidentally match inside a longer word.
- Whenever that exact name shows up in a post, it gets tagged with the given URN. Everything not in this file stays as plain text — nothing else changes.

**Finding a URN:** there's no clean self-serve lookup, so this takes a bit of manual digging:
- **Organizations:** open the company's LinkedIn page, view page source (or use browser dev tools), and search for `urn:li:organization:` or `"companyId"` in the embedded page data — the numeric ID is usually there. Admins of a page can also often find it in their own analytics/admin URLs.
- **People:** similar approach on a profile page, searching for `urn:li:member:` or `urn:li:person:` in the page source — LinkedIn has made this harder to find on other people's profiles over time, so this is the less reliable of the two. Tagging companies is the more practical use case.

**Confidence note:** this uses LinkedIn's documented character-offset "attributed text" pattern for the classic `/v2/ugcPosts` endpoint, unverified against the live API. If LinkedIn rejects a post because of a mention tag, the code automatically retries once with the tags stripped — a bad or wrong URN can never take down the whole post, worst case the mention just doesn't get tagged and a warning is logged.

---

## Analytics

```bash
npm run analytics -- --client irfan            # reactions/comments/shares for published posts
npm run analytics -- --client irfan --count 5
```

Engagement data also feeds back into generation automatically — recent high/low performers are shown to Claude during topic selection. A daily cron (`analytics-notify.yml`) sends a WhatsApp summary for posts published ~24h ago.

---

## Comment reply assist

A cron (`comment-check.yml`, every 30 minutes) checks posts published in the last 14 days for new comments. For each new one (skipping the client's own comments), Claude drafts a short reply in the client's voice and sends it to WhatsApp:

```
💬 New comment on Alex's post

"This is such a great point about civic tech!"

Drafted reply:
"Thanks, glad it landed! Curious what you're building in that space."

[✅ Post reply]  [❌ Skip]
```

Tap **Post reply** to publish it, or **Skip** to dismiss. Already-seen comments are tracked per draft (`seenCommentIds` in `drafts/*.json`) so you're never notified about the same comment twice, and multiple pending replies can be in flight at once — approving or skipping one doesn't affect the others or any in-progress "new post" flow.

**Confidence note:** LinkedIn has no comment webhooks for member posts, so this polls instead. Comment listing/creation uses the same classic Social Actions API family as the engagement-count endpoint `analytics.js` already relies on successfully, but the specific `/comments` sub-resource hasn't been exercised against the live API yet — see the notes above `getComments()`/`postComment()` in `src/linkedin.js` for exactly what to verify on first real use, including that replies currently post as a new top-level comment rather than a threaded reply nested under the original.

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
npm run run -- --client alex --url "https://example.com/article"          # Claude reads it as source material
npm run run -- --client alex --url "https://youtu.be/dQw4w9WgXcQ"         # same flag — title/description (+ transcript if available)
npm run run -- --client alex --post        # generate + post immediately
npm run run -- --client alex --dry-run     # preview without posting

npm run edit -- --client alex --instruction "make it shorter"
npm run edit -- --client alex --instruction "sharpen the hook" --draft ./drafts/2026-06-09T09-00-00-alex.json

npm run post -- --client alex              # auto-finds & posts the latest unposted draft for alex
npm run post -- --draft ./drafts/2026-06-09T09-00-00-alex.json --dry-run
```

### Reading a YouTube video as source material

The same `--url` flag (or pasting a link on WhatsApp) also accepts YouTube links — `youtube.com/watch?v=...`, `youtu.be/...`, `/shorts/...`, `/embed/...`, and `/live/...` are all recognized. Two layers of grounding, combined:

1. **Title, full description, and channel** via the official YouTube Data API v3 — needs `YOUTUBE_API_KEY` (a plain API key from Google Cloud Console, no OAuth). This is the reliable baseline; without the key, YouTube URLs fail with a clear setup message.
2. **Transcript, best-effort** — also attempts to pull the video's caption track (manual or auto-generated) using the same unofficial mechanism the YouTube player itself uses in the browser. No extra setup, no OAuth. If the video has no captions, or YouTube's page structure has changed, this silently falls back to title+description only — it never blocks generation.

Set up the API key: [Google Cloud Console](https://console.cloud.google.com/) → select/create a project → **APIs & Services → Library** → enable **"YouTube Data API v3"** → **Credentials → Create API key** → add it as `YOUTUBE_API_KEY` in `.env` and as a GitHub Actions secret.

### Combining a source link with your own direction

Optional, not required — on WhatsApp, when asked for a seed, you can paste a link **and** add your own direction in the same message:

```
https://youtu.be/dQw4w9WgXcQ focus on the training-data angle, keep it skeptical
```

Claude grounds the post in the source material but writes toward the specific direction you gave, instead of picking its own angle. Paste just a link with nothing else and it behaves exactly as before — this is purely additive, nothing changes if you don't use it. The direction can be as short or as long as you want; it isn't summarized or trimmed.
