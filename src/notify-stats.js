#!/usr/bin/env node
/**
 * notify-stats.js — WhatsApp 24h engagement notification for recently posted drafts
 *
 * Finds drafts posted 20–32 hours ago, fetches LinkedIn reactions/comments/shares,
 * and sends a WhatsApp summary.
 *
 * Run via analytics-notify.yml (daily cron) or manually:
 *   node src/notify-stats.js
 */

import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { sendWhatsApp } from './whatsapp.js';
import { getEngagementSummary, getSocialActions } from './analytics.js';
import { envKey } from './linkedin.js';

const DRAFTS_DIR = './drafts';
const WINDOW_MIN_H = 20;
const WINDOW_MAX_H = 32;

function loadRecentPostedDrafts() {
  const now = Date.now();
  const minMs = WINDOW_MIN_H * 3_600_000;
  const maxMs = WINDOW_MAX_H * 3_600_000;

  try {
    return readdirSync(DRAFTS_DIR)
      .filter(f => f.endsWith('.json') && f !== 'history.json')
      .map(f => {
        try { return JSON.parse(readFileSync(`${DRAFTS_DIR}/${f}`, 'utf8')); }
        catch { return null; }
      })
      .filter(d => {
        if (!d?.posted || !d?.postedAt || !d?.linkedInPostId) return false;
        const age = now - new Date(d.postedAt).getTime();
        return age >= minMs && age <= maxMs;
      });
  } catch { return []; }
}

function engagementBar(n, max = 50) {
  const filled = Math.round((n / Math.max(max, 1)) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

async function main() {
  const drafts = loadRecentPostedDrafts();

  if (!drafts.length) {
    console.log(`No posts in the ${WINDOW_MIN_H}–${WINDOW_MAX_H}h window.`);
    return;
  }

  for (const draft of drafts) {
    const token = envKey(draft.clientId, 'ACCESS_TOKEN');
    if (!token) {
      console.warn(`No token for ${draft.clientId} — skipping`);
      continue;
    }

    const actions = await getSocialActions(draft.linkedInPostId, token).catch(() => null);
    if (!actions) {
      console.warn(`Could not fetch stats for post ${draft.linkedInPostId}`);
      continue;
    }

    const reactions = actions.numLikes    || 0;
    const comments  = actions.numComments || 0;
    const shares    = actions.numShares   || 0;
    const total     = reactions + comments + shares;

    const hook    = draft.postText?.split('\n')[0]?.slice(0, 100) || '—';
    const pillar  = draft.topicData?.pillarId || '—';
    const format  = draft.topicData?.format   || '—';
    const postedAt = new Date(draft.postedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });

    const msg =
      `📊 *24h stats — ${draft.clientId}*\n` +
      `_Posted: ${postedAt} IST_\n\n` +
      `*"${hook}..."*\n` +
      `Pillar: ${pillar} · Format: ${format}\n\n` +
      `❤️  Reactions : ${reactions}\n` +
      `💬  Comments  : ${comments}\n` +
      `🔁  Shares    : ${shares}\n` +
      `${engagementBar(total)}  *${total} total*`;

    await sendWhatsApp(msg);
    console.log(`✓ Stats sent for ${draft.clientId}: ${total} engagement`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
