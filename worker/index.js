/**
 * Cloudflare Worker — WhatsApp conversational bot for Auto-Poster
 *
 * Flow:
 *   "new post" → client buttons → pillar list → seed → generate → review → post/skip/regenerate
 *
 * Environment variables (wrangler secret put <NAME>):
 *   WHATSAPP_VERIFY_TOKEN    — matches Meta webhook config
 *   WHATSAPP_APP_SECRET      — Meta app secret for signature verification
 *   WHATSAPP_ACCESS_TOKEN    — permanent Meta system user token
 *   WHATSAPP_PHONE_NUMBER_ID — WhatsApp Business phone number ID
 *   WHATSAPP_OWNER_NUMBER    — your personal WhatsApp number (E.164, no +)
 *   GITHUB_TOKEN             — GitHub PAT with actions:write scope
 *   GITHUB_REPO              — e.g. adarshalexbalmuchu/Auto-Poster
 *   WORKER_CALLBACK_SECRET   — shared secret for internal callbacks from GitHub Actions
 *
 * KV namespace binding (wrangler.toml):
 *   STATE — conversation state per user (1h TTL); WhatsApp-uploaded images/
 *           documents awaiting post (media:<phone>:<n>, 7d TTL, served via
 *           /media to the Action); scheduled posts (scheduled:<ISO-UTC>:<phone>,
 *           checked every 15 min by the `scheduled` cron handler below); and
 *           pending comment-reply approvals (commentreply:<phone>:<id>, 7d TTL)
 */

const WA_API = 'https://graph.facebook.com/v20.0';
const GH_API = 'https://api.github.com';

// Keep in sync with clients/*.json pillar IDs and postingSchedule.timezone.
const CLIENTS = {
  irfan: {
    name: 'Irfan',
    timezone: 'Europe/London',
    pillars: [
      { id: 'delivery-lens',   title: 'The Delivery Lens' },
      { id: 'where-it-breaks', title: 'Where It Breaks'   },
      { id: 'sharp-takes',     title: 'Sharp Takes'       },
    ],
  },
  alex: {
    name: 'Alex',
    timezone: 'Asia/Kolkata',
    pillars: [
      { id: 'ai-watch',           title: 'AI Watch'          },
      { id: 'policy-and-power',   title: 'Policy & Power'    },
      { id: 'building-in-public', title: 'Building in Public'},
      { id: 'the-notebook',       title: 'The Notebook'      },
      { id: 'sharp-takes',        title: 'Sharp Takes'       },
    ],
  },
};

// ── Schedule-time parsing ───────────────────────────────────────────────────
//
// Pure Intl-based timezone math, no dependencies (Workers support the full
// Intl API). Handles "9am tomorrow", "tomorrow 9am", "5pm today", "in 2 hours",
// "in 30 minutes", bare "9am" (today if still upcoming, else tomorrow), and
// absolute "YYYY-MM-DD HH:MM" — each interpreted in the given IANA timezone.

function zonedTimeToUtc(y, m, d, hh, mm, timeZone) {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(guess).map(p => [p.type, p.value]));
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess.getTime() + (guess.getTime() - asIfUtc));
}

function getZonedYMD(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(dtf.formatToParts(date).map(p => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day };
}

function addDaysInZone(y, m, d, days) {
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function parseScheduleTime(rawText, timeZone, now = new Date()) {
  const text = rawText.trim().toLowerCase();

  let m = text.match(/^in\s+(\d+)\s*(minute|min|hour|hr)s?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitMs = /hour|hr/.test(m[2]) ? 3_600_000 : 60_000;
    return new Date(now.getTime() + n * unitMs);
  }

  m = text.match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{1,2}):(\d{2})$/);
  if (m) {
    const [, y, mo, d, hh, mm] = m.map(Number);
    return zonedTimeToUtc(y, mo, d, hh, mm, timeZone);
  }

  const timeRe = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)';
  let dayWord = null, timeMatch = null;

  m = text.match(new RegExp(`^tomorrow\\s*(?:at\\s*)?${timeRe}$`)) || text.match(new RegExp(`^${timeRe}\\s*tomorrow$`));
  if (m) { dayWord = 'tomorrow'; timeMatch = m; }
  if (!m) {
    m = text.match(new RegExp(`^today\\s*(?:at\\s*)?${timeRe}$`)) || text.match(new RegExp(`^${timeRe}\\s*today$`));
    if (m) { dayWord = 'today'; timeMatch = m; }
  }
  if (!m) {
    m = text.match(new RegExp(`^${timeRe}$`));
    if (m) { dayWord = null; timeMatch = m; }
  }

  if (timeMatch) {
    let hh = parseInt(timeMatch[1], 10);
    const mm = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3];
    if (hh === 12) hh = 0;
    if (ampm === 'pm') hh += 12;
    if (hh > 23 || mm > 59) return null;

    const today = getZonedYMD(now, timeZone);
    if (dayWord === 'tomorrow') {
      const t = addDaysInZone(today.y, today.m, today.d, 1);
      return zonedTimeToUtc(t.y, t.m, t.d, hh, mm, timeZone);
    }
    if (dayWord === 'today') {
      return zonedTimeToUtc(today.y, today.m, today.d, hh, mm, timeZone);
    }
    const candidateToday = zonedTimeToUtc(today.y, today.m, today.d, hh, mm, timeZone);
    if (candidateToday.getTime() > now.getTime()) return candidateToday;
    const t = addDaysInZone(today.y, today.m, today.d, 1);
    return zonedTimeToUtc(t.y, t.m, t.d, hh, mm, timeZone);
  }

  return null;
}

