import { ROOT_CONFIG, resolveModelId } from '../../../utils/film/suiteConfig';
import { CONFIG } from '../../../utils/config';

// Deployment config for the canvas — IDENTIFIERS AND BOOLEANS ONLY, never key
// material. The browser hydrates its model table from this (env overrides are
// server-side; the client can't read them any other way), and `hasServerKey`
// switches the canvas into key-less mode (requests omit apiKey; routes fall back
// to the server-configured key).
export default function configHandler(req, res) {
  // NO fallbacks: only env-configured slots appear; the rest are listed in `missing`
  // so the client can say exactly which MODELARK_MODEL_* variable to set.
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
    tosRegion: process.env.MODELARK_TOS_REGION || '', // region name only — never key material
    hasServerKey: !!(process.env.MODELARK_API_KEY || process.env.ARK_API_KEY),
  });
}
