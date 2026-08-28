import { randomUUID } from 'crypto';
import { checkInBytes, CLOUD_MEDIA_PREFIX, mediaFileExists, mirrorKeyToTos } from '../../../utils/server/mediaStore';
import { getServerTosConfig, presignTosObject, headTosObject } from '../../../utils/server/tosUpload';

// The film suite's audio route — Seed Audio 1.0 via its OWN endpoint, /api/v3/tts/create
// (per the official HTTP guide): single X-Api-Key header, `text_prompt` is a PROMPT the
// model follows (ambience, multi-voice drama, SFX — not just verbatim TTS), optional
// references = a speaker voice id / up to 3 audio clips (@Audio1..N, ≤30s each) OR one
// reference image (scene mood), single JSON response with base64 audio (its `url` is
// temporary — 2h — so the bytes are decoded here and never depended on). The key stays
// server-side (BYTEPLUSVOICE_API_KEY).

// REQUIRED via env — no default region. Guarded at request time with a clear error.
const VOICE_HOST = (process.env.BYTEPLUSVOICE_BASE_URL || '').replace(/\/+$/, '');
const CREATE_ENDPOINT = `${VOICE_HOST}/api/v3/tts/create`;
const SEED_AUDIO_MODEL = process.env.MODELARK_MODEL_SEED_AUDIO || null; // REQUIRED via env

const MIME = { mp3: 'audio/mpeg', ogg_opus: 'audio/ogg', pcm: 'audio/pcm', wav: 'audio/wav' };

// A reference in ANY form the canvas holds → what tts/create accepts. URL ALWAYS
// (the /api/seedance doctrine — bytes never move through this route): a media-store
// url becomes a presigned projects/media/<sha> link, a remote signed url passes
// verbatim. Inline base64 exists ONLY for a data: payload, which has no hosted copy.
async function refToReference(ref, kind, what) {
  const s = String(ref || '');
  if (s.startsWith('data:')) {
    if (!s.startsWith(`data:${kind}/`)) throw new Error(`${what} must be ${kind} data (got ${s.slice(5, s.indexOf(';'))}).`);
    return { [`${kind}_data`]: s.slice(s.indexOf(',') + 1) };
  }
  const storeKey = (/[?&]key=([a-f0-9]{16,64}\.[a-z0-9]{1,5})/.exec(s) || [])[1];
  if (storeKey && s.includes('/api/film/media')) {
    const cfg = getServerTosConfig();
    const objectKey = `${CLOUD_MEDIA_PREFIX}/${storeKey}`;
    const head = await headTosObject({ ...cfg, objectKey }).catch(() => ({ exists: false }));
    if (!head.exists && mediaFileExists(storeKey)) {
      try { await mirrorKeyToTos(storeKey); } catch { /* presign check below reports honestly */ }
    }
    if (head.exists || mediaFileExists(storeKey)) {
      try { return { [`${kind}_url`]: presignTosObject({ ...cfg, objectKey }) }; } catch { /* fall through */ }
    }
    throw new Error(`${what}: media-store object ${storeKey} could not be presigned — check TOS credentials in .env.local, or re-check-in the asset.`);
  }
  if (/^https?:\/\//i.test(s)) return { [`${kind}_url`]: s };
  throw new Error(`${what}: unsupported reference url.`);
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '30mb' }, // inlined references (an image / up to 3 audio clips, base64) ride in the body
    responseLimit: false,              // 120s of audio as a data: url exceeds Next's 4MB default
  },
};

