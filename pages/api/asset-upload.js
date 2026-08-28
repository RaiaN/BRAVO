import { getDefaultTosPublicBaseUrl, uploadLocalMediaToTos } from '../../utils/server/tosUpload';
import { getDefaultAssetGroupId, isValidAssetGroupId } from '../../utils/assetGroupId';
import { getStableAssetGroupId, persistAssetGroupId } from '../../utils/server/assetGroup';
import { callAssetApi, getAssetApiConfig, sleep } from '../../utils/server/assetApi';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

async function pollAssetStatus({ accessKey, secretKey, assetId, projectName }) {
  const assetApiConfig = getAssetApiConfig();
  let lastResponse = null;
  for (let attempt = 1; attempt <= assetApiConfig.pollMaxAttempts; attempt += 1) {
    lastResponse = await callAssetApi({
      action: 'GetAsset',
      payload: {
        Id: assetId,
        ProjectName: projectName || 'default',
      },
      accessKey,
      secretKey,
    });

    const status = lastResponse?.Result?.Status;
    if (status === 'Active' || status === 'Failed') {
      return {
        attempts: attempt,
        done: true,
        response: lastResponse,
      };
    }

    await sleep(assetApiConfig.pollIntervalMs);
  }

  return {
    attempts: assetApiConfig.pollMaxAttempts,
    done: false,
    response: lastResponse,
  };
}

async function createAssetGroup({ accessKey, secretKey, projectName, assetGroupId }) {
  const response = await callAssetApi({
    action: 'CreateAssetGroup',
    payload: {
      Name: String(assetGroupId).trim(),
      Description: '',
      GroupType: 'AIGC',
      ProjectName: projectName || 'default',
    },
    accessKey,
    secretKey,
  });

  return response?.Result?.Id || String(assetGroupId).trim();
}

