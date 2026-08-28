// Reusable server-side final-cut assembly: download ordered shot URLs → concat with
// ffmpeg (re-encoding to a uniform spec so disparate Seedance clips join cleanly) →
// re-host to TOS → return a presigned (playable) URL + an asset id.
//
// Shared by the /api/film/stitch route (canvas) and the Auto Director run (Service
// API). ffmpeg comes from the bundled `ffmpeg-static` binary — no system install.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { uploadLocalMediaToTos } from '../../server/tosUpload';
import { storeKeyFromUrl, readStoreBytes } from '../../server/mediaStore';
import { registerAsset } from './registerAsset';

const runFfmpeg = (bin, args) => new Promise((resolve, reject) => {
  const proc = spawn(bin, args);
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
});

/**
 * Stitch ordered video URLs into one MP4, re-hosted to TOS.
 * @param {{ shots: string[], name?: string }} args
 * @returns {Promise<{ url: string, stableUrl: string, assetId: string|null, shots: number, size: number }>}
 */
export const stitchShots = async ({ shots, name }) => {
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new Error('shots[] (ordered video URLs) is required');
  }

  // ffmpeg-static ships a platform binary — no system install needed, but the
  // package must be added once (npm install ffmpeg-static).
  let ffmpegPath = null;
  try { ffmpegPath = (await import('ffmpeg-static')).default; } catch { ffmpegPath = null; }
  if (!ffmpegPath) {
    throw new Error('Video assembly is not available on the server. Install it once with:  npm install ffmpeg-static');
  }

  const accessKey = process.env.MODELARK_ASSET_ACCESS_KEY;
  const secretKey = process.env.MODELARK_ASSET_SECRET_KEY;
  const tosBucket = process.env.MODELARK_TOS_BUCKET;
  if (!accessKey || !secretKey || !tosBucket) {
    throw new Error('TOS storage is not configured on the server (.env.local).');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film-stitch-'));
  try {
    // 1. download each shot
    const files = [];
    for (let i = 0; i < shots.length; i += 1) {
      // Our own store urls read in-process (never fetch http://<self> — breaks behind proxies).
      const storeKey = storeKeyFromUrl(shots[i]);
      let buf;
      if (storeKey) {
        buf = (await readStoreBytes(storeKey)).buffer; // eslint-disable-line no-await-in-loop
      } else {
        const r = await fetch(shots[i]); // eslint-disable-line no-await-in-loop
        if (!r.ok) throw new Error(`Could not fetch shot ${i + 1} (HTTP ${r.status}). Generated shot URLs expire — re-run the step.`);
        buf = Buffer.from(await r.arrayBuffer()); // eslint-disable-line no-await-in-loop
      }
      const f = path.join(dir, `shot-${i}.mp4`);
      fs.writeFileSync(f, buf);
      files.push(f);
    }

    // 2. concat (re-encode to a uniform spec so mismatched clips join cleanly)
    const listFile = path.join(dir, 'list.txt');
    fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const outFile = path.join(dir, 'final.mp4');
    await runFfmpeg(ffmpegPath, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', outFile,
    ]);

    // 3. re-host to TOS, return a presigned (playable) URL
    const mp4 = fs.readFileSync(outFile);
    const dataUrl = `data:video/mp4;base64,${mp4.toString('base64')}`;
    const staged = await uploadLocalMediaToTos({
      accessKey,
      secretKey,
      tosBucket,
      tosRegion: process.env.MODELARK_TOS_REGION,
      tosEndpoint: process.env.MODELARK_TOS_ENDPOINT,
      tosObjectPrefix: process.env.MODELARK_TOS_OBJECT_PREFIX || 'film-agent/final',
      tosPublicBaseUrl: process.env.MODELARK_TOS_PUBLIC_BASE_URL || '',
      localData: dataUrl,
      localName: `${name || 'final-cut'}.mp4`,
      fallbackName: `final-${Date.now()}.mp4`,
      dataLabel: 'Final cut',
    });

    let assetId = null;
    try {
      assetId = await registerAsset({ accessKey, secretKey, url: staged.signedUrl || staged.objectUrl, name: `${name || 'Film'} — final cut`, assetType: 'Video' });
    } catch (err) {
      console.warn('[film/stitch] Assets API registration skipped:', err.message);
    }

    return {
      url: staged.signedUrl || staged.objectUrl, // browser-playable (presigned works on a private bucket)
      stableUrl: staged.objectUrl,
      assetId,
      shots: files.length,
      size: mp4.length,
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
};
