import { uploadLocalMediaToTos, parseDataUrl } from '../../../utils/server/tosUpload';
import { registerAsset } from '../../../utils/film/server/registerAsset';
import { checkInBytes } from '../../../utils/server/mediaStore';

// Stage a locally-dropped/uploaded file (base64 data URL) into the user's TOS
// bucket and return a stable public URL + an Assets-library id. Dropped assets go
// through this so they have a real http URL plus a trusted asset:// reference —
// the latter is what Seedance / Animate use for realistic uploaded stills (the
// raw TOS object URL is not publicly fetchable). Seedream image refs use the
// local base64 directly on the client, so they don't depend on either URL here.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '60mb',
    },
  },
};

const isDataUrl = (v) => /^data:[^;]+;base64,/i.test(String(v || ''));

export default async function uploadHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { dataUrl, name } = req.body || {};
  if (!isDataUrl(dataUrl)) {
    return res.status(400).json({ error: 'A base64 data URL is required' });
  }

  const accessKey = process.env.MODELARK_ASSET_ACCESS_KEY;
  const secretKey = process.env.MODELARK_ASSET_SECRET_KEY;
  const tosBucket = process.env.MODELARK_TOS_BUCKET;
  if (!accessKey || !secretKey || !tosBucket) {
    return res.status(400).json({ error: 'TOS storage is not configured on the server (.env.local).' });
  }

  try {
    const contentType = dataUrl.slice(5, dataUrl.indexOf(';')).toLowerCase();
    const ext = contentType.split('/')[1] || 'bin';
    const staged = await uploadLocalMediaToTos({
      accessKey,
      secretKey,
      tosBucket,
      tosRegion: process.env.MODELARK_TOS_REGION,
      tosEndpoint: process.env.MODELARK_TOS_ENDPOINT,
      tosObjectPrefix: process.env.MODELARK_TOS_OBJECT_PREFIX || 'film-agent/uploads',
      tosPublicBaseUrl: process.env.MODELARK_TOS_PUBLIC_BASE_URL || '',
      localData: dataUrl,
      localName: name || '',
      fallbackName: `upload-${Date.now()}.${ext}`,
      dataLabel: 'Uploaded asset',
    });
    // SOURCE-SIDE durability: the upload's bytes go straight into the two-tier store
    // (local + TOS mirror) and the STABLE store url is the display url from birth —
    // no client-side check-in, nothing that can expire. The staged fetchUrl (public,
    // else 7-day presigned) remains the fallback + the Assets-API ingest source.
    let url = staged.fetchUrl || staged.objectUrl;
    let cacheUrl = null;
    try {
      const parsed = parseDataUrl(dataUrl, 'Uploaded asset');
      cacheUrl = (await checkInBytes(parsed.buffer, parsed.contentType)).url;
      url = cacheUrl;
    } catch (e) { console.warn('[film/upload] source check-in failed — serving the staged url:', e.message); }

    // Catalogue it in the Assets library so the upload is usable as an asset://
    // reference in Seedance / Animate. The Assets backend DOWNLOADS the URL to
    // ingest it, so we pass the PRESIGNED url (works on a private bucket; the
    // unsigned objectUrl would 403). Wait for it to go Active so it's animatable
    // immediately. Images AND videos (AssetType:'Video' live-probed → Active);
    // audio has no proven asset type and stays store-only.
    let assetId = null;
    if (contentType.startsWith('image/') || contentType.startsWith('video/')) {
      try {
        assetId = await registerAsset({
          accessKey,
          secretKey,
          url: staged.signedUrl || url,
          name,
          assetType: contentType.startsWith('video/') ? 'Video' : 'Image',
          waitForActive: true,
        });
      } catch (err) {
        console.warn('[film/upload] Assets API registration skipped:', err.message);
      }
    }

    return res.status(200).json({ url, cacheUrl, assetId, contentType });
  } catch (error) {
    return res.status(500).json({ error: 'Upload failed', details: error.message });
  }
}
