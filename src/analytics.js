#!/usr/bin/env node
/**
 * analytics.js — Pull engagement metrics for a client's LinkedIn posts
 *
 * Usage:
 *   npm run analytics -- --client irfan
 *   npm run analytics -- --client irfan --count 20
 *
 * What it pulls:  reactions, comments, shares per post (via LinkedIn API)
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

async function getProfile(token) {
  const res = await fetch(`${LINKEDIN_API_V2}/me`, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Profile fetch failed (${res.status})`);
  return res.json();
}

async function getRecentPosts(personUrn, token, count) {
  const authors = encodeURIComponent(`List(${personUrn})`);
  const res = await fetch(
    `${LINKEDIN_API_V2}/ugcPosts?q=authors&authors=${authors}&count=${count}&start=0`,
    { headers: authHeaders(token), signal: AbortSignal.timeout(15_000) }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Posts fetch failed (${res.status}): ${data?.message || JSON.stringify(data)}`);
  return data.elements || [];
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
      .filter(d => d?.posted && d?.linkedInPostId);
  } catch { return []; }
}

function numericId(urn) {
  const m = String(urn || '').match(/(\d+)$/);
  return m ? m[1] : urn;
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
    process.exit(1);
  }

  // Verify token + get person URN
  let profile;
  try {
    profile = await getProfile(token);
  } catch (e) {
    console.error(`Token check failed: ${e.message}`);
    process.exit(1);
  }

  const personUrn = `urn:li:person:${profile.id}`;
  console.log(`\n── LinkedIn Analytics: ${profile.localizedFirstName} ${profile.localizedLastName} ──\n`);

  // Load local drafts for topic/pillar context
  const draftMap = new Map(
    loadPostedDrafts(clientId).map(d => [numericId(d.linkedInPostId), d])
  );

  // Fetch posts from LinkedIn
  let posts;
  try {
    posts = await getRecentPosts(personUrn, token, count);
  } catch (e) {
    console.error(`Could not fetch posts: ${e.message}`);
    console.error('\nThis requires the r_member_social scope. Re-run: npm run auth -- --client', clientId);
    process.exit(1);
  }

  if (!posts.length) {
    console.log('No posts found on this account.');
    return;
  }

  console.log(`Last ${posts.length} posts — reactions / comments / shares\n`);
  console.log('─'.repeat(72));

  let totR = 0, totC = 0, totS = 0, scored = 0;

  for (const post of posts) {
    const urn     = post.id;
    const draft   = draftMap.get(numericId(urn));
    const date    = post.created?.time ? new Date(post.created.time).toISOString().slice(0, 10) : '?';
    const pillar  = draft?.topicData?.pillarId || null;
    const snippet = (
      post.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text ||
      post.commentary || ''
    ).replace(/\n/g, ' ').slice(0, 72);

    const actions  = await getSocialActions(urn, token);
    const reactions = actions?.numLikes   ?? null;
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
    console.log(`\nTotals (${posts.length} posts):`);
    console.log(`  Reactions : ${totR}`);
    console.log(`  Comments  : ${totC}`);
    console.log(`  Shares    : ${totS}`);
    console.log(`  Avg engagement per post: ${avgEng}`);
  }

  console.log(`\n⚠  Impressions are not available via LinkedIn's API for personal profiles.`);
  console.log(`   For impression data, use LinkedIn's native Creator Analytics tab.\n`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
