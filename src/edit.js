#!/usr/bin/env node
/**
 * edit.js — Apply a targeted edit instruction to an existing draft
 *
 * Usage:
 *   npm run edit -- --client alex --instruction "make it shorter"
 *   npm run edit -- --client alex --instruction "sharpen the hook" --draft ./drafts/2026-06-09T09-00-00-alex.json
 *
 * GitHub Actions passes inputs as INPUT_* env vars.
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { loadClient } from './generate.js';
import { sendDraftNotification } from './whatsapp.js';

const MODEL = 'claude-sonnet-4-6';

function findLatestDraft(clientId) {
  let files;
  try {
    files = readdirSync('./drafts');
  } catch {
    throw new Error('drafts/ directory not found — no draft to edit');
  }
  const candidates = files
    .filter(f => f.endsWith(`-${clientId}.json`) && f !== 'history.json')
    .sort()
    .reverse();
  for (const file of candidates) {
    const path = `./drafts/${file}`;
    try {
      const d = JSON.parse(readFileSync(path, 'utf8'));
      if (!d.posted) return path;
    } catch { /* skip corrupt files */ }
  }
  throw new Error(`No unposted draft found for: ${clientId}`);
}

async function main() {
  const args = process.argv.slice(2);
  let clientId    = process.env.INPUT_CLIENT       || null;
  let instruction = process.env.INPUT_INSTRUCTION  || null;
  let draftPath   = process.env.INPUT_DRAFT_PATH   || null;
  const phone     = process.env.INPUT_PHONE        || null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client'      && args[i + 1]) clientId    = args[++i];
    if (args[i] === '--instruction' && args[i + 1]) instruction = args[++i];
    if (args[i] === '--draft'       && args[i + 1]) draftPath   = args[++i];
  }

  if (!clientId) {
    console.error('Usage: npm run edit -- --client <id> --instruction "your edit"');
    process.exit(1);
  }
  if (!instruction) {
    console.error('--instruction is required');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY');
    process.exit(1);
  }

  if (!draftPath) draftPath = findLatestDraft(clientId);

  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  } catch {
    throw new Error(`Could not read draft: ${draftPath}`);
  }
  if (draft.posted) throw new Error('Draft already posted — cannot edit.');

  const client = loadClient(clientId);

  console.log(`\nEditing draft for: ${client.name}`);
  console.log(`Draft  : ${draftPath}`);
  console.log(`Edit   : "${instruction}"\n`);

  const anthropic = new Anthropic();
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content:
        `You are editing a LinkedIn post draft for ${client.name}.\n\n` +
        `VOICE AND STYLE RULES — must be preserved through the edit:\n${client.voice}\n\n` +
        `HARD RULES that must still hold after editing:\n` +
        `- Do NOT use em dashes (—). Use a period or a new sentence instead.\n` +
        `- Do NOT use bullet points or numbered lists of any kind.\n` +
        `- Do NOT use any of these words: delve, leverage, unlock, harness, cutting-edge, game-changer, seamlessly, transformative, revolutionize.\n` +
        `- Total post length (body + hashtags) MUST be under 2800 characters.\n` +
        `- No preamble. Return only the revised post text.\n\n` +
        `Apply ONLY this specific edit instruction — do not change anything else:\n${instruction}\n\n` +
        `Draft:\n${draft.postText}`,
    }],
  });

  const revisedText = msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  const updated = { ...draft, postText: revisedText, lastEditedAt: new Date().toISOString() };
  writeFileSync(draftPath, JSON.stringify(updated, null, 2));
  console.log('✓ Draft updated');

  console.log('\n─── Revised post ───\n');
  console.log(revisedText);

  try {
    await sendDraftNotification(
      { client, topicData: draft.topicData, postText: revisedText, type: draft.type, carouselData: draft.carouselData || null },
      draftPath
    );
    console.log('\n✓ WhatsApp notification sent');
  } catch (e) {
    console.warn(`WhatsApp notification skipped: ${e.message}`);
  }

  const workerUrl      = process.env.WORKER_URL;
  const callbackSecret = process.env.WORKER_CALLBACK_SECRET;
  if (workerUrl && callbackSecret && phone) {
    try {
      const res = await fetch(`${workerUrl}/callback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${callbackSecret}`,
          'Content-Type': 'application/json',
          'User-Agent': 'auto-poster-edit/1.0',
        },
        body: JSON.stringify({
          type: 'draft_ready',
          phone,
          client: clientId,
          pillar: draft.topicData?.pillarId || null,
          draftPath,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      console.log(res.ok ? '✓ Worker KV updated' : `Worker callback returned ${res.status}`);
    } catch (e) {
      console.warn(`Worker callback skipped: ${e.message}`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
