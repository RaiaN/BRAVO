// Root settings for the agentic film suite — the single source of truth for how
// every agent behaves: which models they call, their default parameters, runtime
// timings, and (via promptTemplates) their prompts.

import {
  renderTemplate,
  getTemplateText,
  setTemplateText,
  resetTemplate,
  resetAllTemplates,
  isOverridden,
  DEFAULT_TEMPLATES,
  templatesByAgent,
} from './promptTemplates';

export const ROOT_CONFIG = {
  // NO BUILT-IN MODEL IDS. Every slot is configured via .env (MODELARK_MODEL_*, see
  // .env.example) or the request ERRORS with the exact variable to set — endpoint ids
  // are account-scoped, so a silent default would bill/break someone else's account.
  // The keys here define the SLOTS (enumeration for the config route + option lists).
  models: {
    seedream: null,      // Seedream 5.0 Lite image endpoint  (MODELARK_MODEL_SEEDREAM)
    seedreamPro: null,   // Seedream 5.0 Pro                  (MODELARK_MODEL_SEEDREAM_PRO)
    seedance: null,      // Seedance 2.0 video endpoint       (MODELARK_MODEL_SEEDANCE)
    seedanceFast: null,  // Seedance 2.0 Fast                 (MODELARK_MODEL_SEEDANCE_FAST)
    seedanceMini: null,  // Seedance 2.0 Mini                 (MODELARK_MODEL_SEEDANCE_MINI)
    seedance25: null,    // Seedance 2.5 — 30s takes, 50 refs  (MODELARK_MODEL_SEEDANCE_25)
    reasoner: null,      // Seed 2.0 Pro reasoner             (MODELARK_MODEL_REASONER)
  },
  runtime: {
    pollIntervalMs: 4000,    // Seedance task polling cadence
    timeoutMs: 360000,       // max wait for an async (video) task
    defaultImageSize: '2K',
    reasoningEffort: 'high', // Seed 2.0 Pro thinking depth for the heavy reasoning
                             // calls (plan, QC, style curation, brief). 'low' |
                             // 'medium' | 'high' | null (off). One-liner helpers
                             // override to 'low'.
  },
  // Per-agent default parameters (the headless equivalent of the UI's defaultSettings).
  defaults: {
    inspiration: { count: 6, size: '2K' },
    characterVariations: { count: 4, size: '2K', direction: '' },
    locationVariations: { count: 4, size: '2K', direction: '' },
    animate: {
      camera: 'slow push-in', lens: 'auto', focalLength: '35mm', aperture: 'f/2.8',
      // Quality bar: 10s @ 1080p per shot (was 5s @ 720p) — long enough to trim,
      // sharp enough to ship.
      duration: 10, resolution: '1080p', ratio: 'adaptive', generateAudio: true,
    },
  },
};

// ---- client-config override layer (localStorage; browser only) ----

const STORAGE_KEY = 'film-agent-suite-config';

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

const deepMerge = (base, override) => {
  if (!isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  Object.keys(override).forEach((k) => {
    out[k] = isObject(base?.[k]) && isObject(override[k]) ? deepMerge(base[k], override[k]) : override[k];
  });
  return out;
};

export const getClientConfig = () => {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
};

export const setClientConfig = (partial) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(deepMerge(getClientConfig(), partial)));
  } catch { /* non-fatal */ }
};

export const resetClientConfig = () => {
  if (typeof window !== 'undefined') {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
  }
};

// ---- deployment overrides (the customer-shipping layer) --------------------------
// Every model/endpoint id above is only a DEFAULT: a deployment remaps any slot with
// an env var (ids like ep-… are ACCOUNT-scoped — a customer's account has different
// ones). Server code reads the env directly; the browser can't see server env, so the
// canvas hydrates the same values once from GET /api/film/config (applyDeployModels).
export const MODEL_ENV_VARS = {
  seedream: 'MODELARK_MODEL_SEEDREAM',
  seedreamPro: 'MODELARK_MODEL_SEEDREAM_PRO',
  seedance: 'MODELARK_MODEL_SEEDANCE',
  seedanceFast: 'MODELARK_MODEL_SEEDANCE_FAST',
  seedanceMini: 'MODELARK_MODEL_SEEDANCE_MINI',
  seedance25: 'MODELARK_MODEL_SEEDANCE_25',
  reasoner: 'MODELARK_MODEL_REASONER',
};

let hydratedDeployModels = null; // client-side: set once from /api/film/config

export const applyDeployModels = (models) => {
  hydratedDeployModels = models && typeof models === 'object' ? { ...models } : null;
};

