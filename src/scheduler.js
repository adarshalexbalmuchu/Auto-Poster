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

function buildCronExpression(timeIST) {
  const [hours, minutes] = timeIST.split(':').map(Number);
  const istOffsetHours = 5;
  const istOffsetMinutes = 30;
  let utcHours = hours - istOffsetHours;
  let utcMinutes = minutes - istOffsetMinutes;
  if (utcMinutes < 0) { utcMinutes += 60; utcHours -= 1; }
  if (utcHours < 0) utcHours += 24;
  return `${utcMinutes} ${utcHours} * * 1-5`;
}

function scheduleClients() {
  const clients = getActiveClients();
  if (!clients.length) {
    log('No active clients to schedule.');
    return;
  }

  const scheduled = new Set();

  for (const client of clients) {
    const timeIST = client.postingSchedule?.timeIST || '09:00';
    const key = timeIST;

    if (scheduled.has(key)) continue;
    scheduled.add(key);

    const expr = buildCronExpression(timeIST);
    log(`Scheduling at ${timeIST} IST (cron: ${expr}) for ${clients.filter(c => c.postingSchedule?.timeIST === timeIST).map(c => c.id).join(', ')}`);

    cron.schedule(expr, () => {
      const currentClients = getActiveClients().filter(
        c => c.postingSchedule?.timeIST === timeIST
      );
      for (const c of currentClients) {
        runForClient(c);
      }
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