function formatZoned(date, timeZone) {
  return date.toLocaleString('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// ── Signature verification ──────────────────────────────────────────────────

function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

async function verifySignature(request, secret) {
  const signature = request.headers.get('x-hub-signature-256');
  if (!signature) return false;
  const body = await request.clone().arrayBuffer();
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, body);
  const expected = 'sha256=' + Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(signature, expected);
}

// ── State management (Cloudflare KV) ───────────────────────────────────────

async function getState(env, from) {
  const raw = await env.STATE.get(`state:${from}`);
  return raw ? JSON.parse(raw) : { step: 'idle' };
}

async function setState(env, from, state) {
  await env.STATE.put(`state:${from}`, JSON.stringify(state), { expirationTtl: 3600 });
}

async function clearState(env, from) {
  await env.STATE.delete(`state:${from}`);
}

// ── Internal callback handler (from GitHub Actions) ────────────────────────

async function handleCallback(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!timingSafeEqual(auth, `Bearer ${env.WORKER_CALLBACK_SECRET}`)) {
    return new Response('Unauthorized', { status: 401 });
  }
  let body;
  try { body = await request.json(); } catch { return new Response('Bad Request', { status: 400 }); }

  if (body.type === 'draft_ready' && body.phone && body.client) {
    // Only allow callbacks for the configured owner number.
    if (body.phone !== env.WHATSAPP_OWNER_NUMBER) {
      return new Response('Forbidden', { status: 403 });
    }
    const cur = await getState(env, body.phone);
    await setState(env, body.phone, {
      ...cur,
      step: 'pending_review',
      client: body.client,
      pillar: body.pillar || cur.pillar || null,
      draftPath: body.draftPath || cur.draftPath || null,
    });
  }

  if (body.type === 'comment_reply_ready' && body.phone && body.client && body.postUrn && body.commentUrn) {
    if (body.phone !== env.WHATSAPP_OWNER_NUMBER) {
      return new Response('Forbidden', { status: 403 });
    }
    await notifyCommentReply(env, body);
  }

  return new Response('OK', { status: 200 });
}

