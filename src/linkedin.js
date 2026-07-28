/**
 * linkedin.js — LinkedIn API client (text posts via UGC Posts API)
 */

import { existsSync, readFileSync } from 'node:fs';

const LINKEDIN_API_V2 = 'https://api.linkedin.com/v2';
const MENTIONS_PATH = './clients/mentions.json';

export function envKey(clientId, suffix) {
  return process.env[`${clientId.toUpperCase()}_LINKEDIN_${suffix}`] || process.env[`LINKEDIN_${suffix}`];
}

function getCredentials(client) {
  const accessToken = envKey(client.id, 'ACCESS_TOKEN');
  const personUrn   = envKey(client.id, 'PERSON_URN');
  return { accessToken, personUrn };
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0',
  };
}

function requireToken(client) {
  const { accessToken, personUrn } = getCredentials(client);
  if (!accessToken || !personUrn) {
    throw new Error(
      `LinkedIn credentials missing for ${client.name}. ` +
      `Run: npm run auth -- --client ${client.id}`
    );
  }
  return accessToken;
}

async function apiPost(url, token, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(token), ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.error_description || data?.error || JSON.stringify(data);
    throw new Error(`LinkedIn API ${res.status}: ${msg}`);
  }
  return { res, data };
}

// ─── Mentions (tagging companies/people) ───────────────────────────────────
//
// NOTE — lower confidence, unverified against the live API: this follows
// LinkedIn's documented "TextAttribute" pattern for the classic /v2/ugcPosts
// endpoint (character-offset spans in shareCommentary.text, each pointing at
// an organization/member URN). There's no accessible name→URN lookup API for
// arbitrary companies with this app's scope (that needs Marketing Developer
// Platform partner access), so clients/mentions.json is a manually maintained
// map — only names you've added get tagged, everything else stays plain text.
// If LinkedIn rejects a post because of this, publishUgcPost() below retries
// once with attributes stripped, so a bad/rejected tag can never take down
// the whole post — worst case, mentions silently don't get tagged.

