/**
 * linkedin.js — LinkedIn API client
 *
 * Supports:
 *  - Text posts (UGC Posts API)
 *  - Document/PDF posts (REST Posts API v202210 with /rest/documents upload)
 */

const LINKEDIN_API_V2 = 'https://api.linkedin.com/v2';
const LINKEDIN_REST = 'https://api.linkedin.com/rest';

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

async function uploadBinary(uploadUrl, buffer, token, contentType) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: buffer,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Binary upload failed (${res.status}): ${text}`);
  }
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

// ─── Document / PDF post ──────────────────────────────────────────────────────

export async function uploadAndPostDocument(client, text, pdfBuffer, title) {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);

  // Step 1: initialise upload
  const initRes = await fetch(`${LINKEDIN_REST}/documents`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'LinkedIn-Version': '202210' },
    body: JSON.stringify({ initializeUploadRequest: { owner: personUrn } }),
  });
  const initData = await initRes.json().catch(() => ({}));
  if (!initRes.ok) {
    const msg = initData?.message || initData?.error || JSON.stringify(initData);
    throw new Error(`Document init failed (${initRes.status}): ${msg}`);
  }
  const { uploadUrl, document: documentUrn } = initData.value;

  // Step 2: upload PDF bytes
  await uploadBinary(uploadUrl, pdfBuffer, token, 'application/pdf');

  // Step 3: publish post
  const postRes = await fetch(`${LINKEDIN_REST}/posts`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'LinkedIn-Version': '202210' },
    body: JSON.stringify({
      author: personUrn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        document: { owner: personUrn, title, uploadedDocument: documentUrn },
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  const postData = await postRes.json().catch(() => ({}));
  if (!postRes.ok) {
    const msg = postData?.message || postData?.error || JSON.stringify(postData);
    throw new Error(`Document post failed (${postRes.status}): ${msg}`);
  }

  const postId = postRes.headers.get('x-restli-id') || postData?.id || null;
  return { postId, data: postData };
}