const deployModelLayer = () => {
  if (hydratedDeployModels) return hydratedDeployModels;
  const out = {};
  if (typeof process !== 'undefined' && process.env) {
    Object.entries(MODEL_ENV_VARS).forEach(([key, envVar]) => {
      const v = String(process.env[envVar] || '').trim();
      if (v) out[key] = v;
    });
  }
  return out;
};

// ---- resolver + accessors ----

// Resolve the effective config: ROOT ← deployment (env / hydrated) ← client ← per-call.
export const resolveConfig = (perCall = {}) => deepMerge(deepMerge(deepMerge(ROOT_CONFIG, { models: deployModelLayer() }), getClientConfig()), perCall || {});

// Non-throwing resolver (enumeration/config-route use): id or null.
export const resolveModelId = (key, perCall) => resolveConfig(perCall).models[key] || null;

// STRICT resolver: configured id or a clear error naming the env var. No fallbacks —
// an unconfigured slot must never silently ride another account's endpoint.
export const getModel = (key, perCall) => {
  const id = resolveModelId(key, perCall);
  if (!id) {
    throw new Error(`Model '${key}' is not configured — set ${MODEL_ENV_VARS[key] || 'its MODELARK_MODEL_* variable'} in .env.local (see .env.example).`);
  }
  return id;
};

// The Seedance (video) endpoints a SHOT card can shoot a take on. `key` indexes
// ROOT_CONFIG.models; the card stores the key in data.videoModel ('seedance' = default).
export const VIDEO_MODEL_OPTIONS = [
  { key: 'seedance25', label: 'Seedance 2.5 · 30s' },
  { key: 'seedance', label: 'Seedance 2.0' },
  { key: 'seedanceMini', label: 'Seedance 2.0 Mini' },
];

// The Seedream (image) models the Storyboard keyframes can render on. `key` indexes
// ROOT_CONFIG.models; agents store the key in settings/data.imageModel
// ('seedreamPro' = Pro = the suite-wide default; 'seedream' = Lite).
// Pro accepts up to 10 reference images; Lite is capped lower.
export const IMAGE_MODEL_OPTIONS = [
  { key: 'seedreamPro', label: 'Seedream 5.0 Pro' },
  { key: 'seedream', label: 'Seedream 5.0 Lite' },
];
// Per-slot IMAGE capability table — same contract as VIDEO_MODEL_TRAITS: behavior
// keys off traits, never off slot-name comparisons.
// keyframeSize: the storyboard-still render size — Pro caps the image AREA at
// 4,194,304 px (2048²), so its largest 16:9 is 2560×1440; Lite allows the full 2K 16:9.
const IMAGE_MODEL_TRAITS = {
  seedream: { refCap: 6, shortLabel: 'Lite', thinkingToggle: false, keyframeSize: '2848x1600' },
  seedreamPro: { refCap: 10, shortLabel: 'Pro', thinkingToggle: true, keyframeSize: '2560x1440' },
};
export const imageTraits = (key) => IMAGE_MODEL_TRAITS[key] || IMAGE_MODEL_TRAITS[imageModelKeyOf(key)] || IMAGE_MODEL_TRAITS.seedream;
export const IMAGE_REF_CAP = Object.fromEntries(Object.entries(IMAGE_MODEL_TRAITS).map(([k, t]) => [k, t.refCap]));
export const imageRefCap = (key) => imageTraits(key).refCap;
export const keyframeImageSize = (key) => imageTraits(key).keyframeSize;
// Clamp ANY size for the chosen image model: Lite passes through; for Pro an explicit
// 'WxH' over the area cap scales down to fit (aspect kept, snapped to multiples of 16),
// and a bare tier name ('2K'/'4K' — the model would pick its own, possibly over-cap,
// dimensions) becomes a safe explicit square. Used by cast plates + variations when
// the user routes them to Pro.
export const clampSizeForModel = (modelKey, size) => {
  if (modelKey !== 'seedreamPro') return size;
  const s = String(size || '').trim();
  const m = /^(\d+)[xX](\d+)$/.exec(s);
  if (!m) return '2048x2048';
  const w = Number(m[1]);
  const h = Number(m[2]);
  const MAX = 4194304; // 2048²
  if (!w || !h || w * h <= MAX) return s;
  const k = Math.sqrt(MAX / (w * h));
  const snap = (v) => Math.max(64, Math.floor((v * k) / 16) * 16);
  return `${snap(w)}x${snap(h)}`;
};

