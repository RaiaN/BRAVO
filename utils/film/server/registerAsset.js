import { callAssetApi, getAssetApiConfig, sleep } from '../../server/assetApi';
import { getDefaultAssetGroupId } from '../../assetGroupId';
import { getStableAssetGroupId, persistAssetGroupId } from '../../server/assetGroup';

// Register a URL into the ModelArk Assets library → returns an assetId, usable as
// an asset:// reference (the trusted source for Seedance / Animate).
//
// IMPORTANT: the Assets backend DOWNLOADS the URL to ingest it, so the URL must be
// publicly fetchable. On a private TOS bucket the unsigned objectUrl 403s — pass a
// PRESIGNED GET URL (staged.signedUrl) instead. Once ingested, the asset:// id is
// permanent (the Assets store keeps its own copy), so the short-lived presigned
// URL only needs to last through ingestion.
//
// Shared by /api/film/upload (local uploads) and /api/film/preserve (check-in).

// Poll GetAsset until the asset finishes ingesting, so a freshly-registered
// asset:// is actually resolvable by Seedance. Best-effort + bounded.
async function waitForAssetActive({ accessKey, secretKey, assetId, projectName }) {
  let cfg;
  try { cfg = getAssetApiConfig(); } catch { return false; }
  const attempts = Math.min(cfg.pollMaxAttempts || 10, 15);
  const interval = cfg.pollIntervalMs || 2000;
  for (let i = 0; i < attempts; i += 1) {
    let resp;
    try {
      resp = await callAssetApi({
        action: 'GetAsset',
        payload: { Id: assetId, ProjectName: projectName || 'default' },
        accessKey,
        secretKey,
      });
    } catch {
      return false;
    }
    const status = resp?.Result?.Status;
    if (status === 'Active') return true;
    if (status === 'Failed') return false;
    await sleep(interval); // eslint-disable-line no-await-in-loop
  }
  return false;
}

export async function registerAsset({ accessKey, secretKey, url, name, assetType = 'Image', waitForActive = false }) {
  const projectName = 'default';
  // STABLE group: env override, else the persisted machine-wide id. Only the very
  // first registration ever generates a name (and persists the group it creates) —
  // previously this generated per CALL, minting one throwaway group per asset.
  const groupId = getStableAssetGroupId() || getDefaultAssetGroupId(process.env.MODELARK_ASSET_GROUP_ID);
  const payload = {
    GroupId: groupId,
    URL: url,
    AssetType: assetType,
    ProjectName: projectName,
    ...(name ? { Name: String(name).slice(0, 120) } : {}),
  };

  const create = async (gid) => callAssetApi({
    action: 'CreateAsset',
    payload: { ...payload, GroupId: gid },
    accessKey,
    secretKey,
  });

  let response;
  let usedGroupId = groupId;
  try {
    response = await create(groupId);
  } catch (err) {
    const msg = String(err?.message || '');
    if (/asset_group/i.test(msg) && /not found/i.test(msg)) {
      const group = await callAssetApi({
        action: 'CreateAssetGroup',
        payload: { Name: groupId, Description: '', GroupType: 'AIGC', ProjectName: projectName },
        accessKey,
        secretKey,
      });
      usedGroupId = group?.Result?.Id || groupId;
      response = await create(usedGroupId);
    } else {
      throw err;
    }
  }

  const assetId = response?.Result?.Id || null;
  if (assetId) persistAssetGroupId(usedGroupId); // the group that WORKED is the stable one
  if (assetId && waitForActive) {
    await waitForAssetActive({ accessKey, secretKey, assetId, projectName });
  }
  return assetId;
}