// Seed Audio 1.0 — one shot, one JSON. Success is the presence of `audio` (base64);
// if the service ever answers with only its temporary `url`, fetch THAT server-side
// immediately (it lapses in 2h) so the client still receives durable bytes.
async function createAudio(res, { token, text, voice, imageData, audioRefs, format, sampleRate, speechRate, loudnessRate, pitchRate }) {
  const prompt = String(text);
  if (prompt.length > 2048) {
    return res.status(400).json({ error: `Seed Audio prompts cap at 2048 characters (this one is ${prompt.length}) — split the script into shorter clips.` });
  }
  // The API forbids mixing audio references (a speaker id counts as one) with an image
  // reference — the UI enforces the choice, this is the backstop.
  const speaker = String(voice || '').trim();
  const clips = (Array.isArray(audioRefs) ? audioRefs : []).filter(Boolean);
  if ((speaker || clips.length) && imageData) {
    return res.status(400).json({ error: 'Seed Audio takes audio references (a voice id counts as one) OR a reference image, not both — clear one and re-run.' });
  }
  if (speaker && clips.length > 2) {
    return res.status(400).json({ error: 'Seed Audio takes at most 3 audio references and the voice id counts as one — drop a clip.' });
  }
  if (clips.length > 3) {
    return res.status(400).json({ error: 'Seed Audio takes at most 3 reference clips (@Audio1..@Audio3) — drop one and re-run.' });
  }
  const references = [];
  if (speaker) references.push({ speaker });
  try {
    // Reference order IS the prompt's @Audio1..N numbering — preserved as sent.
    for (let i = 0; i < clips.length; i += 1) {
      references.push(await refToReference(clips[i], 'audio', `Reference clip @Audio${i + 1}`));
    }
    if (imageData) references.push(await refToReference(imageData, 'image', 'The reference image'));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const body = {
    model: SEED_AUDIO_MODEL,
    text_prompt: prompt, // VERBATIM — the user's words are the prompt, no rewriting
    ...(references.length ? { references } : {}),
    audio_config: {
      format,
      sample_rate: sampleRate,
      speech_rate: speechRate,
      loudness_rate: loudnessRate,
      pitch_rate: pitchRate,
    },
    watermark: {},
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Seed Audio timed out after 120s')), 120000);
  let response;
  try {
    response = await fetch(CREATE_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Api-Key': token,
        'X-Api-Request-Id': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }

  const logId = response.headers.get('X-Tt-Logid') || '';
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    return res.status(502).json({ error: 'Seed Audio returned a non-JSON response', details: raw.slice(0, 300), logId });
  }
  if (!response.ok) {
    const hint = response.status === 403 ? ' — activate "Seed-Audio 1.0" in the BytePlus voice console (Settings → Activate) for this key.' : '';
    return res.status(response.status).json({ error: `${data?.message || `Seed Audio failed (HTTP ${response.status})`}${hint}`, details: { code: data?.code, logId } });
  }

  let audio = data?.audio ? Buffer.from(data.audio, 'base64') : null;
  if ((!audio || !audio.length) && data?.url) {
    const r = await fetch(data.url); // the 2h temp url — drained NOW, never stored
    if (r.ok) audio = Buffer.from(await r.arrayBuffer());
  }
  if (!audio || !audio.length) {
    return res.status(502).json({ error: data?.message || 'Seed Audio returned no audio', details: { code: data?.code, logId } });
  }

  // SOURCE-SIDE durability: the clip goes straight into the two-tier store (local +
  // TOS mirror) and the STABLE store url is what the client receives — no megabyte
  // base64 payload, no client-side check-in required. data: fallback if the store hiccups.
  let clipUrl = `data:${MIME[format] || 'audio/mpeg'};base64,${audio.toString('base64')}`;
  try { clipUrl = (await checkInBytes(audio, MIME[format] || 'audio/mpeg')).url; }
  catch (e) { console.warn('[film/audio] source check-in failed — falling back to data: url:', e.message); }

  return res.status(200).json({
    url: clipUrl,
    bytes: audio.length,
    duration: data?.duration,
    format,
    ...(speaker ? { voice: speaker } : {}),
    model: SEED_AUDIO_MODEL,
  });
}

export default async function filmAudioHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const {
    text,
    voice,
    format = 'mp3',
    sampleRate = 24000,
    speechRate = 0,
    loudnessRate = 0,
    pitchRate = 0,
    imageData,        // ONE reference image — data:, store or http url (scene mood)
    audioRefs,        // ≤3 reference clips — data:, store or http urls (@Audio1..N, order = numbering)
  } = req.body || {};

  const token = process.env.BYTEPLUSVOICE_API_KEY;
  if (!token) {
    return res.status(500).json({ error: 'BYTEPLUSVOICE_API_KEY is not configured in .env.local' });
  }
  if (!VOICE_HOST) {
    return res.status(500).json({ error: 'BYTEPLUSVOICE_BASE_URL is not configured — set it in .env.local (see .env.example).' });
  }
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });
  if (!SEED_AUDIO_MODEL) {
    return res.status(500).json({ error: 'MODELARK_MODEL_SEED_AUDIO is not configured — set it in .env.local (see .env.example).' });
  }
  try {
    return await createAudio(res, { token, text, voice, imageData, audioRefs, format, sampleRate, speechRate, loudnessRate, pitchRate });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Seed Audio request crashed' });
  }
}
