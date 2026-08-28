// Extract the AUDIO TRACK of a rendered Take (or any board video) — the Take Viewer's
// 🎧 action. Returns the track as a base64 mp3 data URL (the canvas lands it as an
// audio clip node; the media store checks it into a real file seconds later), so a
// take's dialogue/ambience can ride as a Seedance reference or be auditioned alone.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { storeKeyFromUrl, readStoreBytes, checkInBytes } from '../../../utils/server/mediaStore';

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' }, responseLimit: false }, // a video URL in, a few MB of mp3 out
};

const runFfmpeg = (bin, args) => new Promise((resolve, reject) => {
  const proc = spawn(bin, args);
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
});

export default async function extractAudioHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url (the video URL) is required' });
  }

  let ffmpegPath = null;
  try { ffmpegPath = (await import('ffmpeg-static')).default; } catch { ffmpegPath = null; }
  if (!ffmpegPath) {
    return res.status(500).json({ error: 'Audio extraction unavailable', details: 'Install it once with: npm install ffmpeg-static' });
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film-audio-'));
  try {
    const inFile = path.join(dir, 'take.mp4');
    const storeKey = storeKeyFromUrl(url);
    if (storeKey) {
      // Our own store url — read it in-process (never fetch http://<self>).
      fs.writeFileSync(inFile, (await readStoreBytes(storeKey)).buffer);
    } else {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Could not fetch the video (HTTP ${r.status}). Generated URLs expire — re-render it.`);
      fs.writeFileSync(inFile, Buffer.from(await r.arrayBuffer()));
    }
    const outFile = path.join(dir, 'track.mp3');
    try {
      await runFfmpeg(ffmpegPath, ['-y', '-i', inFile, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', outFile]);
    } catch (err) {
      // A silent render has no audio stream — say so plainly instead of an ffmpeg dump.
      if (/does not contain any stream|Stream map|no streams|Output file is empty/i.test(err.message)) {
        return res.status(422).json({ error: 'This video has no audio track.' });
      }
      throw err;
    }
    // SOURCE-SIDE durability: store url out, base64 only as a fallback.
    let clipUrl;
    try { clipUrl = (await checkInBytes(fs.readFileSync(outFile), 'audio/mpeg')).url; }
    catch { clipUrl = `data:audio/mpeg;base64,${fs.readFileSync(outFile).toString('base64')}`; }
    return res.status(200).json({ url: clipUrl });
  } catch (error) {
    return res.status(500).json({ error: 'Audio extraction failed', details: error.message });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp cleanup is best-effort */ }
  }
}