// ── Main handler ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      const required = [
        'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_OWNER_NUMBER', 'GITHUB_TOKEN', 'WORKER_CALLBACK_SECRET',
      ];
      const checks = Object.fromEntries(required.map(k => [k, !!env[k]]));
      checks.STATE_KV = !!env.STATE;
      const ok = Object.values(checks).every(Boolean);
      return Response.json({ status: ok ? 'ok' : 'degraded', checks }, { status: ok ? 200 : 503 });
    }

    // Serve an image stashed from WhatsApp back to the GitHub Action at post time.
    // Authenticated with the same shared secret as /callback; only exposes media: keys.
    if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
      const auth = request.headers.get('Authorization') || '';
      if (!env.WORKER_CALLBACK_SECRET || !timingSafeEqual(auth, `Bearer ${env.WORKER_CALLBACK_SECRET}`)) {
        return new Response('Unauthorized', { status: 401 });
      }
      const key = decodeURIComponent(url.pathname.slice('/media/'.length));
      if (!key.startsWith('media:')) return new Response('Not Found', { status: 404 });
      const { value, metadata } = await env.STATE.getWithMetadata(key, 'arrayBuffer');
      if (!value) return new Response('Not Found', { status: 404 });
      return new Response(value, {
        headers: { 'Content-Type': metadata?.mime || 'application/octet-stream' },
      });
    }

    // Scope webhook verification strictly to root — prevents other GET paths from leaking challenge.
    if (request.method === 'GET' && url.pathname === '/') {
      const mode      = url.searchParams.get('hub.mode');
      const token     = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method === 'POST' && url.pathname === '/callback') {
      if (!env.WORKER_CALLBACK_SECRET) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return handleCallback(request, env);
    }

    if (request.method === 'POST') {
      if (!env.WHATSAPP_APP_SECRET) {
        console.error('WHATSAPP_APP_SECRET not configured');
        return new Response('Service Unavailable', { status: 503 });
      }
      const valid = await verifySignature(request, env.WHATSAPP_APP_SECRET);
      if (!valid) return new Response('Unauthorized', { status: 401 });

      if (!env.WHATSAPP_OWNER_NUMBER) {
        console.error('WHATSAPP_OWNER_NUMBER not configured');
        return new Response('Service Unavailable', { status: 503 });
      }

      let body;
      try { body = await request.json(); } catch { return new Response('Bad Request', { status: 400 }); }

      // Ignore delivery/read status callbacks — they have no messages array
      const value = body?.entry?.[0]?.changes?.[0]?.value;
      if (!value?.messages) return new Response('OK', { status: 200 });
      const message = value.messages[0];

      const from = message.from;
      if (from !== env.WHATSAPP_OWNER_NUMBER) {
        return new Response('OK', { status: 200 });
      }

      // Deduplicate — Meta replays webhooks after worker restarts/redeploys
      const msgKey = `msg:${message.id}`;
      const seen = await env.STATE.get(msgKey);
      if (seen) return new Response('OK', { status: 200 });
      await env.STATE.put(msgKey, '1', { expirationTtl: 300 });

      try {
        if (message.type === 'interactive') {
          const id = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
          if (id) await handleButtonReply(env, from, id);
        } else if (message.type === 'text') {
          const text = message.text.body.trim();
          await handleText(env, from, text);
        } else if (message.type === 'image') {
          await handleImage(env, from, message);
        } else if (message.type === 'document') {
          await handleDocument(env, from, message);
        }
      } catch (e) {
        console.error('[worker] Error:', e.message);
        await sendText(env, from, '⚠️ Something went wrong. Try again or reply *reset*.');
      }

      return new Response('OK', { status: 200 });
    }

    return new Response('Method Not Allowed', { status: 405 });
  },

  // Cloudflare Cron Trigger (wrangler.toml [triggers]) — fires every 15 min,
  // posts anything in the `scheduled:` KV namespace whose time has come.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processDueSchedules(env));
  },
};

// ── Scheduled posts ─────────────────────────────────────────────────────────
//
// KV keys are `scheduled:<ISO-UTC-timestamp>:<phone>` — the ISO prefix makes
// env.STATE.list() return them in chronological order for free (same trick
// used for draft filenames in src/drafts.js).

const MAX_SCHEDULE_ATTEMPTS = 4;

async function scheduleDraft(env, from, state, whenText) {
  const client = CLIENTS[state.client];
  const tz = client?.timezone || 'Asia/Kolkata';
  const when = parseScheduleTime(whenText, tz);

  if (!when) {
    await sendText(env, from,
      `Couldn't understand that time. Try one of:\n` +
      `• *schedule: 9am tomorrow*\n` +
      `• *schedule: 5pm today*\n` +
      `• *schedule: in 2 hours*\n` +
      `• *schedule: 2026-07-28 09:00*`
    );
    return;
  }

  const minLeadMs = 5 * 60_000; // cron checks every 15 min — anything sooner isn't reliable
  if (when.getTime() < Date.now() + minLeadMs) {
    await sendText(env, from,
      'That time is too soon (or already passed) — pick something at least a few minutes out, or reply *post* to publish now.'
    );
    return;
  }

  const isoMinute = when.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const key = `scheduled:${when.toISOString()}:${from}`;
  await env.STATE.put(key, JSON.stringify({
    client: state.client,
    draftPath: state.draftPath,
    imageKeys: state.imageKeys || [],
    documentKey: state.documentKey || null,
    phone: from,
    scheduledForISO: when.toISOString(),
    attempts: 0,
  }), { expirationTtl: 30 * 86400 });

  await clearState(env, from);

  await sendText(env, from,
    `📅 Scheduled for *${formatZoned(when, tz)}* (${tz}).\n\n` +
    `Reference: *${isoMinute}*\n` +
    `Reply *schedule list* to see pending posts, or *cancel schedule ${isoMinute}* to cancel this one.`
  );
}

