import { browserClient } from './client.js';

export const trace = (threadId, kind, data) => {
  if (!threadId || typeof fetch !== 'function') return;
  try {
    fetch('/api/trace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, kind, at: new Date().toISOString(), data }),
    }).then((res) => {
      if (!res.ok) console.warn(`trace dropped a ${kind} step (HTTP ${res.status}) — the run ledger is incomplete`);
    }).catch((err) => console.warn(`trace dropped a ${kind} step (${err.message}) — the run ledger is incomplete`));
  } catch (err) {
    console.warn(`trace dropped a ${kind} step (${err.message})`);
  }
};

export const traceMedia = (threadId, name, url) => {
  if (!threadId || !url || typeof fetch !== 'function') return;
  try {
    fetch('/api/trace-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, name, url }),
    }).then((res) => {
      if (!res.ok) console.warn(`trace-media dropped ${name} (HTTP ${res.status}) — the media ledger is incomplete`);
    }).catch((err) => console.warn(`trace-media dropped ${name} (${err.message})`));
  } catch (err) {
    console.warn(`trace-media dropped ${name} (${err.message})`);
  }
};

export const tracedClient = (threadId, apiKey) => {
  const raw = browserClient(apiKey);
  return {
    ...raw,
    reason: async (args) => {
      const t0 = Date.now();
      const out = await raw.reason(args);
      trace(threadId, 'reason', {
        modelId: args.modelId || null,
        systemPrompt: args.systemPrompt || null,
        prompt: args.prompt,
        images: (args.images || []).length,
        response: out.content,
        ms: Date.now() - t0,
      });
      return out;
    },
    generateImage: async (args) => {
      const t0 = Date.now();
      const out = await raw.generateImage(args);
      trace(threadId, 'render.image', { prompt: args.prompt, model: args.model || null, size: args.size || null, seed: args.seed ?? null, url: out.cacheUrl || out.url, ms: Date.now() - t0 });
      return out;
    },
    startVideo: async (args) => {
      const out = await raw.startVideo(args);
      trace(threadId, 'render.start', { model: args.model, content: args.content, resolution: args.resolution ?? null, ratio: args.ratio ?? null, duration: args.duration ?? null, generateAudio: !!args.generateAudio, seed: args.seed ?? null, taskId: out.taskId });
      return out;
    },
    pollVideo: async (args) => {
      const t0 = Date.now();
      const out = await raw.pollVideo(args);
      trace(threadId, 'render.done', { taskId: args.taskId, url: out.videoCacheUrl || out.videoUrl, lastFrameUrl: out.lastFrameCacheUrl || out.lastFrameUrl || null, ms: Date.now() - t0 });
      return out;
    },
  };
};
