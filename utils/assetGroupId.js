export const ASSET_GROUP_ID_PATTERN = /^group-\d{10,}-[a-z0-9]+$/i;

export const isValidAssetGroupId = (value) => {
  return ASSET_GROUP_ID_PATTERN.test(String(value || '').trim());
};

export const generateAssetGroupId = () => {
  return `group-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export const getDefaultAssetGroupId = (value) => {
  const trimmed = String(value || '').trim();
  return isValidAssetGroupId(trimmed) ? trimmed : generateAssetGroupId();
};