async function listSchedules(env, from) {
  const { keys } = await env.STATE.list({ prefix: 'scheduled:' });
  if (!keys.length) {
    await sendText(env, from, 'No posts currently scheduled.');
    return;
  }
  const lines = ['📅 *Scheduled posts:*'];
  for (const k of keys) {
    const raw = await env.STATE.get(k.name);
    if (!raw) continue;
    const entry = JSON.parse(raw);
    const tz = CLIENTS[entry.client]?.timezone || 'Asia/Kolkata';
    const when = new Date(entry.scheduledForISO);
    const isoMinute = entry.scheduledForISO.slice(0, 16);
    lines.push(`• *${CLIENTS[entry.client]?.name || entry.client}* — ${formatZoned(when, tz)}  (id: ${isoMinute})`);
  }
  await sendText(env, from, lines.join('\n'));
}

async function cancelSchedule(env, from, idPrefix) {
  const { keys } = await env.STATE.list({ prefix: 'scheduled:' });
  if (!keys.length) {
    await sendText(env, from, 'No scheduled posts to cancel.');
    return;
  }
  if (!idPrefix && keys.length > 1) {
    await sendText(env, from,
      `You have ${keys.length} scheduled posts. Reply *schedule list* to see them, then *cancel schedule <id>* for a specific one.`
    );
    return;
  }
  const matches = idPrefix ? keys.filter(k => k.name.includes(idPrefix)) : keys;
  if (!matches.length) {
    await sendText(env, from, `No scheduled post matching *${idPrefix}*. Reply *schedule list* to see pending ones.`);
    return;
  }
  for (const k of matches) await env.STATE.delete(k.name);
  await sendText(env, from, `✅ Cancelled ${matches.length} scheduled post${matches.length > 1 ? 's' : ''}.`);
}

async function processDueSchedules(env) {
  const { keys } = await env.STATE.list({ prefix: 'scheduled:' });
  const now = Date.now();

  for (const k of keys) {
    const raw = await env.STATE.get(k.name);
    if (!raw) continue;
    const entry = JSON.parse(raw);
    if (new Date(entry.scheduledForISO).getTime() > now) break; // chronological order — nothing later is due either

    try {
      await triggerPost(env, entry.client, entry.draftPath, entry.imageKeys, entry.documentKey);
      await env.STATE.delete(k.name);
      await sendText(env, entry.phone,
        `⏰ Scheduled post for *${CLIENTS[entry.client]?.name || entry.client}* is going out now...`
      );
    } catch (e) {
      const attempts = (entry.attempts || 0) + 1;
      console.error(`[scheduled] dispatch failed for ${k.name} (attempt ${attempts}):`, e.message);
      if (attempts >= MAX_SCHEDULE_ATTEMPTS) {
        await env.STATE.delete(k.name);
        await sendText(env, entry.phone,
          `⚠️ Giving up on the scheduled post for *${CLIENTS[entry.client]?.name || entry.client}* after ${attempts} failed attempts.\n\n${e.message}\n\nReply *post* to try publishing it manually.`
        );
      } else {
        await env.STATE.put(k.name, JSON.stringify({ ...entry, attempts }), { expirationTtl: 30 * 86400 });
      }
    }
  }
}

// ── Text message handler ────────────────────────────────────────────────────

