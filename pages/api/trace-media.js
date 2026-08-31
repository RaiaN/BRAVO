import fs from 'fs';
import path from 'path';

const THREAD_ID = /^[a-z0-9_]+$/i;
const NAME = /^[a-z0-9][a-z0-9._-]{0,120}\.(png|jpg|jpeg|webp|mp4|webm|mov|wav|mp3)$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const { threadId, name, url } = req.body || {};
  if (!THREAD_ID.test(String(threadId || ''))) return res.status(400).json({ error: 'threadId must be a plain id' });
  if (!NAME.test(String(name || ''))) return res.status(400).json({ error: 'name must be a plain filename with a media extension' });
  if (!url) return res.status(400).json({ error: 'a source url is required' });

  const abs = String(url).startsWith('/')
    ? `http://${req.headers.host}${url}`
    : String(url);
  if (!/^https?:\/\//.test(abs)) return res.status(400).json({ error: 'url must be http(s) or app-relative' });

  const dir = path.join(process.cwd(), 'runs', threadId, 'media');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);

  const upstream = await fetch(abs);
  if (!upstream.ok) return res.status(502).json({ error: `source responded ${upstream.status} — the media was NOT saved` });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  fs.writeFileSync(file, bytes);
  return res.status(200).json({ ok: true, file: path.relative(process.cwd(), file), bytes: bytes.length });
}
