import { CONFIG } from '../../../utils/config';
import { getModel } from '../../../utils/film/suiteConfig';
import { checkInBytes, storeKeyFromUrl, readStoreBytes } from '../../../utils/server/mediaStore';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
};

const fetchWithTimeout = async (url, opts = {}, ms = 120000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`Timed out after ${Math.round(ms / 1000)}s`)), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
};

export default async function imagineHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const {
    apiKey,
    baseUrl,
    prompt,
    referenceImage,
    referenceImages,
    size = '2K',
    model,
    seed,
    optimizePrompt,
  } = req.body || {};
  let seedreamModel = model;
  if (!seedreamModel) {
    try { seedreamModel = getModel('seedream'); } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const token = apiKey || process.env.MODELARK_API_KEY || process.env.ARK_API_KEY;
  if (!token) {
    return res.status(500).json({ error: 'API key not configured' });
  }
  if (!baseUrl && !CONFIG.API_BASE_URL) return res.status(500).json({ error: 'MODELARK_API_BASE_URL is not configured — set it in .env.local (see .env.example).' });
  const endpointBase = (baseUrl || CONFIG.API_BASE_URL).replace(/\/+$/, '');

  const rawRefs = []
    .concat(referenceImages || [])
    .concat(referenceImage ? [referenceImage] : [])
    .filter(Boolean);

  const inlineReference = async (ref) => {
    if (typeof ref !== 'string') return null;
    const storeKey = storeKeyFromUrl(ref);
    if (storeKey) {
      const { buffer, contentType } = await readStoreBytes(storeKey);
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    }
    if (!/^https?:\/\//i.test(ref)) return ref;
    const resp = await fetchWithTimeout(ref, {}, 30000);
    if (!resp.ok) {
      throw new Error(
        `Reference image could not be loaded (HTTP ${resp.status}). Generated images expire after ~24h — re-generate the keyframe, then try again.`,
      );
    }
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await resp.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  };

  try {
    const refs = await Promise.all(rawRefs.map(inlineReference));

    const body = {
      model: seedreamModel,
      prompt: String(prompt).trim(),
      size,
      watermark: false,
      response_format: 'url',
    };
    if (refs.length === 1) {
      body.image = refs[0];
    } else if (refs.length > 1) {
      body.image = refs;
    }
    if (seed != null && seed !== '') body.seed = Number(seed);
    if (optimizePrompt === true) {
      body.optimize_prompt = true;
      body.optimize_prompt_options = { thinking: 'enabled' };
    } else if (optimizePrompt === false) {
      body.optimize_prompt = true;
      body.optimize_prompt_options = { thinking: 'disabled' };
    }

    const response = await fetch(`${endpointBase}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      const seedreamMessage = data?.error?.message || data?.message || data?.error || `Image generation failed: ${response.status}`;
      console.error(
        `[film/imagine] Seedream ${response.status} — refs=${refs.length} size=${size} :: ${typeof seedreamMessage === 'string' ? seedreamMessage : JSON.stringify(seedreamMessage)}`,
        JSON.stringify(data).slice(0, 600),
      );
      return res.status(response.status).json({
        error: typeof seedreamMessage === 'string' ? seedreamMessage : JSON.stringify(seedreamMessage),
        details: data,
      });
    }
    const url = data?.data?.[0]?.url;
    if (!url) {
      return res.status(502).json({ error: 'No image URL in response' });
    }
    let cacheUrl = null;
    try {
      const imgResp = await fetch(url);
      if (imgResp.ok) {
        const buf = Buffer.from(await imgResp.arrayBuffer());
        cacheUrl = (await checkInBytes(buf, imgResp.headers.get('content-type') || 'image/jpeg')).url;
      }
    } catch (e) { console.warn('[film/imagine] source check-in failed:', e.message); }
    return res.status(200).json({ url, cacheUrl, prompt: body.prompt, size, model: seedreamModel });
  } catch (error) {
    console.error('[film/imagine] crashed —', error?.message, '::', (error?.stack || '').split('\n').slice(1, 3).join(' '));
    return res.status(500).json({ error: error?.message || 'Image generation crashed' });
  }
}
