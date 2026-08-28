import crypto from 'crypto';
import { TosClient } from '@volcengine/tos-sdk';

// NO default region — MODELARK_TOS_REGION is required wherever TOS is used
// (configured-or-error, like every other deployment value; a silent region default
// pointed misconfigured deployments at the wrong geography).
export const requireTosRegion = (tosRegion) => {
  const r = String(tosRegion || '').trim();
  if (!r) throw new Error('MODELARK_TOS_REGION is not configured — set it in .env.local (see .env.example).');
  if (r.includes('.') || r.includes('/')) throw new Error('MODELARK_TOS_REGION must be a region like ap-southeast-1, not a domain.');
  return r;
};

const encodePathSegment = (segment) =>
  encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export const getDefaultTosEndpoint = (region) => `tos-${region}.bytepluses.com`;
export const getDefaultTosPublicBaseUrl = ({ endpoint, bucket }) => `https://${endpoint}/${bucket}`;

export const parseDataUrl = (value, label = 'Local file payload') => {
  const str = String(value || '');
  const semiIdx = str.indexOf(';');
  const commaIdx = str.indexOf(',');
  if (!str.startsWith('data:') || semiIdx === -1 || commaIdx === -1 || str.slice(semiIdx + 1, commaIdx) !== 'base64') {
    throw new Error(`${label} must be a valid data URL.`);
  }
  return {
    contentType: str.slice(5, semiIdx),
    buffer: Buffer.from(str.slice(commaIdx + 1), 'base64'),
  };
};

