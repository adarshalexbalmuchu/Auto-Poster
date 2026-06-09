#!/usr/bin/env node
/**
 * run.js — Full pipeline: generate a post and optionally post it immediately
 *
 * Usage:
 *   npm run run -- --client alex
 *   npm run run -- --client alex --post          (generate + post immediately)
 *   npm run run -- --client alex --pillar ai-tools
 *   npm run run -- --client alex --seed "FloodReady Delhi launch"
 *   npm run run -- --client alex --format carousel
 *   npm run run -- --client alex --format carousel --post
 */

import 'dotenv/config';
import { generateForClient, saveDraft, recordTopic } from './generate.js';
import { postDraft } from './post.js';
import { sendWhatsApp, formatDraftMessage } from './whatsapp.js';

async function main() {
  const args = process.argv.slice(2);
  let clientId = null, pillarId = null, seed = null, format = null;
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
  --format carousel  Generate a carousel instead of a text post
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

  if (result.type === 'carousel' && result.carouselData) {
    console.log(`\n─── Carousel: "${result.carouselData.title}" ───`);
    result.carouselData.slides.forEach(s => {
      console.log(`\n  [${s.id}] ${s.headline}`);
      console.log(`       ${s.body.slice(0, 80)}${s.body.length > 80 ? '...' : ''}`);
    });
    console.log('\n─── Caption ───\n');
  } else {
    console.log('\n─── Post ───\n');
  }

  console.log(result.postText);

  const { filename, draft } = saveDraft(clientId, result);
  recordTopic(clientId, result.topicData.topic);
  console.log(`\n✓ Draft saved: ${filename}`);

  if (!postImmediately && !dryRun) {
    try {
      await sendWhatsApp(formatDraftMessage(result, filename));
      console.log('✓ WhatsApp notification sent');
    } catch (e) {
      console.log(`  WhatsApp error: ${e.message}`);
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
    console.log('\nTo post this draft:');
    console.log(`  npm run post -- --draft ${filename}`);
    console.log('\nOr open the dashboard to review and post:');
    console.log('  npm run dashboard');
  }
}

main().catch(e => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
