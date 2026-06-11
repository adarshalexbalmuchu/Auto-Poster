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
