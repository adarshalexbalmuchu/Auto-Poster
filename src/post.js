#!/usr/bin/env node
/**
 * post.js — Post a saved draft to LinkedIn
 *
 * Usage:
 *   npm run post -- --draft ./drafts/2026-01-15T09-00-00-alex.json
 *   npm run post -- --draft ./drafts/2026-01-15T09-00-00-alex.json --dry-run
 *   npm run post -- --client alex          (auto-finds the latest unposted draft for that client)
 *   npm run post                           (auto-finds the latest unposted draft for any client)
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { postText, postImage } from './linkedin.js';
import { loadClient, updatePillarLastPosted, HISTORY_PATH } from './generate.js';
import { sendWhatsApp } from './whatsapp.js';
import { findLatestDraft } from './drafts.js';

// An image attached via WhatsApp is stashed in the Worker's KV. The Worker
// passes its key through the workflow dispatch (INPUT_IMAGE_KEY); we fetch the
// bytes back here from the authenticated /media endpoint at post time.
async function fetchAttachedImage() {
  const key        = process.env.INPUT_IMAGE_KEY;
  const workerUrl  = process.env.WORKER_URL;
  const secret     = process.env.WORKER_CALLBACK_SECRET;
  if (!key || !workerUrl || !secret) return null;

  const res = await fetch(`${workerUrl}/media/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${secret}`, 'User-Agent': 'auto-poster/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) {
    console.warn('Attached image not found in Worker KV (expired?) — posting text only.');
    return null;
  }
  if (!res.ok) throw new Error(`Could not fetch attached image from Worker (${res.status})`);

  const mime = res.headers.get('content-type') || 'image/jpeg';
  const data = Buffer.from(await res.arrayBuffer());
  return { data, mime };
}

function appendHistory(draft) {
  const records = existsSync(HISTORY_PATH)
    ? JSON.parse(readFileSync(HISTORY_PATH, 'utf8'))
    : [];
  records.push({
    client: draft.clientId,
    pillar:  draft.topicData?.pillarId || '',
    topic:   draft.topicData?.topic    || '',
    hook:    draft.postText?.split('\n').find(l => l.trim()) || '',
    date:    new Date().toISOString().slice(0, 10),
  });
  const tmp = `${HISTORY_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, HISTORY_PATH);
}

export async function postDraft(draftPath, opts = {}) {
  const draft = opts.draft || (() => {
    try { return JSON.parse(readFileSync(draftPath, 'utf8')); }
    catch { throw new Error(`Could not read draft: ${draftPath}`); }
  })();

  if (draft.posted) {
    throw new Error(`Draft already posted at ${draft.postedAt}. LinkedIn post ID: ${draft.linkedInPostId}`);
  }

  const client = loadClient(draft.clientId);

  const image = opts.image !== undefined ? opts.image : await fetchAttachedImage();

  if (opts.dryRun) {
    console.log('\n[DRY RUN] Would post to LinkedIn:');
    console.log('─'.repeat(50));
    console.log(draft.postText);
    console.log('─'.repeat(50));
    if (image) console.log(`[with attached image: ${image.mime}, ${image.data.length} bytes]`);
    return { dryRun: true };
  }

  const result = image
    ? await postImage(client, draft.postText, image.data, image.mime)
    : await postText(client, draft.postText);

  markPosted(draftPath, draft, result.postId);
  appendHistory(draft);
  if (draft.topicData?.pillarId) {
    updatePillarLastPosted(draft.clientId, draft.topicData.pillarId);
  }
  return result;
}

function markPosted(draftPath, draft, postId) {
  const updated = {
    ...draft,
    posted: true,
    postedAt: new Date().toISOString(),
    linkedInPostId: postId,
  };
  const tmp = `${draftPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(updated, null, 2));
  renameSync(tmp, draftPath);
}

async function main() {
  const args = process.argv.slice(2);
  let draftPath = process.env.INPUT_DRAFT_PATH || null;
  let clientId  = process.env.INPUT_CLIENT || null;
  let dryRun    = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--draft'  && args[i + 1]) draftPath = args[++i];
    if (args[i] === '--client' && args[i + 1]) clientId  = args[++i];
    if (args[i] === '--dry-run') dryRun = true;
  }

  if (!draftPath) {
    try {
      draftPath = findLatestDraft(clientId);
    } catch (e) {
      console.error(e.message);
      console.error('Usage: npm run post -- --draft ./drafts/<file>.json [--dry-run]');
      process.exit(1);
    }
  }

  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  } catch {
    console.error(`Could not read draft: ${draftPath}`);
    process.exit(1);
  }

  console.log(`\nPosting to LinkedIn for: ${draft.clientId}`);
  console.log('─'.repeat(50));
  console.log(draft.postText);
  console.log('─'.repeat(50));

  try {
    const result = await postDraft(draftPath, { dryRun, draft });
    if (!dryRun) {
      console.log('\n✓ Posted successfully');
      if (result.postId) console.log(`  Post ID: ${result.postId}`);
    }
  } catch (e) {
    console.error(`\nFailed: ${e.message}`);
    try {
      await sendWhatsApp(`⚠️ Posting to LinkedIn failed (${draft.clientId}).\n\n${e.message}`);
    } catch (notifyErr) {
      console.error('  (could not send failure notification:', notifyErr.message + ')');
    }
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('post.js')) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
