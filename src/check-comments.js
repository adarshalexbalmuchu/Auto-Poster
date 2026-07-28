#!/usr/bin/env node
/**
 * check-comments.js — Poll for new comments on recently published posts and
 * draft a reply for each, sent to WhatsApp for one-tap approval.
 *
 * Run via comment-check.yml (cron, every 30 min) or manually:
 *   node src/check-comments.js
 *
 * LinkedIn has no comment webhooks for member posts, so this polls instead —
 * see the confidence notes on getComments()/postComment() in linkedin.js for
 * what's unverified about the underlying API calls.
 */

import 'dotenv/config';
import { readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadClient, MODEL, buildHardRules } from './generate.js';
import { getComments, envKey } from './linkedin.js';

const DRAFTS_DIR = './drafts';
const WINDOW_DAYS = 14; // only check comments on posts published in the last N days

const anthropic = new Anthropic();

function loadRecentPostedDrafts() {
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
  try {
    return readdirSync(DRAFTS_DIR)
      .filter(f => f.endsWith('.json') && f !== 'history.json')
      .map(f => {
        const path = `${DRAFTS_DIR}/${f}`;
        try { return { path, draft: JSON.parse(readFileSync(path, 'utf8')) }; }
        catch { return null; }
      })
      .filter(Boolean)
      .filter(({ draft }) => draft.posted && draft.linkedInPostId && new Date(draft.postedAt).getTime() >= cutoff);
  } catch { return []; }
}

async function draftReply(client, commentText) {
  const prompt =
    `You are ${client.name}, replying to a comment on your own LinkedIn post.\n\n` +
    `VOICE AND STYLE RULES:\n${client.voice}\n\n` +
    `HARD RULES:\n${buildHardRules(client)}\n` +
    `- Keep it short — a real reply, not a mini-essay. 1-3 sentences.\n` +
    `- No preamble. Return only the reply text.\n\n` +
    `Comment: "${commentText}"\n\n` +
    `Write your reply:`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

async function notifyWorker(payload) {
  const workerUrl = process.env.WORKER_URL;
  const callbackSecret = process.env.WORKER_CALLBACK_SECRET;
  if (!workerUrl || !callbackSecret) {
    console.warn('WORKER_URL/WORKER_CALLBACK_SECRET not set — cannot notify about new comment');
    return;
  }
  const res = await fetch(`${workerUrl}/callback`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${callbackSecret}`,
      'Content-Type': 'application/json',
      'User-Agent': 'auto-poster-comments/1.0',
    },
    body: JSON.stringify({ type: 'comment_reply_ready', ...payload }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) console.warn(`Worker callback failed (${res.status})`);
}

function saveSeenComments(path, draft, seenIds) {
  const updated = { ...draft, seenCommentIds: seenIds };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(updated, null, 2));
  renameSync(tmp, path);
}

async function main() {
  const phone = process.env.WHATSAPP_RECIPIENT_NUMBER;
  const entries = loadRecentPostedDrafts();
  if (!entries.length) {
    console.log(`No posts published in the last ${WINDOW_DAYS} days — nothing to check.`);
    return;
  }

  let newCount = 0;

  for (const { path, draft } of entries) {
    const token = envKey(draft.clientId, 'ACCESS_TOKEN');
    if (!token) { console.warn(`No token for ${draft.clientId} — skipping`); continue; }

    const comments = await getComments(draft.linkedInPostId, token);
    if (!comments) continue; // fetch failed / endpoint shape mismatch — skip, retried next run

    const selfUrn = envKey(draft.clientId, 'PERSON_URN');
    const seenIds = new Set(draft.seenCommentIds || []);
    let changed = false;

    for (const comment of comments) {
      const id = comment.id || comment.$URN;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      changed = true;

      // Skip the client's own comments (replies made outside this tool, etc).
      if (comment.actor === selfUrn) continue;

      const commentText = comment.message?.text || '';
      if (!commentText) continue;

      console.log(`New comment on ${draft.clientId}'s post: "${commentText.slice(0, 80)}"`);

      let reply;
      try {
        const client = loadClient(draft.clientId);
        reply = await draftReply(client, commentText);
      } catch (e) {
        console.warn(`Could not draft reply: ${e.message}`);
        continue;
      }

      await notifyWorker({
        phone,
        client: draft.clientId,
        postUrn: draft.linkedInPostId,
        commentUrn: id,
        commentText,
        draftedReply: reply,
      });
      newCount++;
    }

    if (changed) saveSeenComments(path, draft, [...seenIds]);
  }

  console.log(newCount > 0 ? `${newCount} new comment(s) sent for review.` : 'No new comments.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
