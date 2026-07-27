/**
 * drafts.js — Shared "find the latest unposted draft" logic
 *
 * Draft filenames are ISO-timestamp prefixed (e.g. 2026-07-21T12-14-33-alex.json),
 * so a plain lexicographic sort is also chronological. File mtime is NOT reliable
 * for this: a fresh `actions/checkout` resets every file's mtime to checkout time,
 * so sorting by mtime (e.g. `ls -t`) can return an effectively arbitrary order.
 */

import { readdirSync, readFileSync } from 'node:fs';

const DRAFTS_DIR = './drafts';

export function findLatestDraft(clientId = null) {
  let files;
  try {
    files = readdirSync(DRAFTS_DIR);
  } catch {
    throw new Error('drafts/ directory not found — no draft available');
  }
  const suffix = clientId ? `-${clientId}.json` : '.json';
  const candidates = files
    .filter(f => f.endsWith(suffix) && f !== 'history.json')
    .sort()
    .reverse();
  for (const file of candidates) {
    const path = `${DRAFTS_DIR}/${file}`;
    try {
      const d = JSON.parse(readFileSync(path, 'utf8'));
      if (!d.posted) return path;
    } catch { /* skip unreadable/corrupt files */ }
  }
  throw new Error(clientId ? `No unposted draft found for: ${clientId}` : 'No unposted draft found');
}
