#!/usr/bin/env node
/**
 * generate.js — Claude picks a topic and writes a LinkedIn post for a client
 *
 * Usage:
 *   npm run generate -- --client alex
 *   npm run generate -- --client alex --pillar civic-tech
 *   npm run generate -- --client alex --seed "FloodReady Delhi launch"
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { parseGenerateArgs, requireApiKey } from './cli-utils.js';

export const HISTORY_PATH = './drafts/history.json';

function readHistory(clientId) {
  if (!existsSync(HISTORY_PATH)) return [];
  const all = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
  return all.filter(r => r.client === clientId).slice(-10);
}

const anthropic = new Anthropic();

export const MODEL = 'claude-sonnet-4-6';
const TOPIC_MODEL = 'claude-haiku-4-5-20251001';

export const HARD_RULES =
  `- Do NOT use em dashes (—). Use a period or a new sentence instead.\n` +
  `- Do NOT use bullet points or numbered lists of any kind.\n` +
  `- Do NOT use any of these words: delve, leverage, unlock, harness, cutting-edge, game-changer, seamlessly, transformative, revolutionize, "it is worth noting", "in today's rapidly evolving landscape".\n` +
  `- ONE strong number maximum. Lead with the insight, use the number as proof.\n` +
  `- Total post length (body + hashtags) MUST be under 2800 characters. Target 150–200 words.\n` +
  `- Hashtags on their own lines at the very bottom, separated from the body by a blank line. Use 2–3 hashtags.\n` +
  `- No preamble. No "here's a post:". Just the post itself.`;

const ALLOWED_CLIENTS = new Set(['irfan', 'alex']);

function validateClientId(clientId) {
  if (!clientId || !ALLOWED_CLIENTS.has(clientId)) {
    throw new Error(`Unknown client: ${clientId}`);
  }
}

// ─── Load client ──────────────────────────────────────────────────────────────

export function loadClient(clientId) {
  validateClientId(clientId);
  const path = `./clients/${clientId}.json`;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Client not found: ${path}`);
  }
}

// ─── Pillar selection ─────────────────────────────────────────────────────────

function selectPillar(client) {
  const today = new Date();
  const eligible = client.pillars.filter(p => (p.frequency ?? 1) > 0);
  if (!eligible.length) return client.pillars[0];

  const scored = eligible.map(p => {
    const daysSince = p.last_posted
      ? Math.floor((today - new Date(p.last_posted)) / 86_400_000)
      : 999;
    return { pillar: p, score: daysSince * (p.frequency ?? 1) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].pillar;
}

export function updatePillarLastPosted(clientId, pillarId) {
  validateClientId(clientId);
  const path = `./clients/${clientId}.json`;
  const client = JSON.parse(readFileSync(path, 'utf8'));
  const pillar = client.pillars.find(p => p.id === pillarId);
  if (pillar) pillar.last_posted = new Date().toISOString().slice(0, 10);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(client, null, 2));
  renameSync(tmp, path);
}

// ─── URL context fetching ─────────────────────────────────────────────────────

export async function fetchUrlContext(url) {
  // Only allow HTTPS to avoid accidental local-network fetches.
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs are supported for context fetching');

  const res = await fetch(url, {
    headers: { 'User-Agent': 'auto-poster/1.0 (content research)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Failed to fetch source URL (${res.status}): ${url}`);

  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  // Safety cap at 50 000 chars — covers any realistic article or press release in full.
  return text.length > 50_000 ? text.slice(0, 50_000) + '…' : text;
}

// ─── Topic selection ──────────────────────────────────────────────────────────

function buildTopicPrompt(client, pillarId = null, contextText = null) {
  const pillars = pillarId
    ? client.pillars.filter(p => p.id === pillarId)
    : client.pillars;

  const recent = client.recentTopics?.slice(-10) || [];
  const recentList = recent.length
    ? `\nRecently posted (avoid repeating):\n${recent.map(t => `- ${t}`).join('\n')}`
    : '';

  const avoidList = client.avoidTopics?.length
    ? `\nTopics to avoid:\n${client.avoidTopics.map(t => `- ${t}`).join('\n')}`
    : '';

  const audienceNote = client.audienceNotes
    ? `\nAudience: ${client.audienceNotes}`
    : '';

  const history = readHistory(client.id);
  const historyBlock = history.length
    ? `\nDo not repeat a topic or opening hook style from these recent published posts:\n${history.map(r => `- [${r.date}] ${r.topic} | hook: "${r.hook}"`).join('\n')}`
    : '';

  const contextBlock = contextText
    ? `\nSOURCE MATERIAL — base the topic on the specific facts in this content:\n---\n${contextText}\n---\n`
    : '';

  return `You are a content strategist for ${client.name}.

About ${client.name}:
${client.about}
${audienceNote}

Content pillars (use the exact id value in your response):
${pillars.map(p => `- id: "${p.id}" | ${p.label}: ${p.description}`).join('\n')}
${recentList}${historyBlock}${avoidList}${contextBlock}
Pick ONE specific, interesting topic for a LinkedIn post today.
Choose something timely, specific, and authentic — not generic advice.

Return ONLY valid JSON (no markdown, no explanation):
{
  "pillarId": "<pillar id>",
  "topic": "<one sentence describing the specific topic>",
  "angle": "<the specific hook or angle that makes this interesting>",
  "format": "<one of: ${(client.formats || ['text', 'list', 'story']).join(', ')}>"
}`;
}

// ─── Post writing ─────────────────────────────────────────────────────────────

function getPillarHashtags(client, pillarId, max = 3) {
  const pillar = client.pillars.find(p => p.id === pillarId) || client.pillars[0];
  return pillar.hashtags.slice(0, max).join(', ');
}

const FORMAT_GUIDES = {
  text:     'Short punchy paragraphs — mix of 1-sentence punches and 2-3 sentence paragraphs. 150–200 words target.',
  list:     'NO bullet points or numbered lists. Use short punchy paragraphs, each point as its own thought. 150–200 words target.',
  story:    'A first-person scene. Open with where you were or what you saw. One moment, what it meant. 150–200 words target.',
  notebook: 'Field-note style. Observational, grounded, specific. Short paragraphs. 150–200 words target.',
};

// Returns { staticPart, dynamicPart } — static is cached across calls for the same client.
function buildPostPromptParts(client, topicData, contextText = null) {
  const hashtags = getPillarHashtags(client, topicData.pillarId);
  const guide = FORMAT_GUIDES[topicData.format] || FORMAT_GUIDES.text;

  const staticPart =
`You are writing a LinkedIn post for ${client.name}.

VOICE AND STYLE RULES — follow every one precisely:
${client.voice}

HARD RULES:
${HARD_RULES}
- LinkedIn's reach sweet spot is 900–1200 characters. Longer posts lose completion rate and algorithmic reach.

HOOK — the first 1–2 lines:
- Follow this client's voice rules for how to open. Do not override them.
- The hook must earn the scroll — make the reader want to keep reading.
- No generic openers like "In today's world" or "Something interesting happened".

TAGGING:
- When the post directly references a specific company, brand, or well-known person by name, write their name as @Name so it can be tagged on LinkedIn.
- Only tag entities that the post is actually talking about — never add tags just for reach.
- Place the @mention naturally where the name appears in the sentence, not as a list at the end.
- Maximum 2 tags per post. If more than 2 entities are mentioned, only tag the most central ones.
- NEVER use @Name's (possessive) — the apostrophe breaks the tag. Restructure instead: "Claude from @Anthropic" not "@Anthropic's Claude", "a deal with @TCS" not "@TCS's deal".

CLOSING:
- Follow this client's voice rules for how to close.
- End with a question that feels earned by the post — not tacked on.
- One sentence. Answerable in a comment.`;

  const contextBlock = contextText
    ? `SOURCE MATERIAL — ground every specific fact, number, and claim in this content:\n---\n${contextText}\n---\n\n`
    : '';

  const dynamicPart =
`${contextBlock}Topic: ${topicData.topic}
Angle / hook: ${topicData.angle}
Format guidance: ${guide}
Hashtags — use 2–3 from: ${hashtags}.

Write now:`;

  return { staticPart, dynamicPart };
}

// ─── Main generation function ─────────────────────────────────────────────────

export async function generateForClient(clientId, opts = {}) {
  const client = loadClient(clientId);

  let contextText = null;
  if (opts.url) {
    console.log(`Fetching source context from: ${opts.url}`);
    contextText = await fetchUrlContext(opts.url);
    console.log(`  Extracted ${contextText.length} chars`);
  }

  let topicData;

  const selectedPillarId = opts.pillarId || selectPillar(client).id;

  if (opts.seed) {
    topicData = {
      pillarId: selectedPillarId,
      topic: opts.seed,
      angle: opts.url
        ? 'Write from the specific facts and details in the source material provided.'
        : 'Write from the specific details and your honest reaction to this topic.',
      format: opts.format || (client.formats[0] || 'text'),
    };
  } else {
    const topicMsg = await anthropic.messages.create({
      model: TOPIC_MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: buildTopicPrompt(client, selectedPillarId, contextText) }],
    });

    const raw = topicMsg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Claude returned no JSON for topic selection:\n${raw}`);
    try {
      topicData = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error(`Claude returned invalid JSON for topic selection:\n${raw}`);
    }
  }

  const { staticPart, dynamicPart } = buildPostPromptParts(client, topicData, contextText);
  const postMsg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicPart },
      ],
    }],
  });

  const postText = postMsg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  return { client, topicData, postText, type: 'text', sourceUrl: opts.url || null };
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
    topicData: result.topicData,
    postText: result.postText,
    sourceUrl: result.sourceUrl || null,
    posted: false,
    postedAt: null,
    linkedInPostId: null,
  };

  writeFileSync(filename, JSON.stringify(draft, null, 2));
  return { filename, draft };
}

export function recordTopic(clientId, topic) {
  validateClientId(clientId);
  const path = `./clients/${clientId}.json`;
  const client = JSON.parse(readFileSync(path, 'utf8'));
  client.recentTopics = [...new Set([...(client.recentTopics || []), topic])].slice(-20);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(client, null, 2));
  renameSync(tmp, path);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const { clientId, pillarId, seed, format } = parseGenerateArgs(process.argv.slice(2));

  if (!clientId) {
    console.error('Usage: npm run generate -- --client <id> [--pillar <id>] [--seed "topic"] [--format text|list|story|notebook]');
    process.exit(1);
  }

  requireApiKey();

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

  console.log('\n─── Post ───\n');

  console.log(result.postText);

  const { filename } = saveDraft(clientId, result);
  recordTopic(clientId, result.topicData.topic);
  console.log(`\n✓ Draft saved: ${filename}`);
}

if (process.argv[1]?.endsWith('generate.js')) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
