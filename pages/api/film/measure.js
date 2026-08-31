import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { storeKeyFromUrl, readStoreBytes } from '../../../utils/server/mediaStore';

export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

const run = (bin, args) => new Promise((resolve, reject) => {
  const proc = spawn(bin, args);
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.slice(-400)}`))));
});

const materialize = async (url) => {
  const key = storeKeyFromUrl(url);
  if (key) {
    const { buffer } = await readStoreBytes(key);
    const file = path.join(os.tmpdir(), `bravo-measure-${Date.now()}-${key}`);
    fs.writeFileSync(file, buffer);
    return { file, cleanup: () => fs.unlinkSync(file) };
  }
  if (!/^https?:\/\//i.test(String(url))) throw new Error(`measure: ${JSON.stringify(url)} is neither a store url nor http(s)`);
  const resp = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!resp.ok) throw new Error(`measure: source fetch failed (HTTP ${resp.status})`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const file = path.join(os.tmpdir(), `bravo-measure-${Date.now()}.bin`);
  fs.writeFileSync(file, buffer);
  return { file, cleanup: () => fs.unlinkSync(file) };
};

const dhash = async (ffmpeg, file, pick) => {
  const select = pick === 'last' ? ['-sseof', '-0.3'] : [];
  const out = path.join(os.tmpdir(), `bravo-hash-${Date.now()}-${pick}.rgb`);
  await run(ffmpeg, ['-v', 'error', ...select, '-i', file, ...(pick === 'last' ? ['-update', '1'] : ['-frames:v', '1']), '-vf', 'scale=9:8,format=gray', '-f', 'rawvideo', '-y', out]);
  const bytes = fs.readFileSync(out);
  fs.unlinkSync(out);
  if (bytes.length < 72) throw new Error(`measure: hash frame decode produced ${bytes.length} bytes`);
  let bits = '';
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      bits += bytes[row * 9 + col] < bytes[row * 9 + col + 1] ? '1' : '0';
    }
  }
  return bits;
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const { url, hashes } = req.body || {};
  if (!url) return res.status(400).json({ error: 'measure: "url" is required' });

  const ffprobe = require('ffprobe-static').path;
  const ffmpeg = require('ffmpeg-static');
  let mat;
  try {
    mat = await materialize(url);
    const probe = JSON.parse(await run(ffprobe, [
      '-v', 'error', '-count_frames',
      '-show_entries', 'stream=codec_type,avg_frame_rate,nb_read_frames,width,height',
      '-show_entries', 'format=duration',
      '-of', 'json', mat.file,
    ]));
    const video = (probe.streams || []).find((s) => s.codec_type === 'video');
    if (!video) return res.status(422).json({ error: 'measure: no video stream' });
    const [num, den] = String(video.avg_frame_rate || '0/1').split('/').map(Number);
    const fps = den ? num / den : 0;
    const nbReadFrames = Number(video.nb_read_frames || 0);
    const out = {
      duration: Number(probe.format?.duration || 0),
      nbReadFrames,
      fps: Math.round(fps * 1000) / 1000,
      width: video.width,
      height: video.height,
      hasAudio: (probe.streams || []).some((s) => s.codec_type === 'audio'),
    };
    if (hashes) {
      out.firstHash = await dhash(ffmpeg, mat.file, 'first');
      out.lastHash = await dhash(ffmpeg, mat.file, 'last');
    }
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    if (mat) { try { mat.cleanup(); } catch { } }
  }
}
