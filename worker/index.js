/**
 * Cloudflare Worker — WhatsApp webhook handler for Auto-Poster
 *
 * Handles incoming WhatsApp replies and triggers GitHub Actions workflows.
 *
 * Commands (reply in WhatsApp):
 *   post   → triggers the "Post to LinkedIn" GitHub Actions workflow
 *   skip   → sends confirmation, no action
 *
 * Environment variables (set via wrangler secret put or Cloudflare dashboard):
 *   WHATSAPP_VERIFY_TOKEN    — any random string, must match Meta webhook config
 *   WHATSAPP_ACCESS_TOKEN    — Meta permanent token (to send reply messages)
 *   WHATSAPP_PHONE_NUMBER_ID — your WhatsApp Business phone number ID
 *   WHATSAPP_OWNER_NUMBER    — your personal WhatsApp number (E.164, e.g. 919876543210)
 *   GITHUB_TOKEN             — GitHub PAT with actions:write scope
 *   GITHUB_REPO              — e.g. adarshalexbalmuchu/Auto-Poster
 */

const WA_API = 'https://graph.facebook.com/v20.0';
const GH_API = 'https://api.github.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Webhook verification (GET) ──────────────────────────────────────────
    if (request.method === 'GET') {
      const mode      = url.searchParams.get('hub.mode');
      const token     = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');

      if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    // ── Incoming message (POST) ─────────────────────────────────────────────
    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      const entry   = body?.entry?.[0];
      const change  = entry?.changes?.[0];
      const value   = change?.value;
      const message = value?.messages?.[0];

      if (!message) return new Response('OK', { status: 200 });

      const from = message.from;
      const text = message.text?.body?.trim().toLowerCase() ?? '';

      // Only process messages from the owner's number
      if (env.WHATSAPP_OWNER_NUMBER && from !== env.WHATSAPP_OWNER_NUMBER) {
        return new Response('OK', { status: 200 });
      }

      if (text === 'post') {
        await triggerPost(env);
        await sendReply(env, from, '✅ Posting to LinkedIn now... check your profile in ~30 seconds.');
      } else if (text === 'skip') {
        await sendReply(env, from, '⏭ Draft skipped. A new one will be generated tomorrow.');
      } else if (text === 'status') {
        await sendReply(env, from, '✦ Auto-Poster is running. Reply *post* to publish the latest draft, *skip* to discard it.');
      } else {
        await sendReply(env, from,
          `I didn\'t understand that. Reply:\n• *post* — publish to LinkedIn\n• *skip* — discard draft\n• *status* — check bot status`
        );
      }

      return new Response('OK', { status: 200 });
    }

    return new Response('Method Not Allowed', { status: 405 });
  },
};

// ── Trigger GitHub Actions post workflow ────────────────────────────────────

async function triggerPost(env) {
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/actions/workflows/post.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main', inputs: {} }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub dispatch failed (${res.status}): ${text}`);
  }
}

// ── Send WhatsApp reply ─────────────────────────────────────────────────────

async function sendReply(env, to, text) {
  await fetch(`${WA_API}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
}
