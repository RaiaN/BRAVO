// Pure agent operations — the orchestration IP. No canvas, no browser, no network:
// each takes typed input + ctx { client, config } and returns typed results.
// The canvas and the headless SDK both call these; only the injected `client`
// differs. Prompts/models resolve through suiteConfig (root ← client ← per-call).

import { renderTemplate, getModel, getRuntime, clampSizeForModel, clampShotSeconds, videoModelKeyOf, videoTraits, defaultImageModelKey } from '../suiteConfig';
import { withRetry } from './retry';

// Variation "axes" and styles are no longer hardcoded pools — the agentic
// planner (planPrompts, below) generates distinct, content-aware descriptors.

const clamp = (v, lo, hi, dflt) => Math.min(Math.max(Number(v) || dflt, lo), hi);

// ---- image batch (parallel, incremental) --------------------------------------

// `hooks` is EITHER a plain onItem function (back-compat: production.js / inspiration pass one)
// OR { onPlanned(specs), onItem(item, idx), onFail(idx, msg) } — the streaming form. The plan
// is known before any image renders, so onPlanned lets the canvas lay a PENDING placeholder per
// spec the moment planning finishes, then fill/fail each in place as the parallel batch resolves.
const runImagineBatch = async ({ specs, size, model }, ctx, hooks) => {
  const { onPlanned, onItem, onFail } = typeof hooks === 'function' ? { onItem: hooks } : (hooks || {});
  if (onPlanned) onPlanned(specs);
  const results = await Promise.allSettled(specs.map(async (spec, idx) => {
    try {
      // Transient Seedream errors (overload/429/timeouts) get backoff retries — the
      // batch runs in parallel, so without this one shed request = one lost image.
      const data = await withRetry(
        () => ctx.client.generateImage({ prompt: spec.prompt, referenceImages: spec.referenceImages, size, model }),
        { tries: 3, baseMs: 2500 },
      );
      const item = { url: data.url, cacheUrl: data.cacheUrl || null, prompt: data.prompt || spec.prompt, label: spec.label, referenceImages: spec.referenceImages || [], meta: spec.meta || {} };
      if (onItem) onItem(item, idx);
      return item;
    } catch (err) {
      if (onFail) onFail(idx, err?.message || 'failed');
      throw err;
    }
  }));
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message || 'failed');
  return { created: results.filter((r) => r.status === 'fulfilled').length, errors };
};

// ---- agentic prompt planner ---------------------------------------------------
// Seed 2.0 Pro plans N substantially-different, content-aware prompts (reading any
// reference images = describe+mix). Structured JSON; retries once, then throws —
// NO hardcoded fallback: creative exploration is fully agentic.
const parsePromptSet = (text) => {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const toItems = (val) => {
    const arr = Array.isArray(val) ? val : (val && typeof val === 'object' ? Object.values(val).find(Array.isArray) : null);
    return (arr || []).map((o) => {
      if (typeof o === 'string') return { label: o.slice(0, 48), prompt: o };
      const prompt = o?.prompt || o?.description || o?.text || '';
      return { label: String(o?.label || o?.title || o?.name || prompt).slice(0, 48), prompt: String(prompt) };
    }).filter((x) => x.prompt);
  };
  try { const i = toItems(JSON.parse(cleaned)); if (i.length) return i; } catch { /* */ }
  const m = cleaned.match(/[[{][\s\S]*[\]}]/);
  if (m) { try { const i = toItems(JSON.parse(m[0])); if (i.length) return i; } catch { /* */ } }
  return [];
};