const normalizeObjectKeyPart = (value) =>
  String(value || '')
    .replace(/[^a-zA-Z0-9/_\-.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\//, '');

export async function uploadLocalMediaToTos({
  accessKey,
  secretKey,
  tosBucket,
  tosRegion,
  tosEndpoint,
  tosObjectPrefix,
  tosPublicBaseUrl,
  localData,
  localName,
  fallbackName,
  dataLabel,
}) {
  const { contentType, buffer } = parseDataUrl(localData, dataLabel);
  const safeName = normalizeObjectKeyPart(localName || fallbackName || `upload-${Date.now()}`);
  const prefix = normalizeObjectKeyPart(tosObjectPrefix || 'seedance-media');
  const objectKey = `${prefix}/${crypto.randomUUID()}-${safeName}`;
  const resolvedRegion = requireTosRegion(tosRegion);
  const resolvedEndpoint = String(tosEndpoint || '').trim() || getDefaultTosEndpoint(resolvedRegion);


  const client = new TosClient({
    accessKeyId: accessKey,
    accessKeySecret: secretKey,
    region: resolvedRegion,
    endpoint: resolvedEndpoint,
  });
  const uploadUrl = client.getPreSignedUrl({
    bucket: tosBucket,
    key: objectKey,
    method: 'PUT',
    expires: 900,
  });

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    body: buffer,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TOS PutObject failed: ${response.status} ${errorText}`);
  }

  const baseUrl =
    String(tosPublicBaseUrl || '').trim().replace(/\/+$/, '') ||
    getDefaultTosPublicBaseUrl({ endpoint: resolvedEndpoint, bucket: tosBucket });
  const objectUrl = `${baseUrl}/${objectKey.split('/').map((segment) => encodePathSegment(segment)).join('/')}`;
  // A presigned GET URL works even on a PRIVATE bucket — unlike the unsigned
  // objectUrl, which 403s unless the bucket is public-read. Backend services that
  // must DOWNLOAD the object (the Assets API ingesting it, Seedance fetching a
  // reference) need this regardless of whether a public base URL is configured.
  // 7 days (the presign maximum): on a private bucket this is also the DISPLAY
  // url preserve falls back to, and board nodes re-sign on error when it lapses.
  const signedUrl = client.getPreSignedUrl({
    bucket: tosBucket,
    key: objectKey,
    method: 'GET',
    expires: 604800,
  });
  const fetchUrl = String(tosPublicBaseUrl || '').trim() ? objectUrl : signedUrl;

  return {
    objectKey,
    objectUrl,
    fetchUrl,
    signedUrl,
    contentType,
    size: buffer.length,
  };
}

// Recover the TOS object key from a stored url (public objectUrl or presigned),
// by stripping the bucket's base url prefix and decoding. Returns null if the url
// doesn't belong to this bucket (so we never delete something we don't own).
export const tosObjectKeyFromUrl = (url, { tosPublicBaseUrl, tosEndpoint, tosRegion, tosBucket } = {}) => {
  const u = String(url || '').trim();
  if (!u) return null;
  const resolvedRegion = requireTosRegion(tosRegion);
  const resolvedEndpoint = String(tosEndpoint || '').trim() || getDefaultTosEndpoint(resolvedRegion);
  const candidates = [
    String(tosPublicBaseUrl || '').trim().replace(/\/+$/, ''),
    getDefaultTosPublicBaseUrl({ endpoint: resolvedEndpoint, bucket: tosBucket }),
  ].filter(Boolean);
  for (const base of candidates) {
    if (u.startsWith(`${base}/`)) {
      const tail = u.slice(base.length + 1).split('?')[0]; // drop any presigned query
      try { return decodeURIComponent(tail); } catch { return tail; }
    }
  }
  return null;
};

// Permanently delete one object from the bucket.
export async function deleteTosObject({ accessKey, secretKey, tosBucket, tosRegion, tosEndpoint, objectKey }) {
  if (!objectKey) return;
  const resolvedRegion = requireTosRegion(tosRegion);
  const resolvedEndpoint = String(tosEndpoint || '').trim() || getDefaultTosEndpoint(resolvedRegion);
  const client = new TosClient({
    accessKeyId: accessKey,
    accessKeySecret: secretKey,
    region: resolvedRegion,
    endpoint: resolvedEndpoint,
  });
  await client.deleteObject({ bucket: tosBucket, key: objectKey });
}

// ---- Cloud project store primitives (content-addressed media + manifests) ----------
// The cloud-first media flow puts BYTES at CHOSEN keys (projects/media/<sha256>.<ext>)
// and reads them back — plain object storage, direct SDK calls (no presign dance).

const makeClient = ({ accessKey, secretKey, tosRegion, tosEndpoint }) => {
  const resolvedRegion = requireTosRegion(tosRegion);
  const resolvedEndpoint = String(tosEndpoint || '').trim() || getDefaultTosEndpoint(resolvedRegion);
  return new TosClient({ accessKeyId: accessKey, accessKeySecret: secretKey, region: resolvedRegion, endpoint: resolvedEndpoint });
};

// The one env reader every route shares (hoisted from /api/seedance).
export const getServerTosConfig = () => ({
  accessKey: process.env.MODELARK_ASSET_ACCESS_KEY,
  secretKey: process.env.MODELARK_ASSET_SECRET_KEY,
  tosBucket: process.env.MODELARK_TOS_BUCKET,
  tosRegion: process.env.MODELARK_TOS_REGION,
  tosEndpoint: process.env.MODELARK_TOS_ENDPOINT,
  tosObjectPrefix: process.env.MODELARK_TOS_OBJECT_PREFIX,
  tosPublicBaseUrl: process.env.MODELARK_TOS_PUBLIC_BASE_URL || '',
});

export const hasServerTosConfig = (cfg = getServerTosConfig()) => !!(cfg.accessKey && cfg.secretKey && cfg.tosBucket);

// Does this object exist? (Content-addressed keys → an existing object IS the bytes.)
export async function headTosObject({ accessKey, secretKey, tosBucket, tosRegion, tosEndpoint, objectKey }) {
  const client = makeClient({ accessKey, secretKey, tosRegion, tosEndpoint });
  try {
    const res = await client.headObject({ bucket: tosBucket, key: objectKey });
    return { exists: true, size: Number(res.headers?.['content-length']) || 0, contentType: res.headers?.['content-type'] || '' };
  } catch (e) {
    if (e?.statusCode === 404) return { exists: false };
    throw e;
  }
}

// Put bytes at an EXPLICIT key. Content-addressed callers (media: same sha = same
// bytes) keep the default skip-if-exists dedupe; MUTABLE keys (a project MANIFEST —
// fixed key, changing contents) MUST pass overwrite:true or the first write becomes
// permanent and every later "save" silently no-ops.
export async function putTosObject({ accessKey, secretKey, tosBucket, tosRegion, tosEndpoint, objectKey, buffer, contentType, overwrite = false }) {
  if (!objectKey || !buffer?.length) throw new Error('putTosObject needs an objectKey and bytes.');
  const creds = { accessKey, secretKey, tosBucket, tosRegion, tosEndpoint };
  if (!overwrite) {
    const head = await headTosObject({ ...creds, objectKey });
    if (head.exists) return { objectKey, size: head.size, deduped: true };
  }
  const client = makeClient(creds);
  await client.putObject({ bucket: tosBucket, key: objectKey, body: buffer, contentType: contentType || 'application/octet-stream' });
  return { objectKey, size: buffer.length, deduped: false };
}

// Presigned GET for an EXISTING object — the way to hand a model service (Seedance
// fetching a reference clip) something it can download from a private bucket WITHOUT
// moving any bytes through us. 7 days = the presign maximum.
export function presignTosObject({ accessKey, secretKey, tosBucket, tosRegion, tosEndpoint, objectKey, expires = 604800 }) {
  const client = makeClient({ accessKey, secretKey, tosRegion, tosEndpoint });
  return client.getPreSignedUrl({ bucket: tosBucket, key: objectKey, method: 'GET', expires });
}

// Download one object's bytes.
export async function downloadTosObject({ accessKey, secretKey, tosBucket, tosRegion, tosEndpoint, objectKey }) {
  const client = makeClient({ accessKey, secretKey, tosRegion, tosEndpoint });
  const res = await client.getObjectV2({ bucket: tosBucket, key: objectKey, dataType: 'buffer' });
  return { buffer: res.data.content, contentType: res.headers?.['content-type'] || 'application/octet-stream' };
}

// List the immediate "folders" under a prefix (delimiter listing → CommonPrefixes).
// One cheap call that never sweeps the objects INSIDE those folders — the project
// list needs this because projects/media/ holds thousands of mirrored blobs that a
// flat listing would page through (and could truncate manifests out of).
export async function listTosCommonPrefixes({ accessKey, secretKey, tosBucket, tosRegion, tosEndpoint, prefix }) {
  const client = makeClient({ accessKey, secretKey, tosRegion, tosEndpoint });
  const out = [];
  let continuationToken;
  do {
    const params = { bucket: tosBucket, prefix, delimiter: '/', maxKeys: 1000, ...(continuationToken ? { continuationToken } : {}) };
    // eslint-disable-next-line no-await-in-loop
    const res = await client.listObjectsType2(params);
    (res.data.CommonPrefixes || []).forEach((p) => { if (p.Prefix) out.push(p.Prefix); });
    continuationToken = res.data.IsTruncated ? res.data.NextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

// List every object under a prefix (paginates past the 1000-key page limit).
export async function listTosObjects({ accessKey, secretKey, tosBucket, tosRegion, tosEndpoint, prefix, maxKeys = 1000 }) {
  const client = makeClient({ accessKey, secretKey, tosRegion, tosEndpoint });
  const out = [];
  let continuationToken;
  do {
    // A literal `continuationToken: undefined` still enters the SDK's canonical request
    // and breaks the signature — include the key ONLY when a token exists.
    const params = { bucket: tosBucket, prefix, maxKeys: Math.min(maxKeys, 1000), ...(continuationToken ? { continuationToken } : {}) };
    // eslint-disable-next-line no-await-in-loop
    const res = await client.listObjectsType2(params);
    (res.data.Contents || []).forEach((o) => out.push({ key: o.Key, size: Number(o.Size) || 0, lastModified: o.LastModified }));
    continuationToken = res.data.IsTruncated ? res.data.NextContinuationToken : undefined;
  } while (continuationToken && out.length < maxKeys);
  return out;
}
