#!/usr/bin/env node
/**
 * generate.js — Claude picks a topic and writes a LinkedIn post for a client
 *
 * Usage:
 *   npm run generate -- --client alex
 *   npm run generate -- --client alex --pillar civic-tech
 *   npm run generate -- --client alex --seed "FloodReady Delhi launch"
 *   npm run generate -- --client alex --format carousel
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const anthropic = new Anthropic();

const MODEL = 'claude-opus-4-8';

// ─── Load client ──────────────────────────────────────────────────────────────

export function loadClient(clientId) {
  const path = `./clients/${clientId}.json`;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Client not found: ${path}`);
  }
}

// ─── Topic selection ──────────────────────────────────────────────────────────

function buildTopicPrompt(client, pillarId = null) {
  const pillars = pillarId
    ? client.pillars.filter(p => p.id === pillarId)
    : client.pillars;

  const recentList = client.recentTopics?.slice(-10).length
    ? `\nRecently posted (avoid repeating):\n${client.recentTopics.slice(-10).map(t => `- ${t}`).join('\n')}`
    : '';

  return `You are a content strategist for ${client.name}.

About ${client.name}:
${client.about}

Content pillars:
${pillars.map(p => `- ${p.label}: ${p.description}`).join('\n')}
${recentList}

Pick ONE specific, interesting topic for a LinkedIn post today.
Choose something timely, specific, and authentic — not generic advice.

Return ONLY valid JSON (no markdown, no explanation):
{
  "pillarId": "<pillar id>",
  "topic": "<one sentence describing the specific topic>",
  "angle": "<the specific hook or angle that makes this interesting>",
  "format": "<one of: text, list, story, notebook>"
}`;
}

// ─── Post writing ─────────────────────────────────────────────────────────────

function buildPostPrompt(client, topicData) {
  const pillar = client.pillars.find(p => p.id === topicData.pillarId) || client.pillars[0];
  const hashtags = pillar.hashtags.slice(0, 3).join(', ');

  const formatGuides = {
    text: 'A direct text post. 150–350 words. Paragraph-based, personal.',
    list: 'A numbered list post. Hook line, then 3–6 numbered points, then a close. 200–350 words.',
    story: 'A short first-person story. One scene. What happened, what it meant. 150–300 words.',
    notebook: 'A field-note style entry. Observational, earthy, specific. 150–350 words.',
  };

  const guide = formatGuides[topicData.format] || formatGuides.text;

  return `You are writing a LinkedIn post for ${client.name}.

${client.name}'s voice:
${client.voice}

Topic: ${topicData.topic}
Angle / hook: ${topicData.angle}
Format: ${guide}

Write the post exactly as it would appear on LinkedIn.
- No preamble. No "here's a post:". Just the post.
- Include 2–3 hashtags at the end on their own line (use some from: ${hashtags}).
- Leave a blank line between the body and the hashtags.
- Do NOT add any notes or explanation after.

Write now:`;
}

// ─── Carousel slide writing ───────────────────────────────────────────────────

function buildCarouselPrompt(client, topicData) {
  const pillar = client.pillars.find(p => p.id === topicData.pillarId) || client.pillars[0];
  const hashtags = pillar.hashtags.slice(0, 3).join(', ');

  return `You are writing a LinkedIn carousel (PDF document post) for ${client.name}.

${client.name}'s voice:
${client.voice}

Topic: ${topicData.topic}
Angle / hook: ${topicData.angle}

Create a 5-slide carousel. Each slide is one page of a PDF that LinkedIn shows as swipeable.

Return ONLY valid JSON (no markdown, no explanation):
{
  "title": "<carousel document title, max 60 chars>",
  "caption": "<the post caption text that accompanies the carousel, 100-250 words, in ${client.name}'s voice, with 2-3 hashtags from: ${hashtags}>",
  "slides": [
    {
      "id": 1,
      "headline": "<bold headline text for this slide, max 8 words>",
      "body": "<body text for this slide, 30-60 words>",
      "note": "<optional small footnote or stat, max 15 words, or null>"
    }
  ]
}

Slide structure:
- Slide 1: Hook / What this is about
- Slides 2-4: The substance (3 key points, lessons, or steps)
- Slide 5: Takeaway + soft CTA ("Save this", "What would you add?", etc.)

${client.name}'s voice must come through in the body text — grounded, specific, no fluff.`;
}

// ─── Main generation function ─────────────────────────────────────────────────

export async function generateForClient(clientId, opts = {}) {
  const client = loadClient(clientId);

  let topicData;

  if (opts.seed) {
    topicData = {
      pillarId: opts.pillarId || client.pillars[0].id,
      topic: opts.seed,
      angle: opts.seed,
      format: opts.format && opts.format !== 'carousel' ? opts.format : (client.formats[0] || 'text'),
    };
  } else {
    const topicMsg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: buildTopicPrompt(client, opts.pillarId) }],
    });

    const raw = topicMsg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    try {
      topicData = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      throw new Error(`Claude returned invalid JSON for topic selection:\n${raw}`);
    }
  }

  if (opts.format === 'carousel') {
    const carouselMsg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: buildCarouselPrompt(client, topicData) }],
    });

    const raw = carouselMsg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let carouselData;
    try {
      carouselData = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      throw new Error(`Claude returned invalid JSON for carousel:\n${raw}`);
    }

    return { client, topicData, postText: carouselData.caption, carouselData, type: 'carousel' };
  }

  const postMsg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildPostPrompt(client, topicData) }],
  });

  const postText = postMsg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  return { client, topicData, postText, type: 'text' };
}

// ─── Save draft ───────────────────────────────────────────────────────────────

export function saveDraft(clientId, result) {
  mkdirSync('./drafts', { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `./drafts/${timestamp}-${clientId}.json`;

  const draft = {
    id: `${timestamp}-${clientId}`,
    clientId,
    generatedAt: new Date().toISOString(),
    type: result.type || 'text',
    topicData: result.topicData,
    postText: result.postText,
    carouselData: result.carouselData || null,
    posted: false,
    postedAt: null,
    linkedInPostId: null,
  };

  writeFileSync(filename, JSON.stringify(draft, null, 2));
  return { filename, draft };
}

export function recordTopic(clientId, topic) {
  const path = `./clients/${clientId}.json`;
  const client = JSON.parse(readFileSync(path, 'utf8'));
  const recent = client.recentTopics || [];
  recent.push(topic);
  client.recentTopics = recent.slice(-20);
  writeFileSync(path, JSON.stringify(client, null, 2));
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let clientId = null, pillarId = null, seed = null, format = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client' && args[i + 1]) clientId = args[++i];
    if (args[i] === '--pillar' && args[i + 1]) pillarId = args[++i];
    if (args[i] === '--seed' && args[i + 1]) seed = args[++i];
    if (args[i] === '--format' && args[i + 1]) format = args[++i];
  }

  if (!clientId) {
    console.error('Usage: npm run generate -- --client <id> [--pillar <id>] [--seed "topic"] [--format carousel]');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }

  console.log(`\nGenerating ${format || 'text'} post for: ${clientId}`);
  if (pillarId) console.log(`Pillar: ${pillarId}`);
  if (seed) console.log(`Seed: "${seed}"`);
  console.log('');

  const result = await generateForClient(clientId, { pillarId, seed, format });

  console.log('─── Topic ───');
  console.log(`Pillar : ${result.topicData.pillarId}`);
  console.log(`Topic  : ${result.topicData.topic}`);
  console.log(`Angle  : ${result.topicData.angle}`);
  console.log(`Format : ${result.topicData.format}`);

  if (result.type === 'carousel' && result.carouselData) {
    console.log('\n─── Carousel Slides ───');
    result.carouselData.slides.forEach(s => {
      console.log(`\nSlide ${s.id}: ${s.headline}`);
      console.log(s.body);
      if (s.note) console.log(`  [${s.note}]`);
    });
    console.log('\n─── Caption ───\n');
  } else {
    console.log('\n─── Post ───\n');
  }

  console.log(result.postText);

  const { filename } = saveDraft(clientId, result);
  recordTopic(clientId, result.topicData.topic);
  console.log(`\n✓ Draft saved: ${filename}`);
}

if (process.argv[1]?.endsWith('generate.js')) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