async function handleText(env, from, text) {
  const lower = text.toLowerCase();
  const state = await getState(env, from);

  if (lower === 'new post' || lower === 'new') {
    if (state.step === 'generating') {
      await sendText(env, from, '⏳ Already generating a post — please wait for the preview to arrive.');
      return;
    }
    await clearState(env, from);
    await setState(env, from, { step: 'awaiting_client' });
    await sendClientButtons(env, from);
    return;
  }

  if (lower === 'post') {
    await doPost(env, from, state);
    return;
  }

  if (lower === 'skip' || lower === 'drop') {
    await clearState(env, from);
    await sendText(env, from, '⏭ Draft skipped.\n\nReply *new post* to generate another.');
    return;
  }

  if (lower === 'regenerate' || lower === 'regen') {
    await doRegenerate(env, from, state);
    return;
  }

  if (lower === 'reset' || lower === 'cancel') {
    await clearState(env, from);
    await sendText(env, from, '🔄 Session cleared.\n\nReply *new post* to start fresh.');
    return;
  }

  if (lower === 'schedule list' || lower === 'scheduled') {
    await listSchedules(env, from);
    return;
  }

  if (lower.startsWith('cancel schedule')) {
    const idPrefix = text.slice('cancel schedule'.length).trim();
    await cancelSchedule(env, from, idPrefix);
    return;
  }

  if (lower === 'clear attachments' || lower === 'clear images') {
    if (!state.client) {
      await sendText(env, from, 'No active session.');
      return;
    }
    await setState(env, from, { ...state, imageKeys: [], documentKey: null });
    await sendText(env, from, '🗑 Cleared attached image(s)/document.');
    return;
  }

  if (lower === 'status') {
    await sendText(env, from, '✦ Auto-Poster is running.\n\nReply *new post* to start, or *help* for all commands.');
    return;
  }

  if (lower === 'help') {
    await sendHelp(env, from);
    return;
  }

  if (lower.startsWith('edit:')) {
    const instruction = text.slice(5).trim();
    if (!instruction) {
      await sendText(env, from, 'Please include an instruction.\n\nExample: *edit: make it shorter*');
      return;
    }
    const noActiveDraft = !state.client ||
      ['idle', 'awaiting_client', 'awaiting_pillar', 'awaiting_seed'].includes(state.step);
    if (noActiveDraft) {
      await sendText(env, from, 'No active draft to edit.\n\nReply *new post* to generate one first.');
      return;
    }
    await sendText(env, from,
      `✏️ Applying edit...\n\n_"${instruction.length > 80 ? instruction.slice(0, 80) + '…' : instruction}"_\n\nYou'll receive the revised draft shortly.`
    );
    await triggerEdit(env, from, state, instruction);
    return;
  }

  if (state.step === 'awaiting_seed') {
    // A URL can appear anywhere in the message, optionally alongside direction
    // text — e.g. "https://youtu.be/xyz focus on the training-data angle".
    // URL-only (or "none") behaves exactly as before: Claude picks the angle
    // from the source material alone. This is purely additive — nothing
    // changes for the simple "just paste a link" case.
    const urlMatch = text.match(/https:\/\/\S+/i);
    const contextUrl = urlMatch ? urlMatch[0].replace(/[.,;:!?)\]}'"]+$/, '') : null;
    const remainder = contextUrl ? text.replace(urlMatch[0], '').replace(/\s+/g, ' ').trim() : text.trim();
    const seed = (lower === 'none' || !remainder) ? null : remainder;

    const prevState = { ...state };
    await setState(env, from, { ...state, seed, contextUrl, step: 'generating' });
    const feedbackMsg = contextUrl
      ? `🔗 Reading source URL...\n\nGenerating post for *${CLIENTS[state.client]?.name || state.client}*${seed ? ' with your direction' : ''}. Preview incoming shortly.`
      : `⏳ Generating post for *${CLIENTS[state.client]?.name || state.client}*...\n\nYou'll receive a preview shortly.`;
    await sendText(env, from, feedbackMsg);
    try {
      await triggerGenerate(env, state.client, state.pillar, null, seed, from, contextUrl);
    } catch (e) {
      await setState(env, from, prevState);
      throw e;
    }
    return;
  }

  // Still generating — tell the user to wait rather than firing an edit on the wrong (previous) draft.
  if (state.client && state.step === 'generating') {
    await sendText(env, from, '⏳ Still generating — please wait for the preview before editing.');
    return;
  }

  if (state.client && state.step === 'pending_review' && lower.startsWith('schedule:')) {
    const whenText = text.slice('schedule:'.length).trim();
    if (!whenText) {
      await sendText(env, from, 'Include a time. Example: *schedule: 9am tomorrow*');
      return;
    }
    await scheduleDraft(env, from, state, whenText);
    return;
  }

  // Draft ready — treat any unrecognised message as an edit instruction.
  if (state.client && state.step === 'pending_review') {
    const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
    await sendText(env, from, `✏️ Applying edit...\n\n_"${preview}"_\n\nYou'll receive the revised draft shortly.`);
    await triggerEdit(env, from, state, text);
    return;
  }

  await sendText(env, from, 'Reply *new post* to generate a post, or *help* to see all commands.');
}

// ── Image / document message handlers ───────────────────────────────────────
//
// Images and a document are mutually exclusive attachment modes — LinkedIn
// posts are either a multi-image share or a single document/carousel share,
// never both. Attaching one clears the other.

const MAX_IMAGES = 9; // matches LinkedIn's own multi-image share UI limit

