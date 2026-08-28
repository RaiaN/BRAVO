// Extract the FINAL frame of a rendered shot — the continuity enabler for the
// Filming Loop: the last frame of an approved chunk (plus the bible's cast
// anchors) seeds the next chunk's keyframe, so the world and faces carry over.
// Returns the frame as a base64 data URL (no storage dependency; it's a
// reference image, consumed immediately by the next generation).

import fs from 'fs';
import { storeKeyFromUrl, readStoreBytes, checkInBytes } from '../../../utils/server/mediaStore';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } }, // only a video URL comes in
};

const runFfmpeg = (bin, args) => new Promise((resolve, reject) => {
  const proc = spawn(bin, args);
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
});

export default async function lastFrameHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url (the shot video URL) is required' });
  }

  let ffmpegPath = null;
  try { ffmpegPath = (await import('ffmpeg-static')).default; } catch { ffmpegPath = null; }
  if (!ffmpegPath) {
    return res.status(500).json({ error: 'Frame extraction unavailable', details: 'Install it once with: npm install ffmpeg-static' });
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film-lastframe-'));
  try {
    const inFile = path.join(dir, 'shot.mp4');
    const storeKey = storeKeyFromUrl(url);
    if (storeKey) {
      // Our own store url — read it in-process (never fetch http://<self>).
      fs.writeFileSync(inFile, (await readStoreBytes(storeKey)).buffer);
    } else {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Could not fetch the shot (HTTP ${r.status}). Generated URLs expire — re-render the chunk.`);
      fs.writeFileSync(inFile, Buffer.from(await r.arrayBuffer()));
    }
    const outFile = path.join(dir, 'last.jpg');
    // Seek from the END (-sseof) and keep updating one image → the final frame.
    await runFfmpeg(ffmpegPath, ['-y', '-sseof', '-1', '-i', inFile, '-update', '1', '-frames:v', '1', '-q:v', '3', outFile]);
    // SOURCE-SIDE durability: store url out, base64 only as a fallback.
    let frameUrl;
    try { frameUrl = (await checkInBytes(fs.readFileSync(outFile), 'image/jpeg')).url; }
    catch { frameUrl = `data:image/jpeg;base64,${fs.readFileSync(outFile).toString('base64')}`; }
    return res.status(200).json({ url: frameUrl });
  } catch (error) {
    return res.status(500).json({ error: 'Last-frame extraction failed', details: error.message });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp cleanup is best-effort */ }
  }
}
