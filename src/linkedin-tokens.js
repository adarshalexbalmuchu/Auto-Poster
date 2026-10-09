/**
 * linkedin-tokens.js — Pull LinkedIn tokens renewed over WhatsApp from the Worker
 *
 * When a client reconnects via "renew <client>" on WhatsApp, the Worker stores
 * the new token itself (see "LinkedIn token renewal" in worker/index.js).
 * Call loadLinkedInTokens() at the start of any script that talks to LinkedIn:
 * it overwrites <CLIENT>_LINKEDIN_ACCESS_TOKEN / _PERSON_URN / _TOKEN_EXPIRES_AT
 * in process.env with the Worker's copy whenever one exists and hasn't expired,
 * so envKey() in linkedin.js picks it up with no other changes.
 *
 * Falls back silently to the existing env/GitHub Secrets values if the Worker
 * isn't configured, has no token for a client, or can't be reached.
 */

import { readdirSync } from 'node:fs';

function clientIds() {
  try {
    return readdirSync('./clients')
      .filter(f => f.endsWith('.json') && f !== 'mentions.json')
      .map(f => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export async function loadLinkedInTokens() {
  const workerUrl = process.env.WORKER_URL;
  const secret    = process.env.WORKER_CALLBACK_SECRET;
  if (!workerUrl || !secret) return;

  await Promise.all(clientIds().map(async clientId => {
    try {
      const res = await fetch(`${workerUrl}/linkedin-token/${clientId}`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const token = await res.json();
      if (!token.accessToken || !token.personUrn) return;
      if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) return;

      const prefix = `${clientId.toUpperCase()}_LINKEDIN`;
      process.env[`${prefix}_ACCESS_TOKEN`] = token.accessToken;
      process.env[`${prefix}_PERSON_URN`]   = token.personUrn;
      if (token.expiresAt) process.env[`${prefix}_TOKEN_EXPIRES_AT`] = token.expiresAt;
    } catch (e) {
      console.warn(`[linkedin-tokens] Could not load ${clientId} token from Worker (${e.message}) — using env value`);
    }
  }));
}