async function handleImage(env, from, message) {
  const state = await getState(env, from);

  if (!state.client || state.step === 'idle') {
    await sendText(env, from, 'Start with *new post* first — then drop an image and I\'ll attach it to the draft.');
    return;
  }

  const mediaId = message.image?.id;
  if (!mediaId) {
    await sendText(env, from, 'Couldn\'t read that image — please send it again.');
    return;
  }

  const existing = state.imageKeys || [];
  if (existing.length >= MAX_IMAGES) {
    await sendText(env, from, `You already have ${MAX_IMAGES} images attached (LinkedIn's limit for a multi-image post). Reply *clear attachments* to start over, or *post*/*schedule:* to publish as-is.`);
    return;
  }

  await sendText(env, from, '📎 Saving your image...');
  const { bytes, mime } = await downloadWhatsAppMedia(env, mediaId);

  // LinkedIn feedshare accepts JPEG/PNG/GIF. Reject anything else early with a clear message.
  if (!/^image\/(jpeg|jpg|png|gif)$/i.test(mime)) {
    await sendText(env, from, `That image type (${mime}) isn't supported by LinkedIn. Send a JPEG, PNG, or GIF.`);
    return;
  }

  const mediaKey = `media:${from}:${existing.length}`;
  // Keep 7 days so it survives a scheduled post, not just an immediate "Post it";
  // a new post detaches by resetting state regardless.
  await env.STATE.put(mediaKey, bytes, { expirationTtl: 604800, metadata: { mime } });

  const imageKeys = [...existing, mediaKey];
  // Attaching an image clears any previously attached document (mutually exclusive).
  await setState(env, from, { ...state, imageKeys, documentKey: null });

  const count = imageKeys.length;
  await sendText(env, from,
    state.step === 'pending_review'
      ? `✅ Image ${count > 1 ? `${count} attached (${count} total)` : 'attached'}. Tap *Post it* to publish with ${count > 1 ? 'these images' : 'this image'}, or send more (up to ${MAX_IMAGES}).`
      : '✅ Image saved — I\'ll attach it when your draft is ready.'
  );
}

async function handleDocument(env, from, message) {
  const state = await getState(env, from);

  if (!state.client || state.step === 'idle') {
    await sendText(env, from, 'Start with *new post* first — then send a PDF and I\'ll attach it as a document post.');
    return;
  }

  const mediaId = message.document?.id;
  const filename = message.document?.filename || 'document.pdf';
  if (!mediaId) {
    await sendText(env, from, 'Couldn\'t read that file — please send it again.');
    return;
  }

  await sendText(env, from, '📎 Saving your document...');
  const { bytes, mime } = await downloadWhatsAppMedia(env, mediaId);

  if (mime !== 'application/pdf') {
    await sendText(env, from, `Only PDF documents are supported for document/carousel posts (got ${mime}).`);
    return;
  }

  const docKey = `media:${from}:doc`;
  await env.STATE.put(docKey, bytes, { expirationTtl: 604800, metadata: { mime, filename } });

  // A document clears any previously attached images (mutually exclusive).
  await setState(env, from, { ...state, documentKey: docKey, imageKeys: [] });

  await sendText(env, from,
    state.step === 'pending_review'
      ? `✅ Document attached (*${filename}*). Tap *Post it* to publish as a document/carousel post.`
      : '✅ Document saved — I\'ll attach it when your draft is ready.'
  );
}

