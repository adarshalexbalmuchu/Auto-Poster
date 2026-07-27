#!/usr/bin/env node
/**
 * analytics.js — Pull engagement metrics for a client's LinkedIn posts
 *
 * Usage:
 *   npm run analytics -- --client irfan
 *   npm run analytics -- --client irfan --count 20
 *
 * What it pulls:  reactions, comments, shares per post (via LinkedIn socialActions API),
 *                 for posts published by this repo (tracked in drafts/*.json).
 * What it can't:  impressions — not exposed for personal profiles via API.
 *                 Use LinkedIn's native Creator Analytics for impression data.
 */

import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { envKey } from './linkedin.js';

const LINKEDIN_API_V2 = 'https://api.linkedin.com/v2';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Restli-Protocol-Version': '2.0.0',
  };
}

async function getSocialActions(postUrn, token) {
  const res = await fetch(
    `${LINKEDIN_API_V2}/socialActions/${encodeURIComponent(postUrn)}`,
    { headers: authHeaders(token), signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function loadPostedDrafts(clientId) {
  try {
    return readdirSync('./drafts')
      .filter(f => f.endsWith(`-${clientId}.json`) && f !== 'history.json')
      .map(f => { try { return JSON.parse(readFileSync(`./drafts/${f}`, 'utf8')); } catch { return null; } })
      .filter(d => d?.posted && d?.linkedInPostId)
      .sort((a, b) => (a.postedAt || '').localeCompare(b.postedAt || ''));
  } catch { return []; }
}

function fmt(n) { return typeof n === 'number' ? String(n) : '—'; }

async function main() {
  const args = process.argv.slice(2);
  let clientId = null, count = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client' && args[i + 1]) clientId = args[++i];
    if (args[i] === '--count'  && args[i + 1]) count = parseInt(args[++i], 10);
  }

  if (!clientId) {
    console.error('Usage: npm run analytics -- --client <id> [--count N]');
    process.exit(1);
  }

  const token = envKey(clientId, 'ACCESS_TOKEN');
  if (!token) {
    console.error(`Missing LinkedIn access token for client: ${clientId}`);
    console.error(`Run: npm run auth -- --client ${clientId}`);
    process.exit(1);
  }

  const drafts = loadPostedDrafts(clientId).slice(-count);
  if (!drafts.length) {
    console.log(`No posted drafts found for ${clientId} in ./drafts/`);
    return;
  }

  console.log(`\n── LinkedIn Analytics: ${clientId} ──`);
  console.log(`Last ${drafts.length} posts published by Auto-Poster — reactions / comments / shares\n`);
  console.log('─'.repeat(72));

  // Fetch all social action counts in parallel instead of sequentially.
  const allActions = await Promise.allSettled(
    drafts.map(d => getSocialActions(d.linkedInPostId, token))
  );

  let totR = 0, totC = 0, totS = 0, scored = 0;

  for (let i = 0; i < drafts.length; i++) {
    const draft   = drafts[i];
    const date    = draft.postedAt?.slice(0, 10) || '?';
    const pillar  = draft.topicData?.pillarId || null;
    const snippet = (draft.postText || '').replace(/\n/g, ' ').slice(0, 72);

    const actions   = allActions[i].status === 'fulfilled' ? allActions[i].value : null;
    const reactions = actions?.numLikes    ?? null;
    const comments  = actions?.numComments ?? null;
    const shares    = actions?.numShares   ?? null;

    if (reactions !== null) { totR += reactions; scored++; }
    if (comments  !== null)   totC += comments;
    if (shares    !== null)   totS += shares;

    const engagement = (reactions !== null && comments !== null)
      ? ` | engagement: ${reactions + comments + (shares || 0)}`
      : '';

    console.log(`\n${date}${pillar ? `  [${pillar}]` : ''}${engagement}`);
    console.log(`"${snippet}${snippet.length === 72 ? '…' : ''}"`);
    console.log(`  Reactions: ${fmt(reactions)}   Comments: ${fmt(comments)}   Shares: ${fmt(shares)}`);
  }

  console.log('\n' + '─'.repeat(72));
  if (scored > 0) {
    const avgEng = ((totR + totC + totS) / scored).toFixed(1);
    console.log(`\nTotals (${drafts.length} posts):`);
    console.log(`  Reactions : ${totR}`);
    console.log(`  Comments  : ${totC}`);
    console.log(`  Shares    : ${totS}`);
    console.log(`  Avg engagement per post: ${avgEng}`);
  }

  console.log(`\n⚠  Impressions are not available via LinkedIn's API for personal profiles.`);
  console.log(`   For impression data, use LinkedIn's native Creator Analytics tab.\n`);
}

// ─── Exportable summary for generation feedback ──────────────────────────────

export async function getEngagementSummary(clientId, limit = 10) {
  const token = envKey(clientId, 'ACCESS_TOKEN');
  if (!token) return null;

  const drafts = loadPostedDrafts(clientId).slice(-limit);
  if (!drafts.length) return null;

  const results = await Promise.allSettled(
    drafts.map(d => getSocialActions(d.linkedInPostId, token))
  );

  return drafts
    .map((d, i) => {
      const a = results[i].status === 'fulfilled' ? results[i].value : null;
      if (!a) return null;
      return {
        date:      d.postedAt?.slice(0, 10) || d.generatedAt?.slice(0, 10) || '?',
        topic:     d.topicData?.topic || '',
        format:    d.topicData?.format || 'text',
        pillarId:  d.topicData?.pillarId || '',
        hook:      d.postText?.split('\n')[0]?.slice(0, 80) || '',
        engagement: (a.numLikes || 0) + (a.numComments || 0) + (a.numShares || 0),
      };
    })
    .filter(Boolean);
}

export { getSocialActions };

if (process.argv[1]?.endsWith('analytics.js')) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
