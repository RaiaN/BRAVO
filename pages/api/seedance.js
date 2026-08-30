import fs from 'fs';
import { getEndpointUrl } from '../../utils/config';
import { uploadLocalMediaToTos, getServerTosConfig, presignTosObject, headTosObject } from '../../utils/server/tosUpload';
import { CLOUD_MEDIA_PREFIX, mediaFilePath, mediaFileExists, mirrorKeyToTos } from '../../utils/server/mediaStore';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());
const isDataUrl = (value) => /^data:[^;]+;base64,/i.test(String(value || ''));
const isAssetUrl = (value) => /^asset:\/\//i.test(String(value || '').trim());

const buildFallbackFileName = (role, contentType) => {
  const extensionMap = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
  };
  const extension = extensionMap[contentType]
    || (contentType.startsWith('image/') ? 'png' : contentType.startsWith('video/') ? 'mp4' : 'bin');
  return `${role}-${Date.now()}.${extension}`;
};

async function normalizeSeedanceContent(content) {
  const items = Array.isArray(content) ? content : [];
  const tosConfig = getServerTosConfig();
  let stagedCount = 0;
  let assetReferenceCount = 0;

  const normalized = await Promise.all(items.map(async (item) => {
    if (item?.type === 'image_asset_id') {
      assetReferenceCount += 1;
      return {
        type: 'image_url',
        image_url: { url: `asset://${String(item.asset_id || '').trim()}` },
        role: item.role || 'reference_image',
      };
    }

    if (!['image_url', 'video_url', 'audio_url'].includes(item?.type)) {
      return item;
    }

    const key =
      item.type === 'image_url'
        ? 'image_url'
        : item.type === 'video_url'
          ? 'video_url'
          : 'audio_url';
    const mediaUrl = item?.[key]?.url;

    if (String(mediaUrl || '').includes('/api/film/media?key=')) {
      const storeKey = (/[?&]key=([a-f0-9]{16,64}\.[a-z0-9]{1,5})/.exec(mediaUrl) || [])[1];
      if (item.type === 'audio_url' && storeKey && storeKey.split('.').pop().toLowerCase() !== 'mp3') {
        throw new Error(`${item.role || 'reference_audio'}: .${storeKey.split('.').pop()} is not supported by Seedance — attach an mp3 (convert the clip and re-attach).`);
      }
      let presigned = null;
      if (storeKey && tosConfig.accessKey && tosConfig.secretKey && tosConfig.tosBucket) {
        const objectKey = `${CLOUD_MEDIA_PREFIX}/${storeKey}`;
        const head = await headTosObject({ ...tosConfig, objectKey }).catch(() => ({ exists: false }));
        if (!head.exists && mediaFileExists(storeKey)) {
          try { await mirrorKeyToTos(storeKey, fs.readFileSync(mediaFilePath(storeKey))); } catch { }
        }
        if (head.exists || mediaFileExists(storeKey)) {
          try { presigned = presignTosObject({ ...tosConfig, objectKey }); } catch { }
        }
      }
      if (!presigned) {
        throw new Error(`${item.role || item.type}: media-store object ${storeKey || '(unrecognized key)'} could not be presigned — check TOS credentials in .env.local, or re-check-in the asset.`);
      }
      stagedCount += 1;
      return { ...item, [key]: { ...(item[key] || {}), url: presigned } };
    }

    if (!mediaUrl || isHttpUrl(mediaUrl) || isAssetUrl(mediaUrl)) {
      if (item?.type === 'image_url' && isAssetUrl(mediaUrl)) {
        assetReferenceCount += 1;
      }
      return item;
    }

    if (!isDataUrl(mediaUrl)) {
      throw new Error(`${item.role || item.type} must be a public http(s) URL, an asset:// URL, or a local uploaded file.`);
    }

    if (!tosConfig.accessKey || !tosConfig.secretKey) {
      throw new Error('TOS credentials are not configured on the server. Set them in .env.local to enable local Seedance media uploads.');
    }

    if (!tosConfig.tosBucket) {
      throw new Error('TOS bucket is not configured on the server. Set it in .env.local to enable local Seedance media uploads.');
    }

    const contentType = mediaUrl.slice(5, mediaUrl.indexOf(';')).toLowerCase();
    if (item.type === 'audio_url' && contentType.startsWith('audio/') && !['audio/mpeg', 'audio/mp3'].includes(contentType)) {
      throw new Error(`${item.role || 'reference_audio'}: ${contentType} is not supported by Seedance — attach an mp3 (convert the clip and re-attach).`);
    }
    const staged = await uploadLocalMediaToTos({
      ...tosConfig,
      localData: mediaUrl,
      localName: item?.[key]?.name || '',
      fallbackName: buildFallbackFileName(item.role || item.type, contentType),
      dataLabel: `${item.role || item.type} payload`,
    });
    stagedCount += 1;

    return {
      ...item,
      [key]: {
        ...(item[key] || {}),
        url: staged.signedUrl || staged.fetchUrl || staged.objectUrl,
      },
    };
  }));

  return {
    content: normalized,
    stagedCount,
    assetReferenceCount,
  };
}

async function seedanceHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { apiKey, baseUrl, ...payload } = req.body;

  const token = apiKey || process.env.MODELARK_API_KEY;
  if (!token) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  let endpoint;
  try {
    endpoint = baseUrl ? `${baseUrl}/contents/generations/tasks` : getEndpointUrl('video');
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (!payload.model) {
    return res.status(400).json({ error: "model is required — the canvas resolves it from MODELARK_MODEL_SEEDANCE / _FAST / _MINI in .env.local (see .env.example)." });
  }

  try {
    const normalizedPayload = { ...payload };
    const staged = await normalizeSeedanceContent(payload.content);
    normalizedPayload.content = staged.content;

    console.log('[seedance] content →', (staged.content || []).map((it, i) => {
      const u = it?.image_url?.url || it?.video_url?.url || it?.audio_url?.url || '';
      const scheme = u.startsWith('asset://') ? 'ASSET' : u.startsWith('http') ? 'http' : u.startsWith('data:') ? 'data' : (it?.type || '?');
      return `${i}:${it?.role === 'first_frame' ? 'firstframe' : scheme}`;
    }).join(' '));

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(normalizedPayload),
    });

    const data = await response.json();
    if (!response.ok) {
      const seedanceMsg = data?.error?.message
        || data?.message
        || (typeof data?.error === 'string' ? data.error : null)
        || `Seedance request failed (HTTP ${response.status})`;
      console.error(`[seedance] ${response.status} :: ${typeof seedanceMsg === 'string' ? seedanceMsg : JSON.stringify(seedanceMsg)}`, JSON.stringify(data).slice(0, 600));
      return res.status(response.status).json({ error: typeof seedanceMsg === 'string' ? seedanceMsg : JSON.stringify(seedanceMsg), details: data });
    }

    return res.status(200).json({
      ...data,
      localMediaStagedToTos: staged.stagedCount > 0,
      stagedMediaCount: staged.stagedCount,
      assetReferencesUsed: staged.assetReferenceCount > 0,
      assetReferenceCount: staged.assetReferenceCount,
    });
  } catch (error) {
    console.error('[seedance] crashed —', error?.message);
    return res.status(500).json({ error: error?.message || 'Request failed' });
  }
}

export default seedanceHandler;
