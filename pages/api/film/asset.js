import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const RECENT_FILE = path.join(os.homedir(), '.modelark-starter-kit', 'film-agent-recent.json');

const projectDirForId = (id) => {
  try {
    const list = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
    const entry = Array.isArray(list) ? list.find((e) => e && e.id === id && e.path) : null;
    return entry?.path || null;
  } catch {
    return null;
  }
};

const EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav' };
const TYPE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' };

const resolveAssetFile = (id, key) => {
  if (!id || !key || !/^[a-f0-9]{8,}\.[a-z0-9]{1,5}$/i.test(String(key))) return null;
  const dir = projectDirForId(String(id));
  if (!dir) return null;
  const assetsDir = path.resolve(dir, 'assets');
  const file = path.resolve(assetsDir, String(key));
  return file.startsWith(assetsDir + path.sep) ? { assetsDir, file } : null;
};

export const config = {
  api: {
    bodyParser: { sizeLimit: '60mb' },
    responseLimit: false,
  },
};

export default async function assetHandler(req, res) {
  try {
    if (req.method === 'GET') {
      const resolved = resolveAssetFile(req.query.id, req.query.key);
      if (!resolved) return res.status(400).json({ error: 'bad request' });
      if (!fs.existsSync(resolved.file)) return res.status(404).json({ error: 'not cached' });
      const ext = String(req.query.key).split('.').pop().toLowerCase();
      res.setHeader('Content-Type', TYPE_BY_EXT[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(resolved.file).pipe(res);
      return undefined;
    }

    if (req.method === 'POST') {
      const { id, url } = req.body || {};
      if (!id || !url || !/^(https?:\/\/|data:)/.test(String(url))) return res.status(400).json({ error: 'id and an http(s) or data: url are required' });
      const dir = projectDirForId(String(id));
      if (!dir) return res.status(404).json({ error: 'unknown project (not in recent store)' });

      const resp = await fetch(String(url));
      if (!resp.ok) return res.status(502).json({ error: `source fetch failed (${resp.status})` });
      const buf = Buffer.from(await resp.arrayBuffer());
      const ctype = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const urlExt = (String(url).split('?')[0].split('.').pop() || '').toLowerCase();
      const ext = EXT_BY_TYPE[ctype] || (/^[a-z0-9]{2,4}$/.test(urlExt) ? urlExt : 'bin');
      const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
      const key = `${hash}.${ext}`;

      const assetsDir = path.join(dir, 'assets');
      fs.mkdirSync(assetsDir, { recursive: true });
      const file = path.join(assetsDir, key);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buf);

      return res.status(200).json({ key, url: `/api/film/asset?id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}` });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: 'method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
