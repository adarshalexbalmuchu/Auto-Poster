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
 *   STATE — stores conversation state per user (1 hour TTL)
 */

const WA_API = 'https://graph.facebook.com/v20.0';
const GH_API = 'https://api.github.com';

const CLIENTS = {
  irfan: {
    name: 'Irfan',
    pillars: [
      { id: 'ai-at-work',    title: 'AI at Work'      },
      { id: 'adoption-gap',  title: 'Adoption Gap'    },
      { id: 'human-side-ai', title: 'Human Side of AI'},
      { id: 'sharp-takes',   title: 'Sharp Takes'     },
    ],
  },
  alex: {
    name: 'Alex',
    pillars: [
      { id: 'ai-watch',          title: 'AI Watch'          },
      { id: 'policy-and-power',  title: 'Policy & Power'    },
      { id: 'building-in-public',title: 'Building in Public'},
      { id: 'the-notebook',      title: 'The Notebook'      },
      { id: 'sharp-takes',       title: 'Sharp Takes'       },
    ],
  },
};

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
  const ts = parseInt(request.headers.get('x-hub-timestamp') || '0', 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
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
    const cur = await getState(env, body.phone);
    await setState(env, body.phone, {
      ...cur,
      step: 'pending_review',
      client: body.client,
      pillar: body.pillar || cur.pillar || null,
      draftPath: body.draftPath || cur.draftPath || null,
    });
  }
  return new Response('OK', { status: 200 });
}

// ── Main handler ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
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

      const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!message) return new Response('OK', { status: 200 });

      const from = message.from;
      if (from !== env.WHATSAPP_OWNER_NUMBER) {
        return new Response('OK', { status: 200 });
      }

      try {
        if (message.type === 'interactive') {
          const id = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
          if (id) await handleButtonReply(env, from, id);
        } else if (message.type === 'text') {
          const text = message.text.body.trim();
          await handleText(env, from, text);
        }
      } catch (e) {
        console.error('[worker] Error:', e.message);
        await sendText(env, from, '⚠️ Something went wrong. Try again or reply *help*.');
      }

      return new Response('OK', { status: 200 });
    }

    return new Response('Method Not Allowed', { status: 405 });
  },
};

// ── Text message handler ────────────────────────────────────────────────────

async function handleText(env, from, text) {
  const lower = text.toLowerCase();
  const state = await getState(env, from);

  if (lower === 'new post' || lower === 'new') {
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
    const seed = lower === 'none' ? null : text;
    const newState = { ...state, seed, step: 'generating' };
    await setState(env, from, newState);
    await sendText(env, from, `⏳ Generating post for *${CLIENTS[state.client]?.name || state.client}*...\n\nYou'll receive a preview shortly.`);
    await triggerGenerate(env, state.client, state.pillar, null, seed, from);
    return;
  }

  await sendText(env, from, 'Reply *new post* to generate a post, or *help* to see all commands.');
}

// ── Button/list reply handler ───────────────────────────────────────────────

async function handleButtonReply(env, from, id) {
  const state = await getState(env, from);

  if (id.startsWith('client_')) {
    const client = id.replace('client_', '');
    await setState(env, from, { step: 'awaiting_pillar', client });
    await sendPillarList(env, from, client);
    return;
  }

  if (id.startsWith('pillar_')) {
    const pillar = id === 'pillar_claude' ? null : id.replace('pillar_', '');
    await setState(env, from, { ...state, step: 'awaiting_seed', pillar });
    await sendText(env, from, 'Any topic seed? Reply with a hint or say *none* and Claude will pick.');
    return;
  }

  if (id === 'action_post')       { await doPost(env, from, state); return; }
  if (id === 'action_skip')       { await clearState(env, from); await sendText(env, from, '⏭ Draft skipped. Reply *new post* to generate another.'); return; }
  if (id === 'action_regenerate') { await doRegenerate(env, from, state); return; }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function doPost(env, from, state) {
  await clearState(env, from);
  await sendText(env, from, '✅ Posting to LinkedIn now...\n\nCheck your profile in ~30 seconds.');
  await triggerPost(env, state.client || null, state.draftPath || null);
}

async function doRegenerate(env, from, state) {
  if (!state.client) {
    await sendText(env, from, 'No active session. Reply *new post* to start.');
    return;
  }
  await setState(env, from, { ...state, step: 'generating' });
  await sendText(env, from, '🔄 Regenerating... you\'ll receive a new preview shortly.');
  await triggerGenerate(env, state.client, state.pillar, null, state.seed, from);
}

// ── Interactive message senders ─────────────────────────────────────────────

async function sendClientButtons(env, from) {
  await sendButtons(env, from,
    'Which client would you like to post for?',
    Object.entries(CLIENTS).map(([id, c]) => ({ id: `client_${id}`, title: c.name }))
  );
}

async function sendPillarList(env, from, clientId) {
  const client = CLIENTS[clientId];
  const rows = [
    { id: 'pillar_claude', title: 'Claude picks', description: 'AI selects the best topic today' },
    ...client.pillars.map(p => ({ id: `pillar_${p.id}`, title: p.title })),
  ];
  await sendList(env, from, `Pick a content pillar for *${client.name}*:`, 'Select pillar', rows);
}

async function sendHelp(env, from) {
  await sendText(env, from,
    `*Auto-Poster Commands*\n\n` +
    `• *new post* — guided post generation\n` +
    `• *post* — publish latest draft to LinkedIn\n` +
    `• *skip* — discard latest draft\n` +
    `• *regenerate* — rewrite with same topic\n` +
    `• *edit: [instruction]* — refine current draft\n` +
    `  e.g. _edit: sharpen the opening hook_\n` +
    `  e.g. _edit: make it shorter_\n` +
    `• *status* — check bot status\n` +
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

async function triggerGenerate(env, client, pillar, format, seed, phone) {
  const inputs = { client: client || 'irfan' };
  if (pillar) inputs.pillar = pillar;
  if (format) inputs.format = format;
  if (seed)   inputs.seed   = seed;
  if (phone)  inputs.phone  = phone;
  await ghDispatch(env, 'generate.yml', inputs);
}

async function triggerPost(env, client, draftPath) {
  const inputs = {};
  if (client)    inputs.client     = client;
  if (draftPath) inputs.draft_path = draftPath;
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
