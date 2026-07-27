#!/usr/bin/env node
/**
 * post-comment-reply.js — Publish an approved reply to a LinkedIn comment
 *
 * Dispatched by reply-comment.yml after a WhatsApp approval (see the
 * `commentreply:` button/state handling in worker/index.js).
 */

import 'dotenv/config';
import { loadClient } from './generate.js';
import { postComment } from './linkedin.js';
import { sendWhatsApp } from './whatsapp.js';

async function main() {
  const clientId = process.env.INPUT_CLIENT;
  const postUrn  = process.env.INPUT_POST_URN;
  const replyText = process.env.INPUT_REPLY_TEXT;

  if (!clientId || !postUrn || !replyText) {
    console.error('Usage: INPUT_CLIENT, INPUT_POST_URN and INPUT_REPLY_TEXT must all be set');
    process.exit(1);
  }

  const client = loadClient(clientId);
  console.log(`Posting reply for ${client.name} on ${postUrn}:`);
  console.log(`"${replyText}"`);

  await postComment(client, postUrn, replyText);
  console.log('✓ Reply posted');
}

main().catch(async e => {
  console.error('Failed:', e.message);
  try {
    await sendWhatsApp(`⚠️ Posting comment reply failed.\n\n${e.message}`);
  } catch (notifyErr) {
    console.error('  (could not send failure notification:', notifyErr.message + ')');
  }
  process.exit(1);
});
