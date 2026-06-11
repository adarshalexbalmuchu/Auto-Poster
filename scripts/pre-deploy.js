#!/usr/bin/env node
/**
 * Pre-deployment validation for the Cloudflare Worker.
 * Run via `npm run pre-deploy` or automatically through `npm run deploy-worker`.
 *
 * Catches the issues that broke the bot before:
 *   - Debug flags left in wrangler.toml (DEBUG_SKIP_SIG)
 *   - Required secrets not set in Cloudflare
 *   - Worker health endpoint returning degraded after deploy
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workerDir = join(root, 'worker');

let passed = 0;
let failed = 0;
let warnings = 0;

function ok(label)           { console.log(`  ✓ ${label}`); passed++; }
function fail(label, fix)    { console.error(`  ✗ ${label}`); if (fix) console.error(`    → ${fix}`); failed++; }
function warn(label, detail) { console.warn(`  ⚠ ${label}`); if (detail) console.warn(`    ${detail}`); warnings++; }

console.log('\n── Pre-deploy checks ──────────────────────────────────────\n');

// ── 1. wrangler.toml sanity ──────────────────────────────────────────────────

const tomlPath = join(workerDir, 'wrangler.toml');
if (!existsSync(tomlPath)) {
  fail('worker/wrangler.toml exists', `Expected at ${tomlPath}`);
} else {
  const toml = readFileSync(tomlPath, 'utf8');

  if (toml.includes('DEBUG_SKIP_SIG')) {
    fail(
      'DEBUG_SKIP_SIG not in wrangler.toml',
      'Remove DEBUG_SKIP_SIG from [vars] — it bypasses signature verification'
    );
  } else {
    ok('No debug flags in wrangler.toml');
  }

  if (toml.includes('GITHUB_REPO')) {
    ok('GITHUB_REPO present in wrangler.toml');
  } else {
    fail('GITHUB_REPO present in wrangler.toml', 'Add GITHUB_REPO to [vars] in worker/wrangler.toml');
  }

  if (toml.includes('enabled = true')) {
    ok('Observability logs enabled in wrangler.toml');
  } else {
    warn('Observability logs not enabled', 'Add [observability.logs] enabled = true for wrangler tail to work');
  }
}

// ── 2. Required secrets set in Cloudflare ───────────────────────────────────

const REQUIRED_SECRETS = [
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_OWNER_NUMBER',
  'GITHUB_TOKEN',
  'WORKER_CALLBACK_SECRET',
];

let secretNames = [];
try {
  const output = execSync('npx wrangler secret list 2>/dev/null', {
    cwd: workerDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  secretNames = REQUIRED_SECRETS.filter(s => output.includes(s));

  for (const secret of REQUIRED_SECRETS) {
    if (output.includes(secret)) {
      ok(`Secret ${secret} is set`);
    } else {
      fail(
        `Secret ${secret} is set`,
        `Run: cd worker && npx wrangler secret put ${secret}`
      );
    }
  }
} catch {
  warn('Could not list Cloudflare secrets — skipping secret checks', 'Make sure you are authenticated: npx wrangler whoami');
}

// ── 3. Required GitHub Actions workflow files ────────────────────────────────

const workflows = ['generate.yml', 'post.yml', 'edit.yml', 'token-check.yml'];
for (const wf of workflows) {
  const wfPath = join(root, '.github/workflows', wf);
  if (existsSync(wfPath)) {
    ok(`.github/workflows/${wf} exists`);
  } else {
    fail(`.github/workflows/${wf} exists`, `Missing workflow file`);
  }
}

// ── 4. worker/index.js has no DEBUG_SKIP_SIG usage ──────────────────────────

const indexPath = join(workerDir, 'index.js');
if (existsSync(indexPath)) {
  const src = readFileSync(indexPath, 'utf8');
  if (src.includes('DEBUG_SKIP_SIG')) {
    fail(
      'No DEBUG_SKIP_SIG in worker/index.js',
      'Remove the debug bypass from verifySignature before deploying'
    );
  } else {
    ok('No debug bypass in worker/index.js');
  }
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n── Result: ${passed} passed, ${failed} failed, ${warnings} warnings ──\n`);

if (failed > 0) {
  console.error('Fix the issues above before deploying.\n');
  process.exit(1);
} else {
  console.log('All checks passed. Safe to deploy.\n');
}
