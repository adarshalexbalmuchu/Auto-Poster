#!/usr/bin/env node
/**
 * post.js — Post a saved draft to LinkedIn
 *
 * Usage:
 *   npm run post -- --draft ./drafts/2026-01-15T09-00-00-alex.json
 *   npm run post -- --draft ./drafts/2026-01-15T09-00-00-alex.json --dry-run
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { postText, postWithImage, uploadAndPostDocument } from './linkedin.js';
import { loadClient } from './generate.js';
import { buildCarouselPdf } from './carousel.js';

const HISTORY_PATH = './drafts/history.json';

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
  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  } catch {
    throw new Error(`Could not read draft: ${draftPath}`);
  }

  if (draft.posted) {
    throw new Error(`Draft already posted at ${draft.postedAt}. LinkedIn post ID: ${draft.linkedInPostId}`);
  }

  const client = loadClient(draft.clientId);

  if (opts.dryRun) {
    console.log('\n[DRY RUN] Would post to LinkedIn:');
    console.log('─'.repeat(50));
    console.log(draft.postText);
    console.log('─'.repeat(50));
    console.log(`Type: ${draft.type}`);
    if (draft.type === 'carousel' && draft.carouselData) {
      console.log(`Carousel: "${draft.carouselData.title}" (${draft.carouselData.slides.length} slides)`);
    }
    return { dryRun: true };
  }

  let result;

  if (draft.type === 'carousel' && draft.carouselData) {
    console.log(`Building carousel PDF (${draft.carouselData.slides.length} slides)...`);
    const pdfBytes = await buildCarouselPdf(draft.carouselData, client.name);

    console.log(`Uploading PDF carousel to LinkedIn...`);
    result = await uploadAndPostDocument(
      client,
      draft.postText,
      Buffer.from(pdfBytes),
      draft.carouselData.title
    );
  } else {
    result = await postText(client, draft.postText);
  }

  markPosted(draftPath, draft, result.postId);
  appendHistory(draft);
  return result;
}

export function markPosted(draftPath, draft, postId) {
  const updated = {
    ...draft,
    posted: true,
    postedAt: new Date().toISOString(),
    linkedInPostId: postId,
  };
  writeFileSync(draftPath, JSON.stringify(updated, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  let draftPath = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--draft' && args[i + 1]) draftPath = args[++i];
    if (args[i] === '--dry-run') dryRun = true;
  }

  if (!draftPath) {
    console.error('Usage: npm run post -- --draft ./drafts/<file>.json [--dry-run]');
    process.exit(1);
  }

  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  } catch {
    console.error(`Could not read draft: ${draftPath}`);
    process.exit(1);
  }

  console.log(`\nPosting to LinkedIn for: ${draft.clientId}`);
  if (draft.type === 'carousel') console.log(`Type: carousel (${draft.carouselData?.slides?.length || 0} slides)`);
  console.log('─'.repeat(50));
  console.log(draft.postText);
  console.log('─'.repeat(50));

  try {
    const result = await postDraft(draftPath, { dryRun });
    if (!dryRun) {
      console.log('\n✓ Posted successfully');
      if (result.postId) console.log(`  Post ID: ${result.postId}`);
    }
  } catch (e) {
    console.error(`\nFailed: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('post.js')) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
