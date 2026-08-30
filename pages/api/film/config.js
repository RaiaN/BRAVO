import { ROOT_CONFIG, resolveModelId } from '../../../utils/film/suiteConfig';
import { CONFIG } from '../../../utils/config';

export default function configHandler(req, res) {
  const models = {};
  const missing = [];
  Object.keys(ROOT_CONFIG.models).forEach((key) => {
    const id = resolveModelId(key);
    if (id) models[key] = id; else missing.push(key);
  });
  return res.status(200).json({
    models,
    missing,
    arkBaseUrl: CONFIG.API_BASE_URL || '',
    voiceBaseUrl: process.env.BYTEPLUSVOICE_BASE_URL || '',
    tosRegion: process.env.MODELARK_TOS_REGION || '',
    hasServerKey: !!(process.env.MODELARK_API_KEY || process.env.ARK_API_KEY),
  });
}
