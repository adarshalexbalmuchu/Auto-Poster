#!/usr/bin/env node
/**
 * scheduler.js — Cron-based auto-scheduler
 *
 * Runs the pipeline on each posting day at the client's configured time.
 * By default: generates a draft and saves it (does NOT auto-post).
 * Set AUTO_POST=true in .env to post immediately.
 *
 * Usage:
 *   npm run schedule
 *   AUTO_POST=true npm run schedule
 *
 * Keeps running indefinitely — use PM2, systemd, or a cron entry to manage the process.
 */

import 'dotenv/config';
import cron from 'node-cron';
import { readdirSync } from 'node:fs';
import { generateForClient, saveDraft, recordTopic, loadClient } from './generate.js';
import { postDraft } from './post.js';

const AUTO_POST = process.env.AUTO_POST === 'true';

function getActiveClients() {
  try {
    return readdirSync('./clients')
      .filter(f => f.endsWith('.json') && !f.startsWith('_'))
      .map(f => {
        try {
          return loadClient(f.replace('.json', ''));
        } catch {
          return null;
        }
      })
      .filter(c => c?.active);
  } catch {
    return [];
  }
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function runForClient(client) {
  log(`Generating post for: ${client.id} (${client.name})`);
  try {
    const result = await generateForClient(client.id);
    const { filename } = saveDraft(client.id, result);
    recordTopic(client.id, result.topicData.topic);

    log(`Draft saved: ${filename}`);
    log(`Topic: ${result.topicData.topic}`);

    if (AUTO_POST) {
      log('AUTO_POST=true — posting to LinkedIn...');
      const posted = await postDraft(filename);
      log(`Posted successfully. Post ID: ${posted.postId || 'n/a'}`);
    } else {
      log(`AUTO_POST not set — draft ready for review.`);
      log(`Post manually: npm run post -- --draft ${filename}`);
    }
  } catch (e) {
    log(`ERROR for ${client.id}: ${e.message}`);
  }
}

async function runAllClients() {
  const clients = getActiveClients();
  if (!clients.length) {
    log('No active clients found in ./clients/');
    return;
  }

  log(`Running for ${clients.length} active client(s)...`);
  for (const client of clients) {
    await runForClient(client);
  }
  log('Done.');
}

const TZ_OFFSETS = {
  'Asia/Kolkata':   { h: 5,  m: 30 },
  'Europe/London':  { h: 1,  m: 0  },  // BST (summer); GMT offset handled by node-cron timezone
  'America/New_York': { h: -4, m: 0 },
  'Asia/Singapore': { h: 8,  m: 0  },
};

function buildCronExpression(timeStr, timezone = 'Asia/Kolkata') {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const offset = TZ_OFFSETS[timezone] || TZ_OFFSETS['Asia/Kolkata'];
  let utcHours   = hours   - offset.h;
  let utcMinutes = minutes - offset.m;
  if (utcMinutes < 0) { utcMinutes += 60; utcHours -= 1; }
  if (utcHours < 0)  utcHours += 24;
  if (utcHours >= 24) utcHours -= 24;
  return `${utcMinutes} ${utcHours} * * *`;
}

function scheduleClients() {
  const clients = getActiveClients();
  if (!clients.length) {
    log('No active clients to schedule.');
    return;
  }

  const scheduled = new Set();

  for (const client of clients) {
    const schedule  = client.postingSchedule || {};
    const timeStr   = schedule.timeUK || schedule.timeIST || '09:00';
    const timezone  = schedule.timezone || 'Asia/Kolkata';
    const key       = `${timeStr}-${timezone}`;

    if (scheduled.has(key)) continue;
    scheduled.add(key);

    const expr = buildCronExpression(timeStr, timezone);
    const matchClients = clients.filter(c => {
      const s = c.postingSchedule || {};
      return (s.timeUK || s.timeIST || '09:00') === timeStr && (s.timezone || 'Asia/Kolkata') === timezone;
    });
    log(`Scheduling at ${timeStr} ${timezone} (cron: ${expr}) for: ${matchClients.map(c => c.id).join(', ')}`);

    cron.schedule(expr, () => {
      const today = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: timezone });
      const current = getActiveClients().filter(c => {
        const s = c.postingSchedule || {};
        const t = s.timeUK || s.timeIST || '09:00';
        const tz = s.timezone || 'Asia/Kolkata';
        const days = s.days || ['Monday','Tuesday','Wednesday','Thursday','Friday'];
        return t === timeStr && tz === timezone && days.includes(today);
      });
      for (const c of current) runForClient(c);
    }, { timezone: 'UTC' });
  }

  log(`Scheduler running. ${scheduled.size} time slot(s) registered.`);
  log(`AUTO_POST=${AUTO_POST}`);
  log('Press Ctrl+C to stop.\n');
}

const args = process.argv.slice(2);

if (args.includes('--run-now')) {
  log('--run-now: firing all clients immediately...');
  runAllClients().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
} else {
  if (!process.env.ANTHROPIC_API_KEY) {
    log('Missing ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }
  scheduleClients();
}
