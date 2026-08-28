// Transport layer for the agent core.
//
// The core orchestration (operations.js) never calls the network directly — it
// calls a `client` with this interface: createBrowserClient() → the app's own
// /api/* routes (keys stay server-side, outputs check into the media store).
// Interface (all async):
//   generateImage({ prompt, referenceImages, size, model }) -> { url, prompt }
//   reason({ prompt, systemPrompt, images, video, modelId }) -> { content }
//   startVideo({ content, model, resolution, ratio, duration, generateAudio }) -> { taskId }
//   pollVideo({ taskId, intervalMs, timeoutMs }) -> { videoUrl }
//   generateSpeech({ text, imageData, audioRefs, format, sampleRate }) -> { url, bytes, duration }

// Pull a human-readable string out of an API error body (may nest under
// .error.message or .details). Never returns "[object Object]".
export const errMsg = (data, fallback) => {
  const cand = data?.error?.message
    || (typeof data?.error === 'string' ? data.error : null)
    || data?.details?.error?.message
    || (typeof data?.details === 'string' ? data.details : null)
    || data?.details?.message;
  if (typeof cand === 'string' && cand.trim()) return cand;
  if (data?.details) { try { return JSON.stringify(data.details); } catch { /* noop */ } }
  return fallback;
};

const POLL_INTERVAL_MS = 4000;
// Seedance has NO generation SLA — under load a task can sit queued for many minutes — so the
// client poll waits generously (30 min) before giving up rather than killing a still-live task.
const POLL_TIMEOUT_MS = 1800000;

// ---- Browser client: talks to the app's own Next.js API routes ----------------
// Used by the canvas (L4). Keeps the existing request shapes unchanged.

export const createBrowserClient = (apiKey) => ({
  async generateImage({ prompt, referenceImages, size, model, seed, optimizePrompt }) {
    const res = await fetch('/api/film/imagine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, prompt, referenceImages, size, model, seed, optimizePrompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(errMsg(data, `Image generation failed (HTTP ${res.status})`));
    return data;
  },

  async reason({ prompt, systemPrompt, images, video, modelId, reasoningEffort }) {
    const res = await fetch('/api/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, modelId, prompt, systemPrompt, images: images || [], video: video || undefined, reasoningEffort }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(errMsg(data, 'Reasoning request failed'));
    return data;
  },

  async startVideo({ content, model, resolution, ratio, duration, generateAudio, seed }) {
    // ratio and duration are OMITTED when falsy: a Seedance EDITING task (routed by the
    // prompt's wording) locks both to the source clip and REJECTS the request outright if
    // either is sent — `InvalidParameter.TaskTypeConstraint`.
    const body = { apiKey, model, content, resolution, generate_audio: !!generateAudio, watermark: false, return_last_frame: true };
    if (ratio) body.ratio = ratio;
    if (duration && duration !== 'auto') body.duration = Number(duration);
    if (seed != null && seed !== '') body.seed = Number(seed);
    const res = await fetch('/api/seedance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(errMsg(data, 'Seedance start failed'));
    const taskId = data.id || data.task_id;
    if (!taskId) throw new Error('Seedance did not return a task id');
    return { taskId };
  },

  async pollVideo({ taskId, intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS }) {
    const startedAt = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() - startedAt > timeoutMs) throw new Error('Seedance timed out');
      await new Promise((r) => setTimeout(r, intervalMs));
      // Server-key mode: NO auth header at all (an empty `Bearer ` header reaches the
      // route as the literal string "Bearer" and got forwarded to Ark → 401 loop).
      const res = await fetch(`/api/seedance-status?taskId=${encodeURIComponent(taskId)}`, {
        ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      });
      const data = await res.json();
      if (data.status === 'succeeded' && data.video_url) return { videoUrl: data.video_url, lastFrameUrl: data.last_frame_url || null, videoCacheUrl: data.video_cache_url || null, lastFrameCacheUrl: data.last_frame_cache_url || null };
      if (data.status === 'failed') throw new Error(data.error?.message || data.error || 'Seedance task failed');
    }
  },

  // Audio via the app's film audio route — Seed Audio 1.0 (prompt-driven; references =
  // up to 3 audio clips (@Audio1..N) OR one image). The BytePlus voice key lives
  // server-side (BYTEPLUSVOICE_API_KEY) — no apiKey rides along.
  async generateSpeech({ text, imageData, audioRefs, format, sampleRate }) {
    const res = await fetch('/api/film/audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, imageData, audioRefs, format, sampleRate }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(errMsg(data, `Speech generation failed (HTTP ${res.status})`));
    return data;
  },
});