// PER-SLOT CAPABILITY TABLE — the ONE place a video slot's behavior is declared.
// Everything downstream (keyframe support, duration/resolution caps, prompt
// density) keys off these TRAITS, never off slot-name comparisons — a new slot
// is one entry here, zero call-site edits.
const VIDEO_MODEL_TRAITS = {
  seedance: {
    maxSeconds: 15,
    res: ['480p', '720p', '1080p', '4K'],
    resDefault: '1080p',
    keyframes: false,                 // 2.0 has NO first/last-frame control — refs are references, full stop
    refPrefix: '',                    // 2.0 cites references as "Image 1" — no sigil, no brackets
    overallBlock: false,              // no closing Overall-requirements section
    refCap: 30,                       // reference images per request
  },
  seedanceFast: {
    maxSeconds: 15,
    res: ['480p', '720p', '1080p', '4K'],
    resDefault: '1080p',
    keyframes: false,
    refPrefix: '',
    overallBlock: false,
    refCap: 30,
  },
  seedanceMini: {
    maxSeconds: 15,
    res: ['480p', '720p'],
    resDefault: '720p',
    keyframes: false,
    refPrefix: '',
    overallBlock: false,
    refCap: 30,
  },
  seedance25: {
    maxSeconds: 30,
    res: ['480p', '720p', '1080p'],
    resDefault: '720p',
    keyframes: true,                  // ordered first/last-frame anchors are real here
    refPrefix: '@',                   // 2.5 cites references as "@Image1"
    overallBlock: true,               // closes with the Overall-requirements section
    refCap: 30,
  },
};
export const videoTraits = (key) => VIDEO_MODEL_TRAITS[key] || VIDEO_MODEL_TRAITS[videoModelKeyOf(key)] || VIDEO_MODEL_TRAITS.seedance;
export const RES_BY_MODEL = Object.fromEntries(Object.entries(VIDEO_MODEL_TRAITS).map(([k, t]) => [k, t.res]));
export const resDefault = (model) => videoTraits(model).resDefault;
export const maxShotSeconds = (model) => videoTraits(model).maxSeconds;
// How THIS model cites an attached image. One speller, so the editor, the roster and
// the prompt verbs can never disagree about notation. Square brackets are gone.
export const imageTagOf = (model, n) => `${videoTraits(model).refPrefix}Image${videoTraits(model).refPrefix ? '' : ' '}${n}`;
// A SHOT card's length is either a NUMBER of seconds or 'auto'. 'auto' sends NO duration
// on the wire at all — the model runs the events as long as they take, which is what the
// Film button births; a number stays clamped to the endpoint's window.
export const AUTO_SECONDS = 'auto';
export const clampShotSeconds = (model, v) => (String(v) === AUTO_SECONDS
  ? AUTO_SECONDS
  : Math.min(maxShotSeconds(model), Math.max(5, Math.round(Number(v) || 10))));

// The DEFAULT video slot for a card that hasn't picked one: the FIRST CONFIGURED
// slot in preference order (2.5 leads when its env var is set). Env-driven — never
// a hardcoded model id, and an unconfigured slot is skipped, not silently used.
// With nothing configured the seedance slot key is returned so the shoot fails
// loudly with getModel's exact MODELARK_MODEL_SEEDANCE message.
const VIDEO_SLOT_PREFERENCE = ['seedance25', 'seedance', 'seedanceFast', 'seedanceMini'];
export const defaultVideoModelKey = () => VIDEO_SLOT_PREFERENCE.find((k) => resolveModelId(k)) || 'seedance';
export const videoModelKeyOf = (picked) => picked || defaultVideoModelKey();
// The image twin — one source for the default Seedream slot (no scattered literals).
const IMAGE_SLOT_PREFERENCE = ['seedreamPro', 'seedream'];
export const defaultImageModelKey = () => IMAGE_SLOT_PREFERENCE.find((k) => resolveModelId(k)) || 'seedreamPro';
export const imageModelKeyOf = (picked) => picked || defaultImageModelKey();
export const clampResolution = (model, res) => {
  const opts = RES_BY_MODEL[model] || RES_BY_MODEL.seedance;
  return opts.includes(res) ? res : resDefault(model);
};

export const getRuntime = (perCall) => resolveConfig(perCall).runtime;

export const getAgentDefaults = (agentId, perCall) => (resolveConfig(perCall).defaults || {})[agentId] || {};

// Prompts are part of the root settings; re-export the prompt API so suiteConfig
// is the single import surface for everything configurable.
export const renderPrompt = renderTemplate;
export {
  renderTemplate,
  getTemplateText,
  setTemplateText,
  resetTemplate,
  resetAllTemplates,
  isOverridden,
  DEFAULT_TEMPLATES,
  templatesByAgent,
};
