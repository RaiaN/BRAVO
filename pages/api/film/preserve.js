import fs from 'fs';
import { uploadLocalMediaToTos, presignTosObject, headTosObject } from '../../../utils/server/tosUpload';
import { registerAsset } from '../../../utils/film/server/registerAsset';
import { CLOUD_MEDIA_PREFIX, mediaFilePath, mediaFileExists, mirrorKeyToTos, storeKeyFromUrl, readStoreBytes } from '../../../utils/server/mediaStore';

// "Check in" an asset: download the (still-valid) signed source URL server-side
// and re-upload the bytes into the user's own TOS bucket, returning a STABLE
// public URL that never expires. This is what downstream layers (Seedream refs,
// Seedance / Animate) should use instead of the 24h Seedream signed URL.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '30mb', // usually just a URL — but a not-yet-checked-in frame arrives as inline data:
    },
  },
};

const isHttpUrl = (v) => /^https?:\/\//i.test(String(v || '').trim());
// A media-STORE url (an extracted take frame, an audio-mood image, any checked-in
// asset): relative same-origin — absolutized against this request's own host, the
// loopback fetch rides the store's read-through GET (local disk, else the TOS mirror).
const isStoreUrl = (v) => /^\/api\/film\/media\?key=/.test(String(v || '').trim());

