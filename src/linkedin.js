/**
 * linkedin.js — LinkedIn API client
 *
 * Supports:
 *  - Text posts (UGC Posts API)
 *  - Image posts (registerUpload → upload binary → UGC post)
 *  - Document/carousel posts (REST Posts API v202210 with /rest/documents upload)
 */

const LINKEDIN_API_V2 = 'https://api.linkedin.com/v2';
const LINKEDIN_REST = 'https://api.linkedin.com/rest';

function envKey(clientId, suffix) {
  return process.env[`${clientId.toUpperCase()}_LINKEDIN_${suffix}`] || process.env[`LINKEDIN_${suffix}`];
}

export function isTokenValid(client) {
  const token = envKey(client.id, 'ACCESS_TOKEN');
  if (!token) return false;
  const expiresAt = envKey(client.id, 'TOKEN_EXPIRES_AT');
  if (!expiresAt) return !!token;
  return new Date(expiresAt) > new Date(Date.now() + 24 * 60 * 60 * 1000);
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

  const payload = {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };

  const { res, data } = await apiPost(`${LINKEDIN_API_V2}/ugcPosts`, token, payload);
  const postId = res.headers.get('x-restli-id') || data?.id || null;
  return { postId, data };
}

// ─── Image post ───────────────────────────────────────────────────────────────

export async function registerImageUpload(client) {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);

  const payload = {
    registerUploadRequest: {
      owner: personUrn,
      recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
      serviceRelationships: [
        { identifier: 'urn:li:userGeneratedContent', relationshipType: 'OWNER' },
      ],
    },
  };

  const { data } = await apiPost(
    `${LINKEDIN_API_V2}/assets?action=registerUpload`,
    token,
    payload
  );
  return {
    uploadUrl: data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl,
    asset: data.value.asset,
  };
}

export async function uploadBinary(uploadUrl, buffer, token, contentType = 'image/png') {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Binary upload failed (${res.status}): ${text}`);
  }
}

export async function postWithImage(client, text, imageBuffer, contentType = 'image/png') {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);

  const { uploadUrl, asset } = await registerImageUpload(client);
  await uploadBinary(uploadUrl, imageBuffer, token, contentType);

  const payload = {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'IMAGE',
        media: [
          {
            status: 'READY',
            media: asset,
          },
        ],
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };

  const { res, data } = await apiPost(`${LINKEDIN_API_V2}/ugcPosts`, token, payload);
  const postId = res.headers.get('x-restli-id') || data?.id || null;
  return { postId, data };
}

// ─── Document / PDF carousel post ────────────────────────────────────────────

export async function initDocumentUpload(client) {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);

  const res = await fetch(`${LINKEDIN_REST}/documents`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'LinkedIn-Version': '202210',
    },
    body: JSON.stringify({
      initializeUploadRequest: { owner: personUrn },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Document init failed (${res.status}): ${msg}`);
  }

  return {
    uploadUrl: data.value.uploadUrl,
    document: data.value.document,
  };
}

export async function postDocument(client, text, documentUrn, title) {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);

  const payload = {
    author: personUrn,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: {
      document: {
        owner: personUrn,
        title,
        uploadedDocument: documentUrn,
      },
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  const res = await fetch(`${LINKEDIN_REST}/posts`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'LinkedIn-Version': '202210' },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Document post failed (${res.status}): ${msg}`);
  }

  const postId = res.headers.get('x-restli-id') || data?.id || null;
  return { postId, data };
}

export async function uploadAndPostDocument(client, text, pdfBuffer, title) {
  const token = requireToken(client);

  const { uploadUrl, document: documentUrn } = await initDocumentUpload(client);

  await uploadBinary(uploadUrl, pdfBuffer, token, 'application/pdf');

  return postDocument(client, text, documentUrn, title);
}
