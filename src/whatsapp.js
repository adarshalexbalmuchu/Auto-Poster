/**
 * whatsapp.js — Send messages and media via Meta WhatsApp Cloud API
 *
 * Required env vars:
 *   WHATSAPP_ACCESS_TOKEN     — permanent system user token
 *   WHATSAPP_PHONE_NUMBER_ID  — phone number ID (not the number itself)
 *   WHATSAPP_RECIPIENT_NUMBER — your WhatsApp number in E.164 format (e.g. 919876543210)
 */

const API = 'https://graph.facebook.com/v20.0';

function getEnv() {
  return {
    token:         process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    to:            process.env.WHATSAPP_RECIPIENT_NUMBER,
  };
}

async function waPost(phoneNumberId, token, payload) {
  const res = await fetch(`${API}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

export async function sendWhatsApp(text) {
  const { token, phoneNumberId, to } = getEnv();
  if (!token || !phoneNumberId || !to) {
    console.warn('[whatsapp] Credentials missing — notification skipped');
    return;
  }
  await waPost(phoneNumberId, token, {
    messaging_product: 'whatsapp', to, type: 'text', text: { body: text },
  });
}

async function sendButtons(phoneNumberId, token, to, body, buttons) {
  await waPost(phoneNumberId, token, {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button', body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    },
  });
}

export async function sendDraftNotification(result) {
  const { token, phoneNumberId, to } = getEnv();
  if (!token || !phoneNumberId || !to) {
    console.warn('[whatsapp] Credentials missing — draft notification skipped');
    return;
  }

  const { client, topicData, postText } = result;

  // WhatsApp hard-caps text.body at 4096 chars. The topic can be huge when
  // it's a block of pasted article text used as the seed (the workaround for
  // sites that block automated fetching), so it needs its own bound — a fixed
  // truncation of postText alone isn't enough once the header grows past it.
  const MAX_BODY = 4000;
  const topic = topicData.topic.length > 200
    ? topicData.topic.slice(0, 200) + '…'
    : topicData.topic;
  const header = `✦ *New draft ready — ${client.name}*\n*Pillar:* ${topicData.pillarId}\n*Topic:* ${topic}\n\n---\n`;
  const footer = '\n---';
  const previewBudget = Math.max(0, MAX_BODY - header.length - footer.length);
  const preview = postText.length > previewBudget
    ? postText.slice(0, previewBudget) + '…'
    : postText;

  try {
    await waPost(phoneNumberId, token, {
      messaging_product: 'whatsapp', to, type: 'text',
      text: { body: `${header}${preview}${footer}` },
    });
  } catch (e) {
    // Never leave the user with a generated draft they have no way to know
    // about — if the full preview still fails for some other reason, fall
    // back to a short alert so they at least know to check for it.
    console.warn(`[whatsapp] Full draft notification failed (${e.message}); sending fallback alert`);
    await waPost(phoneNumberId, token, {
      messaging_product: 'whatsapp', to, type: 'text',
      text: {
        body: `✦ *New draft ready — ${client.name}*\n*Pillar:* ${topicData.pillarId}\n\nThe full preview couldn't be sent. Reply *post* to publish it as-is.`,
      },
    });
  }

  await sendButtons(phoneNumberId, token, to,
    'What would you like to do?\n\nTo refine, reply *edit: [your instruction]*\ne.g. _edit: sharpen the hook_\n\nOr *schedule: [when]* to post later, e.g. _schedule: 9am tomorrow_',
    [
      { id: 'action_post',       title: '✅ Post it'    },
      { id: 'action_skip',       title: '❌ Skip'       },
      { id: 'action_regenerate', title: '🔄 Regenerate' },
    ]
  );
}