export default async function preserveHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { url, name } = req.body || {};
  if (!isHttpUrl(url) && !isStoreUrl(url) && !String(url || '').startsWith('data:')) {
    return res.status(400).json({ error: 'A http(s), data:, or media-store source url is required' });
  }

  const accessKey = process.env.MODELARK_ASSET_ACCESS_KEY;
  const secretKey = process.env.MODELARK_ASSET_SECRET_KEY;
  const tosBucket = process.env.MODELARK_TOS_BUCKET;
  if (!accessKey || !secretKey) {
    return res.status(400).json({ error: 'Asset access keys are not configured on the server (.env.local).' });
  }
  if (!tosBucket) {
    return res.status(400).json({ error: 'TOS bucket is not configured on the server (.env.local).' });
  }

  const tosCfg = {
    accessKey,
    secretKey,
    tosBucket,
    tosRegion: process.env.MODELARK_TOS_REGION,
    tosEndpoint: process.env.MODELARK_TOS_ENDPOINT,
  };
  // Image assets skip the person screen as asset:// refs (live-proven); Video
  // registration is live-probed too (CreateAsset AssetType:'Video' → Active).
  // Audio has no proven asset type — it stays store-only (assetId null).
  const assetTypeFor = (ct) => (ct.startsWith('video/') ? 'Video' : ct.startsWith('image/') ? 'Image' : null);

  try {
    // A media-STORE url: the bytes are ALREADY content-addressed in TOS (mirrored at
    // check-in) — never move them again. Presign the existing projects/media/<sha>
    // object and register THAT. (The legacy path below re-staged to a random key —
    // double storage; kept only for urls whose bytes aren't in the store yet.)
    if (isStoreUrl(url)) {
      const storeKey = (/[?&]key=([a-f0-9]{16,64}\.[a-z0-9]{1,5})/.exec(url) || [])[1];
      if (storeKey) {
        const objectKey = `${CLOUD_MEDIA_PREFIX}/${storeKey}`;
        const head = await headTosObject({ ...tosCfg, objectKey }).catch(() => ({ exists: false }));
        if (!head.exists && mediaFileExists(storeKey)) {
          try { await mirrorKeyToTos(storeKey, fs.readFileSync(mediaFilePath(storeKey))); } catch { /* legacy path below */ }
        }
        if (head.exists || mediaFileExists(storeKey)) {
          const extType = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg' };
          const contentType = head.contentType || extType[storeKey.split('.').pop()] || 'application/octet-stream';
          const signed = presignTosObject({ ...tosCfg, objectKey });
          let assetId = null;
          const assetType = assetTypeFor(contentType);
          if (assetType) {
            try {
              assetId = await registerAsset({ accessKey, secretKey, url: signed, name, assetType, waitForActive: true });
            } catch (err) {
              console.warn('[film/preserve] Assets API registration skipped:', err.message);
            }
          }
          return res.status(200).json({ url: signed, assetId, objectKey, contentType, size: head.size || 0 });
        }
      }
    }

    // Resolve the source BYTES. Three shapes arrive here:
    //  • data:            — the bytes ARE the url (a frame tagged before check-in) — use directly;
    //  • /api/film/media  — loopback-fetch our own store (read-through: disk, else TOS mirror);
    //  • http(s)          — fetch while the signed URL is still valid (the original path).
    let dataUrl;
    let contentType;
    if (String(url).startsWith('data:')) {
      dataUrl = String(url);
      contentType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/jpeg';
    } else if (isStoreUrl(url)) {
      // Store url whose key didn't resolve on the fast path above — read the store
      // DIRECTLY in-process (never fetch http://<self>; that breaks behind proxies).
      const skey = storeKeyFromUrl(url);
      const { buffer, contentType: ct } = await readStoreBytes(skey);
      contentType = ct;
      dataUrl = `data:${ct};base64,${buffer.toString('base64')}`;
    } else {
      const srcResponse = await fetch(url);
      if (!srcResponse.ok) {
        return res.status(502).json({
          error: srcResponse.status === 403
            ? 'Source URL has expired (403) — this asset can no longer be preserved. Re-generate it.'
            : `Could not fetch source asset (${srcResponse.status})`,
        });
      }
      contentType = srcResponse.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await srcResponse.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      dataUrl = `data:${contentType};base64,${base64}`;
    }

    const ext = contentType.includes('png') ? 'png'
      : contentType.includes('webp') ? 'webp'
        : contentType.includes('quicktime') ? 'mov'
          : contentType.startsWith('video/') ? (contentType.split('/')[1].split(';')[0] || 'mp4')
            : contentType.startsWith('audio/') ? (contentType.includes('mpeg') ? 'mp3' : contentType.split('/')[1].split(';')[0] || 'mp3')
              : 'jpg';
    const staged = await uploadLocalMediaToTos({
      accessKey,
      secretKey,
      tosBucket,
      tosRegion: process.env.MODELARK_TOS_REGION,
      tosEndpoint: process.env.MODELARK_TOS_ENDPOINT,
      tosObjectPrefix: process.env.MODELARK_TOS_OBJECT_PREFIX || 'film-agent',
      tosPublicBaseUrl: process.env.MODELARK_TOS_PUBLIC_BASE_URL || '',
      localData: dataUrl,
      localName: name || '',
      fallbackName: `preserved-${Date.now()}.${ext}`,
      dataLabel: 'Preserved asset',
    });

    // A configured public base URL is a CLAIM that the bucket is public-read —
    // verify it. On a private bucket the unsigned objectUrl 403s, and swapping
    // it into a board node breaks the image the moment it's "preserved" (the
    // exact opposite of what check-in promises). When the probe fails, hand out
    // the presigned GET instead; board nodes re-sign on error (/api/film/resign),
    // so the link never dies for good — the bytes are already safe either way.
    let stableUrl = staged.objectUrl;
    try {
      const probe = await fetch(stableUrl, { method: 'HEAD' });
      if (!probe.ok) stableUrl = staged.signedUrl;
    } catch {
      stableUrl = staged.signedUrl;
    }

    // Catalogue it in the Assets library for asset:// references + the Library.
    // Register via the PRESIGNED url so the Assets backend can download it on a
    // private bucket (the unsigned stableUrl would 403).
    let assetId = null;
    const assetType = assetTypeFor(contentType);
    if (assetType) {
      try {
        assetId = await registerAsset({
          accessKey,
          secretKey,
          url: staged.signedUrl || stableUrl,
          name,
          assetType,
          waitForActive: true,
        });
      } catch (err) {
        console.warn('[film/preserve] Assets API registration skipped:', err.message);
      }
    }

    return res.status(200).json({ url: stableUrl, assetId, objectKey: staged.objectKey, contentType, size: staged.size });
  } catch (error) {
    return res.status(500).json({ error: 'Preserve failed', details: error.message });
  }
}
