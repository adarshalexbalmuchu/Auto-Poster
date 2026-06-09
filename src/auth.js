#!/usr/bin/env node
/**
 * auth.js — One-time OAuth 2.0 flow to get a LinkedIn access token for a client
 *
 * Usage:
 *   npm run auth -- --client alex
 *
 * What it does:
 *   1. Opens a browser to LinkedIn's OAuth consent page
 *   2. Client approves access
 *   3. LinkedIn redirects to localhost:3000/callback with a code
 *   4. Exchanges code for access token + person URN
 *   5. Saves everything into clients/<id>.json
 *
 * Run once per client. Tokens last 60 days — re-run when expired.
 */

import 'dotenv/config';
import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PORT = parseInt(process.env.PORT || '3000');

function getCredentials(clientId) {
  const prefix = clientId.toUpperCase();
  return {
    clientId:     process.env[`${prefix}_LINKEDIN_CLIENT_ID`]     || process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env[`${prefix}_LINKEDIN_CLIENT_SECRET`] || process.env.LINKEDIN_CLIENT_SECRET,
    redirectUri:  process.env[`${prefix}_LINKEDIN_REDIRECT_URI`]  || process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:3000/callback',
  };
}

const SCOPES = ['openid', 'profile', 'w_member_social'].join(' ');

function parseArgs() {
  const args = process.argv.slice(2);
  let clientId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client' && args[i + 1]) clientId = args[++i];
  }
  return { clientId };
}

function loadClient(clientId) {
  const path = `./clients/${clientId}.json`;
  try {
    return { path, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    console.error(`Client file not found: ${path}`);
    process.exit(1);
  }
}

function saveTokenToEnv(clientId, tokenData, personUrn) {
  const prefix = clientId.toUpperCase();
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
  const vars = {
    [`${prefix}_LINKEDIN_ACCESS_TOKEN`]: tokenData.access_token,
    [`${prefix}_LINKEDIN_PERSON_URN`]: personUrn,
    [`${prefix}_LINKEDIN_TOKEN_EXPIRES_AT`]: expiresAt,
  };

  const envPath = './.env';
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content += `\n${line}`;
    }
  }

  writeFileSync(envPath, content);
  return expiresAt;
}

async function exchangeCode(code, { clientId, clientSecret, redirectUri }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Token exchange failed: ${data.error_description || JSON.stringify(data)}`);
  }
  return data;
}

async function getPersonUrn(accessToken) {
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Failed to get profile: ${JSON.stringify(data)}`);
  return `urn:li:person:${data.sub}`;
}

async function main() {
  const { clientId } = parseArgs();
  if (!clientId) {
    console.error('Usage: npm run auth -- --client <client-id>');
    console.error('Example: npm run auth -- --client alex');
    process.exit(1);
  }

  const creds = getCredentials(clientId);
  if (!creds.clientId || !creds.clientSecret) {
    const prefix = clientId.toUpperCase();
    console.error(`Missing LinkedIn credentials for client "${clientId}".`);
    console.error(`Add to .env: ${prefix}_LINKEDIN_CLIENT_ID and ${prefix}_LINKEDIN_CLIENT_SECRET`);
    console.error(`(or the generic LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET as fallback)`);
    process.exit(1);
  }

  const { path: clientPath, data: clientData } = loadClient(clientId);

  const state = Math.random().toString(36).slice(2);
  const authUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', creds.clientId);
  authUrl.searchParams.set('redirect_uri', creds.redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', SCOPES);

  console.log(`\nAuthorising LinkedIn for: ${clientData.name} (${clientId})`);
  console.log('\nOpen this URL in your browser:');
  console.log(`\n${authUrl.toString()}\n`);

  try {
    const { default: open } = await import('open');
    await open(authUrl.toString());
  } catch {
    console.log('(Could not auto-open browser — paste the URL above manually)');
  }

  const app = express();
  let server;

  await new Promise((resolve, reject) => {
    app.get('/callback', async (req, res) => {
      const { code, state: returnedState, error } = req.query;

      if (error) {
        res.send(`<h2>Auth failed: ${error}</h2><p>You can close this tab.</p>`);
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.send('<h2>State mismatch. Try again.</h2>');
        reject(new Error('State mismatch'));
        return;
      }

      try {
        res.send('<h2>Authorised! Saving token...</h2><p>You can close this tab.</p>');

        const tokenData = await exchangeCode(code, creds);
        const personUrn = await getPersonUrn(tokenData.access_token);

        const expiresAt = saveTokenToEnv(clientId, tokenData, personUrn);
        const prefix = clientId.toUpperCase();
        console.log(`\n✓ Token saved for ${clientData.name}`);
        console.log(`  Person URN : ${personUrn}`);
        console.log(`  Expires    : ${new Date(expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
        console.log(`  Saved to   : .env (${prefix}_LINKEDIN_ACCESS_TOKEN)`);
        console.log(`\nReady. Run: npm run run -- --client ${clientId}`);

        resolve();
      } catch (err) {
        reject(err);
      }
    });

    server = app.listen(PORT, () => {
      console.log(`Waiting for LinkedIn callback on ${creds.redirectUri} ...`);
    });
  });

  server.close();
}

main().catch(e => {
  console.error('\nAuth failed:', e.message);
  process.exit(1);
});
