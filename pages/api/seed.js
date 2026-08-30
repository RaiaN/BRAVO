import { CONFIG } from '../../utils/config';
import { getModel } from '../../utils/film/suiteConfig';
import { storeKeyFromUrl, readStoreBytes } from '../../utils/server/mediaStore';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '200mb',
    },
  },
};

async function seedHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { prompt, apiKey, modelId, baseUrl, systemPrompt, images, video, reasoningEffort } = req.body;
  const imageList = Array.isArray(images) ? images : (images ? [images] : []);

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const token = apiKey || process.env.MODELARK_API_KEY || process.env.ARK_API_KEY;
  if (!token) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const endpointBase = baseUrl || CONFIG.API_BASE_URL;
  if (!endpointBase) return res.status(500).json({ error: 'MODELARK_API_BASE_URL is not configured — set it in .env.local (see .env.example).' });
  let resolvedModelId = modelId;
  if (!resolvedModelId) {
    try { resolvedModelId = getModel('reasoner'); } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const inlineImage = async (ref) => {
    if (typeof ref !== 'string') return ref;
    const storeKey = storeKeyFromUrl(ref);
    if (storeKey) {
      const { buffer, contentType } = await readStoreBytes(storeKey);
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    }
    if (!/^https?:\/\//i.test(ref)) return ref;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const resp = await fetch(ref, { signal: ctrl.signal });
      if (!resp.ok) {
        throw new Error(`Reference image could not be loaded (HTTP ${resp.status}). Generated images expire after ~24h — regenerate the plate, then try again.`);
      }
      const type = resp.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await resp.arrayBuffer());
      return `data:${type};base64,${buf.toString('base64')}`;
    } finally { clearTimeout(timer); }
  };

  try {
    const inlinedImages = await Promise.all(imageList.map(inlineImage));
    const isPro260328 = process.env.MODELARK_REASONER_PROTOCOL
      ? process.env.MODELARK_REASONER_PROTOCOL === 'responses'
      : resolvedModelId.startsWith('seed-2-0-pro');
    
    if (isPro260328) {
      const inputContent = [{ type: 'input_text', text: prompt }];
      inlinedImages.forEach(img => {
          inputContent.push({ type: 'input_image', image_url: img });
      });
      if (video) {
          inputContent.push({
              type: 'input_video',
              video_url: video
          });
      }

      const inputMessages = [];
      if (systemPrompt) {
          inputMessages.push({
              role: 'system',
              content: [{ type: 'input_text', text: systemPrompt }],
          });
      }
      inputMessages.push({ role: 'user', content: inputContent });

      const payload = {
          model: resolvedModelId,
          stream: false,
          input: inputMessages,
      };
      if (reasoningEffort && reasoningEffort !== 'low') {
        payload.thinking = { type: 'enabled' };
      }

      const responsesEndpoint = `${endpointBase}/responses`;
      const callResponses = (body) => fetch(responsesEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

      let response = await callResponses(payload);
      if (!response.ok && payload.thinking) {
        const firstErr = await response.text().catch(() => '');
        if (/thinking|reasoning/i.test(firstErr)) {
          console.warn(`[seed] thinking param rejected (${response.status}) — retrying without it. Reason: ${firstErr.slice(0, 400)}`);
          response = await callResponses({ model: payload.model, stream: payload.stream, input: payload.input });
        } else {
          let errData;
          try { errData = JSON.parse(firstErr); } catch { errData = { error: { message: firstErr.slice(0, 400) } }; }
          const apiMsg = errData?.error?.message || errData?.message || `Seed API error (${response.status})`;
          return res.status(response.status).json({ error: apiMsg, details: errData });
        }
      }

      const responseText = await response.text();
      let data;
      try { data = JSON.parse(responseText); } catch {
        return res.status(502).json({ error: 'API returned a non-JSON response', details: responseText.slice(0, 300) });
      }
      if (!response.ok) {
        const apiMsg = data?.error?.message
          || data?.message
          || (typeof data?.error === 'string' ? data.error : null)
          || `Seed API error (${response.status})`;
        return res.status(response.status).json({ error: apiMsg, details: data });
      }
      
      const outputItems = Array.isArray(data.output) ? data.output : [];
      const assistantText = outputItems
        .filter((item) => item?.type !== 'reasoning')
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim();
      const content = assistantText || (typeof data.output_text === 'string' ? data.output_text.trim() : '');
      if (!content) {
        console.warn('[seed] /responses returned no assistant text:', JSON.stringify(data).slice(0, 800));
        return res.status(502).json({ error: 'Reasoning model returned no assistant text', details: data });
      }

      return res.status(200).json({ content, raw: data });
    }

    const messages = [
      { role: 'system', content: systemPrompt || 'You are a helpful assistant.' }
    ];

    if (imageList.length > 0 || video) {
      const content = [{ type: 'text', text: prompt }];
      inlinedImages.forEach(img => {
        content.push({ type: 'image_url', image_url: { url: img } });
      });
      if (video) {
        content.push({ type: 'video_url', video_url: { url: video } });
      }
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: prompt });
    }

    const chatEndpoint = `${endpointBase}/chat/completions`;

    const response = await fetch(chatEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: resolvedModelId,
        messages: messages,
      }),
    });

    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); } catch {
      return res.status(502).json({ error: 'API returned a non-JSON response', details: responseText.slice(0, 300) });
    }
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Seed request failed', details: data });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(500).json({ error: 'No response text returned', details: data });
    }

    return res.status(200).json({ content });
  } catch (error) {
    const cause = [error.cause?.code, error.cause?.message].filter(Boolean).join(' ');
    return res.status(500).json({ error: 'Request failed', details: cause ? `${error.message} (${cause})` : error.message });
  }
}

export default seedHandler;
