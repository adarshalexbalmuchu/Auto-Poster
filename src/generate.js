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

export const HISTORY_PATH = './drafts/history.json';

function readHistory(clientId) {
  if (!existsSync(HISTORY_PATH)) return [];
  const all = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
  return all.filter(r => r.client === clientId).slice(-10);
}

const anthropic = new Anthropic();

export const MODEL = 'claude-sonnet-4-6';
const TOPIC_MODEL = 'claude-haiku-4-5-20251001';

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

// ─── Topic selection ──────────────────────────────────────────────────────────

function buildTopicPrompt(client, pillarId = null) {
  const pillars = pillarId
    ? client.pillars.filter(p => p.id === pillarId)
    : client.pillars;

  const recentList = client.recentTopics?.slice(-10).length
    ? `\nRecently posted (avoid repeating):\n${client.recentTopics.slice(-10).map(t => `- ${t}`).join('\n')}`
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

  return `You are a content strategist for ${client.name}.

About ${client.name}:
${client.about}
${audienceNote}

Content pillars (use the exact id value in your response):
${pillars.map(p => `- id: "${p.id}" | ${p.label}: ${p.description}`).join('\n')}
${recentList}${historyBlock}${avoidList}

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
function buildPostPromptParts(client, topicData) {
  const hashtags = getPillarHashtags(client, topicData.pillarId);
  const guide = FORMAT_GUIDES[topicData.format] || FORMAT_GUIDES.text;

  const staticPart =
`You are writing a LinkedIn post for ${client.name}.

VOICE AND STYLE RULES — follow every one precisely:
${client.voice}

HARD RULES:
- Do NOT use em dashes (—). Use a period or a new sentence instead.
- Do NOT use bullet points or numbered lists of any kind.
- Do NOT use any of these words: delve, leverage, unlock, harness, cutting-edge, game-changer, seamlessly, transformative, revolutionize, "it is worth noting", "in today's rapidly evolving landscape".
- ONE strong number maximum. Lead with the insight, use the number as proof.
- Total post length (body + hashtags) MUST be under 2800 characters. Target 150–200 words — LinkedIn's reach sweet spot is 900–1200 characters. Longer posts lose completion rate and algorithmic reach.
- Hashtags on their own lines at the very bottom, separated from the body by a blank line. Use 2–3 hashtags.
- No preamble. No "here's a post:". Just the post itself.

HOOK — the first 1–2 lines:
- Follow this client's voice rules for how to open. Do not override them.
- The hook must earn the scroll — make the reader want to keep reading.
- No generic openers like "In today's world" or "Something interesting happened".

TAGGING:
- When the post directly references a specific company, brand, or well-known person by name, write their name as @Name so it can be tagged on LinkedIn.
- Only tag entities that the post is actually talking about — never add tags just for reach.
- Place the @mention naturally where the name appears in the sentence, not as a list at the end.
- Maximum 2 tags per post. If more than 2 entities are mentioned, only tag the most central ones.

CLOSING:
- Follow this client's voice rules for how to close.
- End with a question that feels earned by the post — not tacked on.
- One sentence. Answerable in a comment.`;

  const dynamicPart =
`Topic: ${topicData.topic}
Angle / hook: ${topicData.angle}
Format guidance: ${guide}
Hashtags — use 2–3 from: ${hashtags}.

Write now:`;

  return { staticPart, dynamicPart };
}

// ─── Main generation function ─────────────────────────────────────────────────

export async function generateForClient(clientId, opts = {}) {
  const client = loadClient(clientId);

  let topicData;

  const selectedPillarId = opts.pillarId || selectPillar(client).id;

  if (opts.seed) {
    topicData = {
      pillarId: selectedPillarId,
      topic: opts.seed,
      angle: opts.seed,
      format: opts.format || (client.formats[0] || 'text'),
    };
  } else {
    const topicMsg = await anthropic.messages.create({
      model: TOPIC_MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: buildTopicPrompt(client, selectedPillarId) }],
    });

    const raw = topicMsg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    try {
      topicData = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      throw new Error(`Claude returned invalid JSON for topic selection:\n${raw}`);
    }
  }

  const { staticPart, dynamicPart } = buildPostPromptParts(client, topicData);
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
    topicData: result.topicData,
    postText: result.postText,
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
  const args = process.argv.slice(2);
  let clientId = null, pillarId = null, seed = null, format = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client' && args[i + 1]) clientId = args[++i];
    if (args[i] === '--pillar' && args[i + 1]) pillarId = args[++i];
    if (args[i] === '--seed' && args[i + 1]) seed = args[++i];
    if (args[i] === '--format' && args[i + 1]) format = args[++i];
  }

  if (!clientId) {
    console.error('Usage: npm run generate -- --client <id> [--pillar <id>] [--seed "topic"] [--format text|list|story|notebook]');
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

  console.log('\n─── Post ───\n');

  console.log(result.postText);

  const { filename } = saveDraft(clientId, result);
  recordTopic(clientId, result.topicData.topic);
  console.log(`\n✓ Draft saved: ${filename}`);
}

if (process.argv[1]?.endsWith('generate.js')) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
