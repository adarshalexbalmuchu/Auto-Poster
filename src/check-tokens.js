#!/usr/bin/env node
import 'dotenv/config';
import { loadLinkedInTokens } from './linkedin-tokens.js';
import { sendWhatsApp } from './whatsapp.js';

const CLIENTS = [
  { id: 'irfan', name: 'Irfan', envKey: 'IRFAN_LINKEDIN_TOKEN_EXPIRES_AT' },
  { id: 'alex',  name: 'Alex',  envKey: 'ALEX_LINKEDIN_TOKEN_EXPIRES_AT'  },
];

const WARNING_DAYS = 14;

async function main() {
  await loadLinkedInTokens();
  const now = Date.now();
  const warnings = [];

  for (const client of CLIENTS) {
    const expiresAt = process.env[client.envKey];
    if (!expiresAt) {
      warnings.push(
        `⚠️ *${client.name}* — token expiry date unknown.\n` +
        `Reply *renew ${client.id}* for a reconnect link to forward to ${client.name}.`
      );
      continue;
    }
    const daysLeft = Math.floor((new Date(expiresAt).getTime() - now) / 86_400_000);
    if (daysLeft <= WARNING_DAYS) {
      warnings.push(
        `⚠️ *${client.name}* LinkedIn token expires in *${daysLeft} day${daysLeft === 1 ? '' : 's'}* (${expiresAt.slice(0, 10)}).\n` +
        `Reply *renew ${client.id}* for a reconnect link to forward to ${client.name}.`
      );
    }
  }

  if (warnings.length) {
    await sendWhatsApp(`*LinkedIn Token Expiry Warning*\n\n${warnings.join('\n\n')}`);
    console.log('Warning sent via WhatsApp.');
  } else {
    console.log('All tokens valid — no warning needed.');
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
