import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { storeKeyFromUrl, readStoreBytes } from '../../../utils/server/mediaStore';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const GRAY = 64;

const run = (bin, args) => new Promise((resolve, reject) => {
  const proc = spawn(bin, args);
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.slice(-400)}`))));
});

export const scratchDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bravo-image-stats-'));

const materialize = async (url, dir) => {
  if (!dir) throw new Error('image-stats: materialize requires a scratch dir');
  const write = (buffer, ext) => {
    const file = path.join(dir, `source.${ext}`);
    fs.writeFileSync(file, buffer);
    return file;
  };
  const key = storeKeyFromUrl(url);
  if (key) return write((await readStoreBytes(key)).buffer, key.split('.').pop());
  const data = /^data:([^;,]+);base64,(.+)$/s.exec(String(url));
  if (data) return write(Buffer.from(data[2], 'base64'), data[1].split('/').pop());
  if (!/^https?:\/\//i.test(String(url))) throw new Error(`image-stats: ${JSON.stringify(url)} is neither a store url, a data url nor http(s)`);
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`image-stats: source fetch failed (HTTP ${resp.status})`);
  return write(Buffer.from(await resp.arrayBuffer()), 'bin');
};

let grayCounter = 0;
export const grayFrame = async (ffmpeg, file, w, h, dir) => {
  if (!dir) throw new Error(`image-stats: grayFrame ${w}x${h} requires a scratch dir`);
  grayCounter += 1;
  const out = path.join(dir, `gray-${w}x${h}-${process.pid}-${grayCounter}.raw`);
  await run(ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-y', out]);
  const bytes = fs.readFileSync(out);
  if (bytes.length < w * h) throw new Error(`image-stats: gray decode produced ${bytes.length} bytes for ${w}x${h}`);
  return bytes;
};

export const dhashOf = (bytes) => {
  let bits = '';
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      bits += bytes[row * 9 + col] < bytes[row * 9 + col + 1] ? '1' : '0';
    }
  }
  return bits;
};

export const lumaAndBlur = (bytes, w, h) => {
  let sum = 0;
  for (let i = 0; i < w * h; i += 1) sum += bytes[i];
  const meanLuma = sum / (w * h);
  const lap = [];
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      lap.push(4 * bytes[i] - bytes[i - 1] - bytes[i + 1] - bytes[i - w] - bytes[i + w]);
    }
  }
  const mean = lap.reduce((a, b) => a + b, 0) / lap.length;
  const blur = lap.reduce((a, b) => a + (b - mean) ** 2, 0) / lap.length;
  return { meanLuma: Math.round(meanLuma * 10) / 10, blur: Math.round(blur * 10) / 10 };
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'image-stats: "url" is required' });

  const ffprobe = require('ffprobe-static').path;
  const ffmpeg = require('ffmpeg-static');
  const dir = scratchDir();
  try {
    const file = await materialize(url, dir);
    const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', file]));
    const video = (probe.streams || []).find((s) => s.codec_type === 'video');
    if (!video || !video.width || !video.height) return res.status(422).json({ error: 'image-stats: no decodable picture' });
    const gray = await grayFrame(ffmpeg, file, GRAY, GRAY, dir);
    const hashFrame = await grayFrame(ffmpeg, file, 9, 8, dir);
    return res.status(200).json({ width: video.width, height: video.height, ...lumaAndBlur(gray, GRAY, GRAY), dhash: dhashOf(hashFrame) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
