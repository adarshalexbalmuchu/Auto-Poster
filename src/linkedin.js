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

// ─── Image post ─────────────────────────────────────────────────────────────
//
// LinkedIn image shares are a 3-step dance on the classic Assets API (same
// w_member_social scope as text — no re-auth needed):
//   1. registerUpload  → get an upload URL + asset URN
//   2. upload the image binary to that URL
//   3. create the ugcPost referencing the asset URN with shareMediaCategory=IMAGE

export async function postImage(client, text, imageBytes, contentType = 'image/jpeg') {
  const token = requireToken(client);
  const { personUrn } = getCredentials(client);

  // 1. Register the upload.
  const { data: reg } = await apiPost(`${LINKEDIN_API_V2}/assets?action=registerUpload`, token, {
    registerUploadRequest: {
      owner: personUrn,
      recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
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

  // 2. Upload the binary. LinkedIn's documented flow uses PUT (curl --upload-file),
  //    but the media upload host has been observed to expect POST — try PUT, fall
  //    back to POST once so we don't hard-fail on that ambiguity.
  const uploadOnce = (method) => fetch(uploadUrl, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: imageBytes,
    signal: AbortSignal.timeout(60_000),
  });
  let upRes = await uploadOnce('PUT');
  if (!upRes.ok && (upRes.status === 405 || upRes.status === 400 || upRes.status === 401)) {
    upRes = await uploadOnce('POST');
  }
  if (!upRes.ok) {
    const body = await upRes.text().catch(() => '');
    throw new Error(`LinkedIn image upload failed (${upRes.status}): ${body}`);
  }

  // 3. Create the post referencing the uploaded asset.
  const { res, data } = await apiPost(`${LINKEDIN_API_V2}/ugcPosts`, token, {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'IMAGE',
        media: [{ status: 'READY', media: asset }],
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  });

  const postId = res.headers.get('x-restli-id') || data?.id || null;
  return { postId, data };
}