// Two-step WhatsApp media fetch: resolve the media ID to a URL, then download
// the bytes (both calls need the WA bearer token).
async function downloadWhatsAppMedia(env, mediaId) {
  const metaRes = await fetch(`${WA_API}/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!metaRes.ok) throw new Error(`WhatsApp media lookup failed (${metaRes.status})`);
  const meta = await metaRes.json();
  if (!meta?.url) throw new Error('WhatsApp media lookup returned no URL');

  const binRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!binRes.ok) throw new Error(`WhatsApp media download failed (${binRes.status})`);

  return { bytes: await binRes.arrayBuffer(), mime: meta.mime_type || 'image/jpeg' };
}

// ── Button/list reply handler ───────────────────────────────────────────────

async function handleButtonReply(env, from, id) {
  const state = await getState(env, from);

  // Button IDs use ':' as delimiter (not '_') so client IDs with hyphens parse cleanly.
  if (id.startsWith('client:')) {
    const client = id.split(':')[1];
    await setState(env, from, { step: 'awaiting_pillar', client });
    await sendPillarList(env, from, client);
    return;
  }

  if (id.startsWith('pillar:')) {
    // id format: pillar:<clientId>:<pillarId|claude>
    // Client is embedded in the button ID to avoid KV eventual-consistency gaps between taps.
    const [, clientId, pillarPart] = id.split(':');
    const pillar = pillarPart === 'claude' ? null : pillarPart;
    await setState(env, from, { step: 'awaiting_seed', client: clientId, pillar });
    await sendText(env, from, 'Any topic seed or source URL?\n\nReply with a topic hint, paste an *https://...* link — an article or a YouTube video (Claude will read it) — or say *none*.\n\nYou can combine both: paste a link plus your own direction in the same message, e.g. _https://... focus on the pricing angle, keep it skeptical_');
    return;
  }

  if (id === 'action_post')       { await doPost(env, from, state); return; }
  if (id === 'action_skip')       { await clearState(env, from); await sendText(env, from, '⏭ Draft skipped. Reply *new post* to generate another.'); return; }
  if (id === 'action_regenerate') { await doRegenerate(env, from, state); return; }

  if (id.startsWith('commentreply:')) {
    const [, action, replyId] = id.split(':');
    await handleCommentReplyButton(env, from, action, replyId);
    return;
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function doPost(env, from, state) {
  // Send confirmation first so the user gets feedback immediately.
  const imageCount = (state.imageKeys || []).length;
  const withMedia = state.documentKey ? ' (with your document)' : imageCount > 0 ? ` (with ${imageCount} image${imageCount > 1 ? 's' : ''})` : '';
  await sendText(env, from, `✅ Posting to LinkedIn now${withMedia}...\n\nCheck your profile in ~30 seconds.`);
  try {
    await triggerPost(env, state.client || null, state.draftPath || null, state.imageKeys || [], state.documentKey || null);
    // Don't delete the KV media here — the Action fetches it moments later. TTL
    // (and the next post resetting state) handles cleanup without a race.
    await clearState(env, from);
  } catch (e) {
    // Dispatch failed — keep state so the user can retry.
    await sendText(env, from, '⚠️ Failed to trigger post — please try again or type *reset* if stuck.');
    throw e;
  }
}

async function doRegenerate(env, from, state) {
  if (!state.client) {
    await sendText(env, from, 'No active session. Reply *new post* to start.');
    return;
  }
  if (state.step === 'generating') {
    await sendText(env, from, '⏳ Already generating — please wait for the preview to arrive.');
    return;
  }
  const prevState = { ...state };
  await setState(env, from, { ...state, step: 'generating' });
  await sendText(env, from, '🔄 Regenerating... you\'ll receive a new preview shortly.');
  try {
    await triggerGenerate(env, state.client, state.pillar, null, state.seed, from, state.contextUrl || null);
  } catch (e) {
    // Revert so the user isn't stuck at 'generating' forever.
    await setState(env, from, prevState);
    throw e;
  }
}

// ── Comment reply approval ──────────────────────────────────────────────────
//
// Separate from the main draft-review conversational slot (state:<phone>) —
// multiple comment replies can be pending approval at once, each tracked
// independently under commentreply:<phone>:<id> so they don't interfere with
// an in-progress "new post" flow or each other.

async function shortHash(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).slice(0, 5).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function notifyCommentReply(env, body) {
  const { phone, client, postUrn, commentUrn, commentText, draftedReply } = body;
  const replyId = await shortHash(commentUrn);
  const key = `commentreply:${phone}:${replyId}`;

  await env.STATE.put(key, JSON.stringify({ client, postUrn, commentUrn, commentText, draftedReply }), {
    expirationTtl: 7 * 86400,
  });

  const clientName = CLIENTS[client]?.name || client;
  const truncated = commentText.length > 200 ? commentText.slice(0, 200) + '…' : commentText;
  await sendButtons(env, phone,
    `💬 *New comment on ${clientName}'s post*\n\n"${truncated}"\n\n*Drafted reply:*\n"${draftedReply}"`,
    [
      { id: `commentreply:post:${replyId}`, title: '✅ Post reply' },
      { id: `commentreply:skip:${replyId}`, title: '❌ Skip' },
    ]
  );
}

async function handleCommentReplyButton(env, from, action, replyId) {
  const key = `commentreply:${from}:${replyId}`;
  const raw = await env.STATE.get(key);
  if (!raw) {
    await sendText(env, from, 'That comment reply is no longer pending (expired or already handled).');
    return;
  }
  const entry = JSON.parse(raw);

  if (action === 'skip') {
    await env.STATE.delete(key);
    await sendText(env, from, '⏭ Skipped.');
    return;
  }

  if (action === 'post') {
    await sendText(env, from, '✅ Posting reply...');
    try {
      await triggerReplyComment(env, entry.client, entry.postUrn, entry.draftedReply);
      await env.STATE.delete(key);
    } catch (e) {
      await sendText(env, from, '⚠️ Failed to trigger reply — please try again.');
      throw e;
    }
  }
}

