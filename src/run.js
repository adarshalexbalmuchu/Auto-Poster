#!/usr/bin/env node
/**
 * run.js — Full pipeline: generate a post and optionally post it immediately
 *
 * Usage:
 *   npm run run -- --client alex
 *   npm run run -- --client alex --post          (generate + post immediately)
 *   npm run run -- --client alex --pillar ai-tools
 *   npm run run -- --client alex --seed "FloodReady Delhi launch"
 */

import 'dotenv/config';
import { generateForClient, saveDraft, recordTopic } from './generate.js';
import { postDraft } from './post.js';
import { sendDraftNotification } from './whatsapp.js';
import { parseGenerateArgs, requireApiKey } from './cli-utils.js';

function parseRunArgs() {
  const args = process.argv.slice(2);
  // GitHub Actions passes inputs as INPUT_* env vars; CLI args take priority.
  const base = parseGenerateArgs(args, {
    clientId: process.env.INPUT_CLIENT || null,
    pillarId: process.env.INPUT_PILLAR || null,
    seed:     process.env.INPUT_SEED   || null,
    format:   process.env.INPUT_FORMAT || null,
  });
  let postImmediately = false, dryRun = false;
  for (const arg of args) {
    if (arg === '--post') postImmediately = true;
    if (arg === '--dry-run') dryRun = true;
  }
  return { ...base, postImmediately, dryRun };
}

async function generateAndSave({ clientId, pillarId, seed, format }) {
  const result = await generateForClient(clientId, { pillarId, seed, format });
  console.log('─── Topic ───');
  console.log(`Pillar  : ${result.topicData.pillarId}`);
  console.log(`Topic   : ${result.topicData.topic}`);
  console.log(`Angle   : ${result.topicData.angle}`);
  console.log('\n─── Post ───\n');
  console.log(result.postText);
  const { filename } = saveDraft(clientId, result);
  recordTopic(clientId, result.topicData.topic);
  console.log(`\n✓ Draft saved: ${filename}`);
  return { result, filename };
}

async function notifyAndCallback(result, filename, clientId) {
  try {
    await sendDraftNotification(result, filename);
    console.log('✓ WhatsApp notification sent');
  } catch (e) {
    console.log(`  WhatsApp error: ${e.message}`);
  }
  const workerUrl      = process.env.WORKER_URL;
  const callbackSecret = process.env.WORKER_CALLBACK_SECRET;
  const phone          = process.env.INPUT_PHONE;
  if (workerUrl && callbackSecret && phone) {
    try {
      const res = await fetch(`${workerUrl}/callback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${callbackSecret}`,
          'Content-Type': 'application/json',
          'User-Agent': 'auto-poster-worker/1.0',
        },
        body: JSON.stringify({
          type: 'draft_ready',
          phone,
          client: clientId,
          pillar: result.topicData.pillarId,
          draftPath: filename,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        console.log('✓ Worker KV updated');
      } else {
        const body = await res.text().catch(() => '');
        console.warn(`Worker callback failed (${res.status}): ${body}`);
      }
    } catch (e) {
      console.warn(`Worker callback skipped: ${e.message}`);
    }
  }
}

async function postIfRequested(filename, { postImmediately, dryRun }) {
  if (!postImmediately && !dryRun) {
    console.log('\nTo post this draft manually:');
    console.log(`  npm run post -- --draft ${filename}`);
    return;
  }
  console.log(dryRun ? '\n[Dry run mode]' : '\nPosting to LinkedIn...');
  try {
    const posted = await postDraft(filename, { dryRun });
    if (!dryRun) {
      console.log('✓ Posted successfully');
      if (posted.postId) console.log(`  Post ID: ${posted.postId}`);
    }
  } catch (e) {
    console.error(`\nPost failed: ${e.message}`);
    console.error(`Draft saved at ${filename} — you can post it later with:`);
    console.error(`  npm run post -- --draft ${filename}`);
    process.exit(1);
  }
}

async function main() {
  const opts = parseRunArgs();

  if (!opts.clientId) {
    console.error(`Usage: npm run run -- --client <id> [options]

Options:
  --client <id>      Client to generate for (e.g. alex)
  --pillar <id>      Lock to a specific pillar
  --seed "text"      Provide the topic manually (Claude still writes the post)
  --post             Post to LinkedIn immediately after generating
  --dry-run          Show what would be posted without actually posting
`);
    process.exit(1);
  }

  requireApiKey();

  console.log(`\n[Auto-Poster] Generating for: ${opts.clientId}`);
  if (opts.format)  console.log(`Format: ${opts.format}`);
  if (opts.pillarId) console.log(`Pillar: ${opts.pillarId}`);
  if (opts.seed)    console.log(`Seed: "${opts.seed}"`);
  console.log('');

  const { result, filename } = await generateAndSave(opts);

  if (!opts.postImmediately && !opts.dryRun) {
    await notifyAndCallback(result, filename, opts.clientId);
  }

  await postIfRequested(filename, opts);
}

main().catch(e => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
