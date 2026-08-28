import { TosClient } from '@volcengine/tos-sdk';
import { requireTosRegion, getDefaultTosEndpoint, tosObjectKeyFromUrl } from '../../../utils/server/tosUpload';

// Mint a fresh presigned GET link for an object this app already owns in TOS.
// The "stable" URL preserve hands out is only truly stable when the bucket is
// public-read; on a private bucket it 403s, and a presigned link lapses after
// 7 days. Either way the BYTES are fine — only the link is dead. Board nodes
// call this when a preserved image fails to load, so check-in keeps its promise.

export default async function resignHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { url, objectKey } = req.body || {};
  const accessKey = process.env.MODELARK_ASSET_ACCESS_KEY;
  const secretKey = process.env.MODELARK_ASSET_SECRET_KEY;
  const tosBucket = process.env.MODELARK_TOS_BUCKET;
  if (!accessKey || !secretKey || !tosBucket) {
    return res.status(400).json({ error: 'TOS is not configured on the server (.env.local).' });
  }

  const tosRegion = process.env.MODELARK_TOS_REGION;
  const tosEndpoint = process.env.MODELARK_TOS_ENDPOINT;
  // Trust an explicit objectKey; otherwise recover it from the stored url —
  // tosObjectKeyFromUrl only matches OUR bucket, so we never sign foreign urls.
  const key = String(objectKey || '').trim() || tosObjectKeyFromUrl(url, {
    tosPublicBaseUrl: process.env.MODELARK_TOS_PUBLIC_BASE_URL,
    tosEndpoint,
    tosRegion,
    tosBucket,
  });
  if (!key) {
    return res.status(400).json({ error: 'Not an object from this bucket — nothing to re-sign.' });
  }

  try {
    const resolvedRegion = requireTosRegion(tosRegion);
    const client = new TosClient({
      accessKeyId: accessKey,
      accessKeySecret: secretKey,
      region: resolvedRegion,
      endpoint: String(tosEndpoint || '').trim() || getDefaultTosEndpoint(resolvedRegion),
    });
    const signed = client.getPreSignedUrl({ bucket: tosBucket, key, method: 'GET', expires: 604800 });
    return res.status(200).json({ url: signed, objectKey: key });
  } catch (error) {
    return res.status(500).json({ error: 'Re-sign failed', details: error.message });
  }
}
