import { uploadLocalMediaToTos, parseDataUrl } from '../../../utils/server/tosUpload';
import { registerAsset } from '../../../utils/film/server/registerAsset';
import { checkInBytes } from '../../../utils/server/mediaStore';

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
    let url = staged.fetchUrl || staged.objectUrl;
    let cacheUrl = null;
    try {
      const parsed = parseDataUrl(dataUrl, 'Uploaded asset');
      cacheUrl = (await checkInBytes(parsed.buffer, parsed.contentType)).url;
      url = cacheUrl;
    } catch (e) { console.warn('[film/upload] source check-in failed — serving the staged url:', e.message); }

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