export default async function assetUploadHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const projectName = 'default';
  const {
    assetGroupId,
    assetType = 'Image',
    imageUrl,
    videoUrl,
    assetName,
    localImageData,
    localImageName,
    localVideoData,
    localVideoName,
    stageOnly = false,
    pollUntilReady = true,
  } = req.body || {};

  const isVideo = assetType === 'Video';
  const localMediaData = isVideo ? localVideoData : localImageData;
  const localMediaName = isVideo ? localVideoName : localImageName;
  const mediaUrl = isVideo ? videoUrl : imageUrl;

  const resolvedAccessKey = process.env.MODELARK_ASSET_ACCESS_KEY;
  const resolvedSecretKey = process.env.MODELARK_ASSET_SECRET_KEY;
  const resolvedTosBucket = process.env.MODELARK_TOS_BUCKET;
  const resolvedTosRegion = process.env.MODELARK_TOS_REGION;
  const resolvedTosEndpoint = process.env.MODELARK_TOS_ENDPOINT;
  const resolvedTosObjectPrefix = process.env.MODELARK_TOS_OBJECT_PREFIX;
  const resolvedTosPublicBaseUrl = process.env.MODELARK_TOS_PUBLIC_BASE_URL || '';
  const requestedAssetGroupId = String(assetGroupId || '').trim();
  // Stable-first: an explicit request wins, then env/persisted machine id; a fresh
  // name is generated only if this machine has never registered anything.
  const resolvedAssetGroupId = requestedAssetGroupId || getStableAssetGroupId() || getDefaultAssetGroupId(process.env.MODELARK_ASSET_GROUP_ID);

  if (!resolvedAccessKey || !resolvedSecretKey) {
    return res.status(400).json({
      error: 'Access key and secret key are not configured on the server. Set them in .env.local.',
    });
  }

  if (!mediaUrl && !localMediaData) {
    return res.status(400).json({ error: `Provide either a ${isVideo ? 'video' : 'image'} URL or a local file.` });
  }

  if (!stageOnly && requestedAssetGroupId && !isValidAssetGroupId(requestedAssetGroupId)) {
    return res.status(400).json({ error: 'Asset group id must match format group-{timestamp}-{random}.' });
  }

  try {
    let normalizedMediaUrl = String(mediaUrl || '').trim();
    let stagedUpload = null;

    if (normalizedMediaUrl) {
      if (!/^https?:\/\//i.test(normalizedMediaUrl)) {
        return res.status(400).json({ error: `${isVideo ? 'Video' : 'Image'} URL must be a publicly accessible http or https URL.` });
      }
    } else {
      if (!resolvedTosBucket) {
        return res.status(400).json({ error: 'TOS bucket is not configured on the server. Set it in .env.local.' });
      }

      stagedUpload = await uploadLocalMediaToTos({
        accessKey: resolvedAccessKey,
        secretKey: resolvedSecretKey,
        tosBucket: resolvedTosBucket,
        tosRegion: resolvedTosRegion,
        tosEndpoint: resolvedTosEndpoint,
        tosObjectPrefix: resolvedTosObjectPrefix,
        tosPublicBaseUrl: resolvedTosPublicBaseUrl,
        localData: localMediaData,
        localName: localMediaName,
        fallbackName: `asset-${Date.now()}.${isVideo ? 'mp4' : 'png'}`,
        dataLabel: `Local ${isVideo ? 'video' : 'image'} payload`,
      });
      normalizedMediaUrl = stagedUpload.fetchUrl || stagedUpload.objectUrl;
    }

    if (stageOnly) {
      return res.status(200).json({
        stagedOnly: true,
        imageUrl: normalizedMediaUrl,
        objectUrl: stagedUpload?.objectUrl || null,
        stagedFromLocalFile: Boolean(localMediaData),
        localMediaName: String(localMediaName || '').trim(),
        tos: localMediaData
          ? {
              bucket: resolvedTosBucket,
              region: resolvedTosRegion,
              endpoint: resolvedTosEndpoint,
              objectPrefix: resolvedTosObjectPrefix,
              publicBaseUrl: resolvedTosPublicBaseUrl || getDefaultTosPublicBaseUrl({ endpoint: resolvedTosEndpoint, bucket: resolvedTosBucket }),
            }
          : null,
      });
    }

    const createAssetPayload = {
      GroupId: resolvedAssetGroupId,
      URL: normalizedMediaUrl,
      AssetType: assetType,
      ...(assetName ? { Name: String(assetName).trim() } : {}),
      ProjectName: projectName || 'default',
    };

    let groupId = resolvedAssetGroupId;
    let groupCreated = false;
    let createAssetResponse;
    try {
      createAssetResponse = await callAssetApi({
        action: 'CreateAsset',
        payload: { ...createAssetPayload, GroupId: groupId },
        accessKey: resolvedAccessKey,
        secretKey: resolvedSecretKey,
      });
    } catch (error) {
      const message = String(error?.message || '');
      if (!/asset_group/i.test(message) || !/not found/i.test(message)) {
        throw error;
      }

      groupId = await createAssetGroup({
        accessKey: resolvedAccessKey,
        secretKey: resolvedSecretKey,
        projectName,
        assetGroupId: resolvedAssetGroupId,
      });
      groupCreated = true;
      createAssetResponse = await callAssetApi({
        action: 'CreateAsset',
        payload: { ...createAssetPayload, GroupId: groupId },
        accessKey: resolvedAccessKey,
        secretKey: resolvedSecretKey,
      });
    }
    // The group that WORKED becomes this machine's stable default (no-op churn fix:
    // future registrations reuse it instead of minting `group-<now>-<rand>` each time).
    if (createAssetResponse?.Result?.Id) persistAssetGroupId(groupId);

    const assetId = createAssetResponse?.Result?.Id;
    if (!assetId) {
      throw new Error('CreateAsset did not return an asset id');
    }

    let assetResponse = null;
    let pollSummary = { attempts: 0, done: false };

    if (pollUntilReady) {
      const pollResult = await pollAssetStatus({
        accessKey: resolvedAccessKey,
        secretKey: resolvedSecretKey,
        assetId,
        projectName,
      });
      assetResponse = pollResult.response;
      pollSummary = {
        attempts: pollResult.attempts,
        done: pollResult.done,
      };
    } else {
      assetResponse = await callAssetApi({
        action: 'GetAsset',
        payload: {
          Id: assetId,
          ProjectName: projectName || 'default',
        },
        accessKey: resolvedAccessKey,
        secretKey: resolvedSecretKey,
      });
    }

    return res.status(200).json({
      groupId,
      groupCreated,
      assetId,
      assetType,
      projectName: projectName || 'default',
      mediaUrl: normalizedMediaUrl,
      assetName: String(assetName || '').trim(),
      stagedFromLocalFile: Boolean(localMediaData),
      localMediaName: String(localMediaName || '').trim(),
      tos: localMediaData
        ? {
            bucket: resolvedTosBucket,
            region: resolvedTosRegion,
            endpoint: resolvedTosEndpoint,
            objectPrefix: resolvedTosObjectPrefix,
            publicBaseUrl: resolvedTosPublicBaseUrl || getDefaultTosPublicBaseUrl({ endpoint: resolvedTosEndpoint, bucket: resolvedTosBucket }),
          }
        : null,
      asset: assetResponse?.Result || null,
      poll: pollSummary,
      raw: {
        createAsset: createAssetResponse,
        getAsset: assetResponse,
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Asset upload failed',
      details: error.message,
    });
  }
}