export const planPrompts = async ({ task, count = 4, idea = '', direction = '', references = [], config } = {}, ctx) => {
  const n = clamp(count, 1, 12, 4);
  let items = [];
  let lastErr = null;
  // Each task selects its planner persona via creativePlanner.{task}.user/.system
  // (inspiration / characterVariations / locationVariations); an unknown task falls back to
  // the shared exploratory instruction (creativePlanner.user) + an empty system.
  const userVars = {
    idea: idea || '(none given)',
    direction: direction || '(your call — choose the most interesting dimensions)',
    count: n,
  };
  const userPrompt = renderTemplate(`creativePlanner.${task}.user`, userVars) || renderTemplate('creativePlanner.user', userVars);
  for (let attempt = 0; attempt < 2 && items.length < n; attempt += 1) {
    try {
      const { content } = await ctx.client.reason({
        prompt: userPrompt,
        systemPrompt: renderTemplate(`creativePlanner.${task}.system`, { count: n }),
        images: references,
        modelId: getModel('reasoner', config),
        reasoningEffort: getRuntime(config).reasoningEffort,
      });
      const parsed = parsePromptSet(content);
      if (parsed.length) items = parsed;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!items.length) throw new Error(`Creative planner returned no usable prompts${lastErr ? `: ${lastErr.message}` : ''}`);
  return items.slice(0, n);
};

// ---- agent operations ---------------------------------------------------------

// Inspiration: plan N distinct directions (reading selected refs = describe+mix),
// then render. `refs` are always read for ideas; `useRefsInGen` also feeds them to
// the image model as visual references.
export const inspiration = async ({ prompt, refs = [], useRefsInGen = false, count = 6, size = '2K', config } = {}, ctx, onItem) => {
  const n = clamp(count, 1, 12, 6);
  const items = await planPrompts({ task: 'inspiration', count: n, idea: prompt, references: refs, config }, ctx);
  const genRefs = useRefsInGen ? refs : [];
  const specs = items.map((it, i) => ({ prompt: it.prompt, referenceImages: genRefs, label: it.label || `Inspiration ${i + 1}`, meta: { planLabel: it.label } }));
  // Pro is the suite-wide default image model; its 2048² area cap clamps the size tier.
  return runImagineBatch({ specs, size: clampSizeForModel(defaultImageModelKey(), size), model: getModel(defaultImageModelKey(), config) }, ctx, onItem);
};

export const characterVariations = async ({ imageUrl, direction = '', count = 4, size = '2K', imageModel = defaultImageModelKey(), config } = {}, ctx, hooks) => {
  if (!imageUrl) throw new Error('characterVariations requires an imageUrl');
  const n = clamp(count, 1, 8, 4);
  const items = await planPrompts({ task: 'characterVariations', count: n, direction, references: [imageUrl], config }, ctx);
  // EDIT-LOCKED variations (the Edit-shot foundation): the source is [Image 1] and each
  // planned item is an INSTRUCTION — the edit grammar keeps identity/geometry pinned and
  // changes only what the instruction names (drift died with the re-compose approach).
  const SLOT = '@@EDIT@@';
  const specs = items.map((it, i) => ({
    prompt: renderTemplate('storyboard.frameEdit', { instruction: SLOT }).split(SLOT).join(String(it.prompt || '').slice(0, 2000)),
    referenceImages: [imageUrl], label: it.label || `Variation ${i + 1}`, meta: { planLabel: it.label, instruction: it.prompt },
  }));
  return runImagineBatch({ specs, size: clampSizeForModel(imageModel, size), model: getModel(imageModel, config) }, ctx, hooks);
};

export const locationVariations = async ({ imageUrl, direction = '', count = 4, size = '2K', imageModel = defaultImageModelKey(), config } = {}, ctx, hooks) => {
  if (!imageUrl) throw new Error('locationVariations requires an imageUrl');
  const n = clamp(count, 1, 8, 4);
  const items = await planPrompts({ task: 'locationVariations', count: n, direction, references: [imageUrl], config }, ctx);
  // Same edit-locked foundation: coverage = reframe instructions, states = change-only.
  const SLOT = '@@EDIT@@';
  const specs = items.map((it, i) => ({
    prompt: renderTemplate('storyboard.frameEdit', { instruction: SLOT }).split(SLOT).join(String(it.prompt || '').slice(0, 2000)),
    referenceImages: [imageUrl], label: it.label || `Coverage ${i + 1}`, meta: { planLabel: it.label, instruction: it.prompt },
  }));
  return runImagineBatch({ specs, size: clampSizeForModel(imageModel, size), model: getModel(imageModel, config) }, ctx, hooks);
};

// Compose the camera/lens preamble + motion into a single Seedance prompt.
export const buildAnimatePrompt = ({ motion, camera, lens, focalLength, aperture }) => {
  const notAuto = (v) => v && v !== 'auto';
  const cine = [
    notAuto(camera) && `Camera move: ${camera}`,
    notAuto(lens) && `Lens: ${lens}`,
    notAuto(focalLength) && `Focal length: ${focalLength}`,
    notAuto(aperture) && `Aperture: ${aperture} (control depth of field accordingly)`,
  ].filter(Boolean).join('. ');
  const motionText = (motion || '').trim();
  return [cine, motionText].filter(Boolean).join('. ');
};

// The dominant live failure mode: the OUTPUT-AUDIO policy rejects an otherwise
// good shot ("output audio may contain sensitive information").
// Callers catch this and retake the shot once with generateAudio:false — a silent
// shot beats a hole in the final cut.
export const isAudioPolicyError = (err) => /output audio may contain sensitive/i.test((err && err.message) || '');

// The OUTPUT-IMAGE content filter ("the output image may contain sensitive
// information") rejects a generated still. Like the audio filter it's an OUTPUT-side,
// PER-SAMPLE check — so a re-roll usually produces a different image that passes
// (softening the prompt helps stubborn cases). Drives the cast-plate + storyboard-
// frame retries so a flagged frame self-heals instead of leaving a blank card.
export const isImagePolicyError = (err) => /image may contain sensitive/i.test((err && err.message) || '');

// Kicks off the async video task; caller polls via ctx.client.pollVideo({ taskId }).
// Duration is HARD-CLAMPED to 5–15s (a SHOT's range; it breaks into cuts of ≤5–6s):
// a stale setting or stray LLM number can't push outside it, no matter the caller.
// Two source modes: a single imageUrl/assetId (the classic keyframe → first frame),
// or `refUrls` — SEVERAL real reference images (direct-to-video: the storyboard's
// cast/place assets, untouched, so the video model preserves the subjects itself).
export const animate = async ({ imageUrl, assetId, refUrls = [], refAssetIds = [], firstFrameUrl = null, audioRefUrls = [], videoRefUrls = [], motion, camera, lens, focalLength, aperture, duration = 10, resolution = '1080p', ratio = 'adaptive', generateAudio = true, seed = null, modelKey = null, config } = {}, ctx) => {
  modelKey = videoModelKeyOf(modelKey); // env-driven default — first CONFIGURED video slot, never a literal
  // Text-to-video is allowed: with no image / refs / first_frame, the PROMPT alone drives
  // it (the Story agent's continuous-shot film). Only fail when there's nothing at all.
  if (!imageUrl && !assetId && !refUrls.length && !firstFrameUrl && !String(motion || '').trim()) throw new Error('animate requires a prompt, imageUrl, assetId, refUrls or firstFrameUrl');
  // Duration cap comes from the slot capability table — never an inline literal. AUTO
  // stays AUTO all the way to the wire: startVideo then omits the field and the model
  // runs the events as long as they take (what a Film-born card asks for).
  duration = clampShotSeconds(modelKey, duration);
  const prompt = buildAnimatePrompt({ motion, camera, lens, focalLength, aperture });
  const content = [{ type: 'text', text: prompt }];
  // CONTINUITY: the previous shot's FINAL FRAME becomes the literal FIRST FRAME of this
  // video (role 'first_frame' — Seedance's "consecutive videos" pattern), so the shot
  // picks up EXACTLY where the last ended. Sent first, before the subject references.
  if (firstFrameUrl) content.push({ type: 'image_url', image_url: { url: firstFrameUrl }, role: 'first_frame' });
  // Reference images cap at the model's refCap trait — slice, never fail. A ref
  // WITH a portrait-library id
  // (refAssetIds, aligned by index) rides as image_asset_id (the TRUSTED asset://
  // path) so a photoreal person plate isn't screened as a raw url ("input image may
  // contain real person"); refs without an id (the clay frame, anything un-preserved)
  // stay image_url.
  if (refUrls.length) {
    refUrls.slice(0, videoTraits(modelKey).refCap).forEach((u, i) => {
      const aid = refAssetIds[i];
      if (aid) content.push({ type: 'image_asset_id', asset_id: aid, role: 'reference_image' });
      else content.push({ type: 'image_url', image_url: { url: u }, role: 'reference_image' });
    });
  } else if (assetId) content.push({ type: 'image_asset_id', asset_id: assetId, role: 'reference_image' });
  else if (imageUrl) content.push({ type: 'image_url', image_url: { url: imageUrl }, role: 'reference_image' });
  // else: text-to-video — the prompt is the only content (no reference media).
  // Reference AUDIO / VIDEO (plural; ≤15s each): the SHOT card's attached media —
  // music + voice clips the take realizes, camera/motion videos it follows, instead of
  // inventing its own. Audios BEFORE videos (the retake fallback's index math relies on
  // this order). data: urls are staged to TOS by /api/seedance.
  (audioRefUrls || []).filter(Boolean).forEach((u) => content.push({ type: 'audio_url', audio_url: { url: u }, role: 'reference_audio' }));
  (videoRefUrls || []).filter(Boolean).forEach((u) => content.push({ type: 'video_url', video_url: { url: u }, role: 'reference_video' }));
  // seed (sequence-level, optional): held constant across re-shoots it isolates the
  // prompt as the only changed variable; null lets the model roll its own each time.
  // Per-shot endpoint choice: the SHOT card may pick a variant (e.g. Seedance 2.0 Mini) by
  // modelKey; blank falls back to the env-preferred default slot, never a literal.
  const videoModel = getModel(videoModelKeyOf(modelKey), config);
  const { taskId } = await withRetry(
    () => ctx.client.startVideo({ content, model: videoModel, resolution, ratio, duration, generateAudio, seed }),
    { tries: 3, baseMs: 3000 },
  );
  return { taskId, prompt };
};

// The AUDIO agent's one operation (Seed Audio 1.0). The user's text goes out VERBATIM
// (no rewriting, no translation) — it IS the prompt the model follows (ambience /
// drama / SFX / speech); references = up to 3 audio clips (@Audio1..N in the prompt)
// OR one reference image for scene mood. Returns the clip url; the caller lands it.
export const generateFilmAudio = async ({ text, imageData, audioRefs } = {}, ctx) => {
  if (!String(text || '').trim()) throw new Error('The Audio agent needs the prompt first.');
  if (typeof ctx?.client?.generateSpeech !== 'function') throw new Error('This transport has no audio support yet (canvas/browser client only for now).');
  const out = await withRetry(
    () => ctx.client.generateSpeech({ text: String(text), imageData, audioRefs }),
    { tries: 2, baseMs: 2000 },
  );
  if (!out?.url) throw new Error('The audio engine returned no clip.');
  return out; // { url, bytes, duration, format, model }
};


