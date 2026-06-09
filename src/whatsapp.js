/**
 * whatsapp.js — Send messages via Meta WhatsApp Cloud API
 *
 * Required env vars:
 *   WHATSAPP_ACCESS_TOKEN     — permanent token from Meta developer portal
 *   WHATSAPP_PHONE_NUMBER_ID  — phone number ID (not the number itself)
 *   WHATSAPP_RECIPIENT_NUMBER — your WhatsApp number in E.164 format (e.g. 919876543210)
 */

const API = 'https://graph.facebook.com/v20.0';

export async function sendWhatsApp(text) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const to = process.env.WHATSAPP_RECIPIENT_NUMBER;

  if (!token || !phoneNumberId || !to) return;

  const res = await fetch(`${API}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp API error: ${JSON.stringify(data)}`);
  }
}

export function formatDraftMessage(result, draftFilename) {
  const { topicData, postText, type } = result;
  const preview = postText.length > 600
    ? postText.slice(0, 600) + '…'
    : postText;

  return [
    `✦ *Auto-Poster* — New draft ready`,
    ``,
    `*Pillar:* ${topicData.pillarId}`,
    `*Topic:* ${topicData.topic}`,
    type === 'carousel' ? `*Type:* Carousel (PDF)` : '',
    ``,
    `---`,
    preview,
    `---`,
    ``,
    `Reply:`,
    `• *post* — publish to LinkedIn now`,
    `• *skip* — discard this draft`,
  ].filter(l => l !== null && l !== undefined).join('\n');
}
