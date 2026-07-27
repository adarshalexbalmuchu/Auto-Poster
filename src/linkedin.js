/**
 * linkedin.js — LinkedIn API client (text posts via UGC Posts API)
 */

const LINKEDIN_API_V2 = 'https://api.linkedin.com/v2';

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

// ─── Text post ────────────────────────────────────────────────────────────────

export async function postText(client, text) {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);

  const { res, data } = await apiPost(`${LINKEDIN_API_V2}/ugcPosts`, token, {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  });

  const postId = res.headers.get('x-restli-id') || data?.id || null;
  return { postId, data };
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

  const { res, data } = await apiPost(`${LINKEDIN_API_V2}/ugcPosts`, token, {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'IMAGE',
        media: mediaEntries,
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  });

  const postId = res.headers.get('x-restli-id') || data?.id || null;
  return { postId, data };
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

  const { res, data } = await apiPost(`${LINKEDIN_API_V2}/ugcPosts`, token, {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'IMAGE',
        media: [{ status: 'READY', media: asset, title: { text: title } }],
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  });

  const postId = res.headers.get('x-restli-id') || data?.id || null;
  return { postId, data };
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
