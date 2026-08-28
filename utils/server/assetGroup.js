import fs from 'fs';
import os from 'os';
import path from 'path';
import { isValidAssetGroupId } from '../assetGroupId';

// STABLE default asset group (server-side). Without this, every registration with
// MODELARK_ASSET_GROUP_ID unset minted a fresh `group-<now>-<rand>` name, hit
// "asset_group not found", and created it — one throwaway group PER REGISTRATION,
// littering the catalog. Resolution order:
//   1. a VALID MODELARK_ASSET_GROUP_ID env value — explicit override, untouched;
//   2. the id persisted from the first successful registration (this file);
//   3. nothing — the caller generates once, creates the group, and persists it here.
// The file lives next to the media store: one identity per machine, all projects.

const STORE_DIR = path.join(os.homedir(), '.modelark-starter-kit');
const GROUP_FILE = path.join(STORE_DIR, 'asset-group.json');

export const readPersistedAssetGroupId = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(GROUP_FILE, 'utf8'));
    return isValidAssetGroupId(parsed?.groupId) ? parsed.groupId : null;
  } catch {
    return null;
  }
};

export const persistAssetGroupId = (groupId) => {
  if (!isValidAssetGroupId(groupId)) return;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(GROUP_FILE, JSON.stringify({ groupId, savedAt: new Date().toISOString() }));
  } catch { /* best-effort — worst case the next registration re-persists */ }
};

export const getStableAssetGroupId = () => {
  const env = String(process.env.MODELARK_ASSET_GROUP_ID || '').trim();
  if (isValidAssetGroupId(env)) return env;
  return readPersistedAssetGroupId();
};
