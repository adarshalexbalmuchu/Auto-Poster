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

  const header = `✦ *New draft ready — ${client.name}*\n*Pillar:* ${topicData.pillarId}\n*Topic:* ${topicData.topic}\n\n`;
  const preview = postText.length > 3900 ? postText.slice(0, 3900) + '…' : postText;
  await waPost(phoneNumberId, token, {
    messaging_product: 'whatsapp', to, type: 'text',
    text: { body: `${header}---\n${preview}\n---` },
  });

  await sendButtons(phoneNumberId, token, to,
    'What would you like to do?\n\nTo refine, reply *edit: [your instruction]*\ne.g. _edit: sharpen the hook_',
    [
      { id: 'action_post',       title: '✅ Post it'    },
      { id: 'action_skip',       title: '❌ Skip'       },
      { id: 'action_regenerate', title: '🔄 Regenerate' },
    ]
  );
}