// ── Interactive message senders ─────────────────────────────────────────────

async function sendClientButtons(env, from) {
  await sendButtons(env, from,
    'Which client would you like to post for?',
    Object.entries(CLIENTS).map(([id, c]) => ({ id: `client:${id}`, title: c.name }))
  );
}

async function sendPillarList(env, from, clientId) {
  const client = CLIENTS[clientId];
  const rows = [
    { id: `pillar:${clientId}:claude`, title: 'Claude picks', description: 'AI selects the best topic today' },
    ...client.pillars.map(p => ({ id: `pillar:${clientId}:${p.id}`, title: p.title })),
  ];
  await sendList(env, from, `Pick a content pillar for *${client.name}*:`, 'Select pillar', rows);
}

async function sendHelp(env, from) {
  await sendText(env, from,
    `*Auto-Poster Commands*\n\n` +
    `• *new post* — guided post generation\n` +
    `  When asked for a seed, paste an https://... URL (article or YouTube video) and Claude will read it as source material\n` +
    `• *post* — publish latest draft to LinkedIn\n` +
    `• *skip* — discard latest draft\n` +
    `• *regenerate* — rewrite with same topic/source\n` +
    `• *[your instruction]* — refine the draft once preview arrives\n` +
    `  e.g. _make it shorter_\n` +
    `  e.g. _sharpen the opening hook_\n` +
    `• *send an image* — once you have a draft, drop a photo (JPEG/PNG/GIF); send more for a multi-image post (up to 9)\n` +
    `• *send a PDF* — attach it as a document/carousel post instead (clears any attached images)\n` +
    `• *clear attachments* — remove any attached image(s)/document\n` +
    `• *schedule: [when]* — once you have a draft, schedule it instead of posting now\n` +
    `  e.g. _schedule: 9am tomorrow_ · _schedule: in 2 hours_ · _schedule: 2026-08-01 09:00_\n` +
    `• *schedule list* — see pending scheduled posts\n` +
    `• *cancel schedule [id]* — cancel a pending scheduled post\n` +
    `• *status* — check bot status\n` +
    `• *reset* — clear stuck session and start over\n` +
    `• *help* — show this menu`
  );
}

// ── WhatsApp API ────────────────────────────────────────────────────────────

async function sendText(env, to, text) {
  await waPost(env, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
}

async function sendButtons(env, to, body, buttons) {
  await waPost(env, {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button', body: { text: body },
      action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  });
}

async function sendList(env, to, body, buttonText, rows) {
  await waPost(env, {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'list', body: { text: body },
      action: { button: buttonText, sections: [{ title: 'Options', rows: rows.slice(0, 10) }] },
    },
  });
}

async function waPost(env, payload) {
  const res = await fetch(`${WA_API}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(data)}`);
  }
}

// ── GitHub Actions triggers ─────────────────────────────────────────────────

async function triggerGenerate(env, client, pillar, format, seed, phone, url) {
  const inputs = { client: client || 'irfan' };
  if (pillar) inputs.pillar = pillar;
  if (format) inputs.format = format;
  if (seed)   inputs.seed   = seed;
  if (phone)  inputs.phone  = phone;
  if (url)    inputs.url    = url;
  await ghDispatch(env, 'generate.yml', inputs);
}

async function triggerPost(env, client, draftPath, imageKeys, documentKey) {
  const inputs = {};
  if (client)                    inputs.client       = client;
  if (draftPath)                 inputs.draft_path   = draftPath;
  if (imageKeys && imageKeys.length) inputs.image_keys  = imageKeys.join(',');
  if (documentKey)               inputs.document_key = documentKey;
  await ghDispatch(env, 'post.yml', inputs);
}

async function triggerEdit(env, from, state, instruction) {
  const inputs = {
    instruction,
    client: state.client,
    phone: from,
  };
  if (state.pillar)    inputs.pillar     = state.pillar;
  if (state.draftPath) inputs.draft_path = state.draftPath;
  await ghDispatch(env, 'edit.yml', inputs);
}

async function triggerReplyComment(env, client, postUrn, replyText) {
  await ghDispatch(env, 'reply-comment.yml', { client, post_urn: postUrn, reply_text: replyText });
}

async function ghDispatch(env, workflow, inputs) {
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'auto-poster-worker/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub dispatch failed (${res.status}): ${text}`);
  }
}
