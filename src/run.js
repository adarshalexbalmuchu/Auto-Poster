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

async function main() {
  const args = process.argv.slice(2);
  // GitHub Actions passes inputs as INPUT_* env vars to avoid shell injection.
  // CLI args take priority when running locally.
  let clientId = process.env.INPUT_CLIENT || null;
  let pillarId = process.env.INPUT_PILLAR || null;
  let seed     = process.env.INPUT_SEED   || null;
  let format   = process.env.INPUT_FORMAT || null;
  let postImmediately = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client' && args[i + 1]) clientId = args[++i];
    if (args[i] === '--pillar' && args[i + 1]) pillarId = args[++i];
    if (args[i] === '--seed' && args[i + 1]) seed = args[++i];
    if (args[i] === '--format' && args[i + 1]) format = args[++i];
    if (args[i] === '--post') postImmediately = true;
    if (args[i] === '--dry-run') dryRun = true;
  }

  if (!clientId) {
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

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }

  console.log(`\n[Auto-Poster] Generating for: ${clientId}`);
  if (format) console.log(`Format: ${format}`);
  if (pillarId) console.log(`Pillar: ${pillarId}`);
  if (seed) console.log(`Seed: "${seed}"`);
  console.log('');

  const result = await generateForClient(clientId, { pillarId, seed, format });

  console.log('─── Topic ───');
  console.log(`Pillar  : ${result.topicData.pillarId}`);
  console.log(`Topic   : ${result.topicData.topic}`);
  console.log(`Angle   : ${result.topicData.angle}`);

  console.log('\n─── Post ───\n');

  console.log(result.postText);

  const { filename, draft } = saveDraft(clientId, result);
  recordTopic(clientId, result.topicData.topic);
  console.log(`\n✓ Draft saved: ${filename}`);

  if (!postImmediately && !dryRun) {
    try {
      await sendDraftNotification(result, filename);
      console.log('✓ WhatsApp notification sent');
    } catch (e) {
      console.log(`  WhatsApp error: ${e.message}`);
    }

    // Callback to Worker → transition KV state to pending_review with draft path.
    // Only fires when triggered by the WhatsApp bot (WORKER_URL + secret + phone all set).
    const workerUrl      = process.env.WORKER_URL;
    const callbackSecret = process.env.WORKER_CALLBACK_SECRET;
    const phone          = process.env.INPUT_PHONE;
    if (workerUrl && callbackSecret && phone) {
      try {
        await fetch(`${workerUrl}/callback`, {
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
        console.log('✓ Worker KV updated');
      } catch (e) {
        console.warn(`Worker callback skipped: ${e.message}`);
      }
    }
  }

  if (postImmediately || dryRun) {
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
  } else {
    console.log('\nTo post this draft manually:');
    console.log(`  npm run post -- --draft ${filename}`);
  }
}

main().catch(e => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