function loadMentions() {
  if (!existsSync(MENTIONS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MENTIONS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Finds non-overlapping occurrences of known mention names in `text`, longest
// names matched first so e.g. "Provoke AI" wins over a bare "Provoke" inside it.
function findMentionAttributes(text) {
  const mentions = loadMentions();
  const names = Object.keys(mentions).sort((a, b) => b.length - a.length);
  if (!names.length) return [];

  const taken = [];
  const attributes = [];

  for (const name of names) {
    const entry = mentions[name];
    if (!entry?.urn || (entry.type !== 'organization' && entry.type !== 'person')) continue;

    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
    let m;
    while ((m = re.exec(text))) {
      const start = m.index, end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      const key = entry.type === 'person' ? 'com.linkedin.common.MemberAttributedEntity' : 'com.linkedin.common.CompanyAttributedEntity';
      const valueKey = entry.type === 'person' ? 'member' : 'company';
      attributes.push({ start, length: m[0].length, value: { [key]: { [valueKey]: entry.urn } } });
    }
  }

  return attributes.sort((a, b) => a.start - b.start);
}

// Shared ugcPost creation for all post types (text/image/document), with the
// mention-tagging attempt and its safe fallback centralized in one place.
async function publishUgcPost(token, personUrn, text, shareMediaCategory, media) {
  const attributes = findMentionAttributes(text);
  const buildBody = (withAttributes) => ({
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: withAttributes && attributes.length ? { text, attributes } : { text },
        shareMediaCategory,
        ...(media ? { media } : {}),
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  });

  let res, data;
  try {
    ({ res, data } = await apiPost(`${LINKEDIN_API_V2}/ugcPosts`, token, buildBody(true)));
  } catch (e) {
    if (!attributes.length) throw e;
    console.warn(`LinkedIn rejected the post with mention tags (${e.message}) — retrying without tags.`);
    ({ res, data } = await apiPost(`${LINKEDIN_API_V2}/ugcPosts`, token, buildBody(false)));
  }

  const postId = res.headers.get('x-restli-id') || data?.id || null;
  return { postId, data };
}

// ─── Text post ────────────────────────────────────────────────────────────────

export async function postText(client, text) {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);
  return publishUgcPost(token, personUrn, text, 'NONE');
}

// ─── Media asset upload (shared by image and document posts) ──────────────────
//
// LinkedIn media shares are a 3-step dance on the classic Assets API (same
// w_member_social scope as text — no re-auth needed):
//   1. registerUpload  → get an upload URL + asset URN, for a given "recipe"
//   2. upload the binary to that URL
//   3. create the ugcPost referencing the asset URN(s)

async function registerAndUploadAsset(token, personUrn, bytes, contentType, recipe) {
  const { data: reg } = await apiPost(`${LINKEDIN_API_V2}/assets?action=registerUpload`, token, {
    registerUploadRequest: {
      owner: personUrn,
      recipes: [recipe],
      serviceRelationships: [
        { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' },
      ],
    },
  });

  const asset = reg?.value?.asset;
  const uploadUrl = reg?.value?.uploadMechanism
    ?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
  if (!asset || !uploadUrl) {
    throw new Error(`LinkedIn registerUpload returned no upload target: ${JSON.stringify(reg)}`);
  }

  // Upload the binary. LinkedIn's documented flow uses PUT (curl --upload-file),
  // but the media upload host has been observed to expect POST — try PUT, fall
  // back to POST once so we don't hard-fail on that ambiguity.
  const uploadOnce = (method) => fetch(uploadUrl, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: bytes,
    signal: AbortSignal.timeout(60_000),
  });
  let upRes = await uploadOnce('PUT');
  if (!upRes.ok && (upRes.status === 405 || upRes.status === 400 || upRes.status === 401)) {
    upRes = await uploadOnce('POST');
  }
  if (!upRes.ok) {
    const body = await upRes.text().catch(() => '');
    throw new Error(`LinkedIn media upload failed (${upRes.status}): ${body}`);
  }

  return asset;
}

// ─── Image post(s) ──────────────────────────────────────────────────────────
//
// Accepts 1+ images. LinkedIn renders 2+ images as a swipeable multi-image
// post — same recipe and ugcPost shape as a single image, just more entries
// in the `media` array, capped at 9 to match LinkedIn's own UI limit.

export async function postImages(client, text, images) {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);

  const mediaEntries = [];
  for (const { data, mime } of images) {
    const asset = await registerAndUploadAsset(token, personUrn, data, mime, 'urn:li:digitalmediaRecipe:feedshare-image');
    mediaEntries.push({ status: 'READY', media: asset });
  }

  return publishUgcPost(token, personUrn, text, 'IMAGE', mediaEntries);
}

// ─── Document post (PDF carousel) ──────────────────────────────────────────
//
// NOTE — lower confidence than postImages: this follows the commonly cited
// pattern for native LinkedIn document/carousel shares on the classic
// /v2/ugcPosts endpoint (feedshare-document recipe, shareMediaCategory still
// 'IMAGE' since the older API has no distinct DOCUMENT category). Untested
// against the live API — if LinkedIn rejects it, the two most likely fixes
// are a different shareMediaCategory value, or that this now requires
// LinkedIn's newer /rest/posts API instead. Verify with a real PDF before
// relying on it for anything time-sensitive.

export async function postDocument(client, text, pdfBytes, title = 'Document') {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);

  const asset = await registerAndUploadAsset(token, personUrn, pdfBytes, 'application/pdf', 'urn:li:digitalmediaRecipe:feedshare-document');

  return publishUgcPost(token, personUrn, text, 'IMAGE', [{ status: 'READY', media: asset, title: { text: title } }]);
}

// ─── Comments ───────────────────────────────────────────────────────────────
//
// NOTE — lower confidence, unverified against the live API: analytics.js's
// getSocialActions() (GET /v2/socialActions/{urn}) is proven working in this
// codebase and returns aggregate counts. Listing/creating individual comments
// via the /comments sub-resource is the standard documented pattern for that
// same classic Social Actions API family, but hasn't been exercised here.
// Two specific things to verify on first real use:
//   1. The exact shape of a comment element from GET .../comments (this code
//      assumes { id, actor, message: { text } } per LinkedIn's documented
//      comment schema).
//   2. Whether a genuine threaded reply (nested under a specific comment) is
//      supported here at all — postComment() below posts a top-level comment
//      rather than attempting a `parentComment` nesting it isn't confident
//      LinkedIn's classic API actually supports.

export async function getComments(postUrn, token) {
  const res = await fetch(
    `${LINKEDIN_API_V2}/socialActions/${encodeURIComponent(postUrn)}/comments`,
    { headers: authHeaders(token), signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.elements || null;
}

export async function postComment(client, postUrn, text) {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);

  const { data } = await apiPost(
    `${LINKEDIN_API_V2}/socialActions/${encodeURIComponent(postUrn)}/comments`,
    token,
    { actor: personUrn, object: postUrn, message: { text } }
  );
  return data;
}
