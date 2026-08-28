// Extract frames at specific TIMESTAMPS from a board video — the Take Viewer's
// 📷 / ⏮ / 📝 backbone (exact playhead frame, first frame, the still the describe
// call reads). Each frame comes back as a base64 data URL; the canvas lands it as
// a normal image node and the media store checks it in seconds later.

import fs from 'fs';
import { storeKeyFromUrl, readStoreBytes, checkInBytes } from '../../../utils/server/mediaStore';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } }, // only a video URL + timestamps come in
};

const MAX_FRAMES = 30;

const runFfmpeg = (bin, args) => new Promise((resolve, reject) => {
  const proc = spawn(bin, args);
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
});

export default async function framesHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const { url, timestamps, maxWidth } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url (the Take video URL) is required' });
  // Optional downscale (poster thumbnails): a full-res frame painted at card size
  // makes the canvas re-rasterize megapixels on every zoom tick. Extract-to-board
  // callers omit it and keep full resolution.
  const w = Number(maxWidth);
  const scaleArgs = Number.isFinite(w) && w > 0 ? ['-vf', `scale='min(${Math.round(w)},iw)':-2`] : [];
  const ts = (Array.isArray(timestamps) ? timestamps : [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t >= 0)
    .slice(0, MAX_FRAMES);
  if (!ts.length) return res.status(400).json({ error: 'timestamps (array of seconds) is required' });

  let ffmpegPath = null;
  try { ffmpegPath = (await import('ffmpeg-static')).default; } catch { ffmpegPath = null; }
  if (!ffmpegPath) return res.status(500).json({ error: 'Frame extraction unavailable', details: 'Install it once with: npm install ffmpeg-static' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film-frames-'));
  try {
    const inFile = path.join(dir, 'take.mp4');
    const storeKey = storeKeyFromUrl(url);
    if (storeKey) {
      // Our own store url — read it in-process (never fetch http://<self>).
      fs.writeFileSync(inFile, (await readStoreBytes(storeKey)).buffer);
    } else {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Could not fetch the Take (HTTP ${r.status}). Generated URLs expire — re-render it.`);
      fs.writeFileSync(inFile, Buffer.from(await r.arrayBuffer()));
    }
    // One frame per timestamp (input-seek for speed; accurate enough on a local file).
    // Sequential on purpose — a handful of cheap grabs, no need to fan out N ffmpegs.
    const frames = [];
    for (let i = 0; i < ts.length; i += 1) {
      const t = ts[i];
      const outFile = path.join(dir, `f${i}.jpg`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await runFfmpeg(ffmpegPath, ['-y', '-ss', String(t), '-i', inFile, '-frames:v', '1', ...scaleArgs, '-q:v', '3', outFile]);
        // SOURCE-SIDE durability: the frame goes straight into the store — the client
        // receives a stable store url, never megabytes of base64 (data: fallback on hiccup).
        let frameUrl;
        try { frameUrl = (await checkInBytes(fs.readFileSync(outFile), 'image/jpeg')).url; } // eslint-disable-line no-await-in-loop
        catch { frameUrl = `data:image/jpeg;base64,${fs.readFileSync(outFile).toString('base64')}`; }
        frames.push({ t, url: frameUrl });
      } catch { /* skip a bad timestamp, keep the rest */ }
    }
    if (!frames.length) throw new Error('No frames could be extracted at the given timestamps.');
    return res.status(200).json({ frames });
  } catch (error) {
    return res.status(500).json({ error: 'Frame extraction failed', details: error.message });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
