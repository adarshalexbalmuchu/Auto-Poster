/**
 * whatsapp.js — Send messages and media via Meta WhatsApp Cloud API
 *
 * Required env vars:
 *   WHATSAPP_ACCESS_TOKEN     — permanent system user token
 *   WHATSAPP_PHONE_NUMBER_ID  — phone number ID (not the number itself)
 *   WHATSAPP_RECIPIENT_NUMBER — your WhatsApp number in E.164 format (e.g. 919876543210)
 */

import { readFileSync } from 'node:fs';

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
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

export async function sendWhatsApp(text) {
  const { token, phoneNumberId, to } = getEnv();
  if (!token || !phoneNumberId || !to) return;
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

async function uploadMedia(phoneNumberId, token, filePath, contentType) {
  const fileBuffer = readFileSync(filePath);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', contentType);
  form.append('file', new Blob([fileBuffer], { type: contentType }), filePath.split('/').pop());

  const res = await fetch(`${API}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Media upload failed ${res.status}: ${JSON.stringify(data)}`);
  return data.id;
}

async function sendDocument(phoneNumberId, token, to, mediaId, caption, filename) {
  await waPost(phoneNumberId, token, {
    messaging_product: 'whatsapp', to, type: 'document',
    document: { id: mediaId, caption, filename },
  });
}

export async function sendDraftNotification(result, draftFilename) {
  const { token, phoneNumberId, to } = getEnv();
  if (!token || !phoneNumberId || !to) return;

  const { client, topicData, postText, type, carouselData } = result;

  const header = [
    `✦ *New draft ready — ${client.name}*`,
    `*Pillar:* ${topicData.pillarId}`,
    `*Topic:* ${topicData.topic}`,
    type === 'carousel' ? `*Type:* Carousel (PDF)` : '',
    '',
  ].filter(l => l !== null).join('\n');

  if (type === 'carousel' && carouselData) {
    // Send carousel: text preview of slides
    const slideList = carouselData.slides
      .map(s => `${s.id}. *${s.headline}*\n${s.body.slice(0, 80)}${s.body.length > 80 ? '…' : ''}`)
      .join('\n\n');

    const preview = `${header}*Slides:*\n${slideList}\n\n*Caption:*\n${carouselData.caption.slice(0, 400)}${carouselData.caption.length > 400 ? '…' : ''}`;
    await waPost(phoneNumberId, token, {
      messaging_product: 'whatsapp', to, type: 'text', text: { body: preview },
    });

    // Try to send the PDF if it exists
    const pdfPath = draftFilename.replace('.json', '.pdf');
    try {
      const mediaId = await uploadMedia(phoneNumberId, token, pdfPath, 'application/pdf');
      await sendDocument(phoneNumberId, token, to, mediaId, carouselData.caption.slice(0, 1024), `${topicData.topic.slice(0, 40)}.pdf`);
    } catch {
      // PDF not yet generated — that's fine, user has the text preview
    }
  } else {
    // Text post preview
    const preview = postText.length > 3500 ? postText.slice(0, 3500) + '…' : postText;
    await waPost(phoneNumberId, token, {
      messaging_product: 'whatsapp', to, type: 'text',
      text: { body: `${header}---\n${preview}\n---` },
    });
  }

  // Send action buttons
  await sendButtons(phoneNumberId, token, to,
    'What would you like to do?',
    [
      { id: 'action_post',       title: '✅ Post it'    },
      { id: 'action_skip',       title: '❌ Skip'       },
      { id: 'action_regenerate', title: '🔄 Regenerate' },
    ]
  );
}
