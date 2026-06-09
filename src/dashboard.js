#!/usr/bin/env node
/**
 * dashboard.js — Local web dashboard for managing drafts
 *
 * Usage:
 *   npm run dashboard
 *   PORT=4000 npm run dashboard
 *
 * Routes:
 *   GET  /              → Dashboard UI
 *   GET  /api/drafts    → List all drafts
 *   GET  /api/drafts/:id → Get single draft
 *   PUT  /api/drafts/:id → Update draft text
 *   POST /api/drafts/:id/post → Post to LinkedIn
 *   DELETE /api/drafts/:id → Delete draft
 *   POST /api/generate  → Generate new draft
 *   GET  /api/clients   → List clients
 */

import 'dotenv/config';
import express from 'express';
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { generateForClient, saveDraft, recordTopic, loadClient } from './generate.js';
import { postDraft } from './post.js';

const PORT = parseInt(process.env.PORT || '3000');
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '';

const app = express();

app.use((req, res, next) => {
  const allowed = [
    'http://localhost:3000',
    'http://localhost:5173',
    ...(FRONTEND_URL ? [FRONTEND_URL] : []),
  ];
  const origin = req.headers.origin;
  if (!origin || allowed.includes(origin) || (origin && origin.endsWith('.github.io'))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Dashboard-Password');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static('./public'));

function auth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  const provided = req.headers['x-dashboard-password'];
  if (provided !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Clients ──────────────────────────────────────────────────────────────────

app.get('/api/clients', auth, (req, res) => {
  try {
    const files = readdirSync('./clients').filter(f => f.endsWith('.json') && !f.startsWith('_'));
    const clients = files.map(f => {
      try {
        const c = JSON.parse(readFileSync(`./clients/${f}`, 'utf8'));
        return {
          id: c.id,
          name: c.name,
          fullName: c.fullName,
          active: c.active,
          pillars: c.pillars.map(p => ({ id: p.id, label: p.label })),
          formats: c.formats,
          tokenValid: !!(c.linkedin?.accessToken && new Date(c.linkedin?.tokenExpiresAt) > new Date()),
          tokenExpiresAt: c.linkedin?.tokenExpiresAt || null,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
    res.json(clients);
  } catch {
    res.json([]);
  }
});

// ─── Drafts ───────────────────────────────────────────────────────────────────

function listDrafts() {
  try {
    return readdirSync('./drafts')
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => {
        try {
          return JSON.parse(readFileSync(`./drafts/${f}`, 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function draftPath(id) {
  return `./drafts/${id}.json`;
}

app.get('/api/drafts', auth, (req, res) => {
  const { status, client } = req.query;
  let drafts = listDrafts();
  if (status === 'pending') drafts = drafts.filter(d => !d.posted);
  if (status === 'posted') drafts = drafts.filter(d => d.posted);
  if (client) drafts = drafts.filter(d => d.clientId === client);
  res.json(drafts);
});

app.get('/api/drafts/:id', auth, (req, res) => {
  try {
    const draft = JSON.parse(readFileSync(draftPath(req.params.id), 'utf8'));
    res.json(draft);
  } catch {
    res.status(404).json({ error: 'Draft not found' });
  }
});

app.put('/api/drafts/:id', auth, (req, res) => {
  try {
    const path = draftPath(req.params.id);
    const draft = JSON.parse(readFileSync(path, 'utf8'));
    const { postText } = req.body;
    if (typeof postText === 'string') draft.postText = postText;
    writeFileSync(path, JSON.stringify(draft, null, 2));
    res.json(draft);
  } catch {
    res.status(404).json({ error: 'Draft not found' });
  }
});

app.delete('/api/drafts/:id', auth, (req, res) => {
  try {
    unlinkSync(draftPath(req.params.id));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Draft not found' });
  }
});

app.post('/api/drafts/:id/post', auth, async (req, res) => {
  const path = draftPath(req.params.id);
  try {
    const result = await postDraft(path);
    res.json({ ok: true, postId: result.postId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Generate ─────────────────────────────────────────────────────────────────

app.post('/api/generate', auth, async (req, res) => {
  const { clientId, pillarId, seed, format } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  try {
    const result = await generateForClient(clientId, { pillarId, seed, format });
    const { filename, draft } = saveDraft(clientId, result);
    recordTopic(clientId, result.topicData.topic);
    res.json({ ok: true, draftId: draft.id, draft });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nAuto-Poster Dashboard running at http://localhost:${PORT}`);
  if (DASHBOARD_PASSWORD) console.log('Password protection enabled.');
  console.log('Press Ctrl+C to stop.\n');
  try {
    import('open').then(({ default: open }) => open(`http://localhost:${PORT}`));
  } catch {}
});
