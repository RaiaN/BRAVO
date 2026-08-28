import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { getServerTosConfig, hasServerTosConfig, putTosObject, downloadTosObject } from './tosUpload';

// CLOUD-FIRST content-addressed MEDIA STORE — the server-side LIBRARY behind every
// board asset's durability. Two tiers, one identity:
//   • TOS `projects/media/<sha256>.<ext>` — the SOURCE OF TRUTH (bucket-wide dedupe;
//     survives machines, reinstalls, everything);
//   • local `~/.modelark-starter-kit/media/<sha256>.<ext>` — a READ-THROUGH CACHE.
// Server code imports THESE functions (check-in at generation, direct reads for
// inlining/ffmpeg — never an HTTP hop to ourselves). The browser's window into the
// same store is the thin HTTP shell at /api/film/media (GET streams, POST checks in).
// The TOS mirror is best-effort at check-in: a cloud hiccup never blocks — the key
// lands in .unmirrored.json and the cloud-save reconciler tops it up.

const MEDIA_DIR = path.join(os.homedir(), '.modelark-starter-kit', 'media');
const UNMIRRORED_FILE = path.join(MEDIA_DIR, '.unmirrored.json');
export const CLOUD_MEDIA_PREFIX = 'projects/media';

const EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav' };
export const TYPE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' };

export const KEY_RE = /^[a-f0-9]{16,64}\.[a-z0-9]{1,5}$/i; // hash.ext only — nothing path-shaped

// ---- unmirrored ledger (keys whose TOS mirror failed; reconciled at cloud-save) ----
const readUnmirrored = () => {
  try { const v = JSON.parse(fs.readFileSync(UNMIRRORED_FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
};
const writeUnmirrored = (keys) => {
  try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); fs.writeFileSync(UNMIRRORED_FILE, JSON.stringify([...new Set(keys)])); } catch { /* ledger is best-effort */ }
};
export const markUnmirrored = (key) => writeUnmirrored([...readUnmirrored(), key]);
export const clearUnmirrored = (key) => writeUnmirrored(readUnmirrored().filter((k) => k !== key));
export const listUnmirrored = () => readUnmirrored();

// Mirror one store file to TOS (content-addressed key; no-op when already up).
export const mirrorKeyToTos = async (key, buf) => {
  const cfg = getServerTosConfig();
  if (!hasServerTosConfig(cfg)) return { mirrored: false, reason: 'TOS not configured' };
  const bytes = buf || fs.readFileSync(path.join(MEDIA_DIR, key));
  const ext = key.split('.').pop().toLowerCase();
  await putTosObject({ ...cfg, objectKey: `${CLOUD_MEDIA_PREFIX}/${key}`, buffer: bytes, contentType: TYPE_BY_EXT[ext] || 'application/octet-stream' });
  return { mirrored: true };
};

// Check BYTES into the two-tier store (local file + TOS mirror) → the stable store url.
export const checkInBytes = async (buf, contentType = '') => {
  const ctype = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = EXT_BY_TYPE[ctype] || 'bin';
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
  const key = `${hash}.${ext}`;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const file = path.join(MEDIA_DIR, key);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  try { const m = await mirrorKeyToTos(key, buf); if (m.mirrored) clearUnmirrored(key); else markUnmirrored(key); }
  catch { markUnmirrored(key); }
  return { key, url: `/api/film/media?key=${encodeURIComponent(key)}` };
};

// Check a SOURCE URL in (http(s) while it's alive, or a data: url whose base64 IS the
// bytes) — the fetch-then-check-in every producing route uses.
export const checkInUrl = async (url, { timeoutMs = 120000 } = {}) => {
  const src = String(url || '');
  if (!/^(https?:\/\/|data:)/.test(src)) throw new Error('an http(s) or data: url is required');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('source fetch timed out')), timeoutMs);
  let buf; let ctype;
  try {
    const resp = await fetch(src, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`source fetch failed (${resp.status})`);
    buf = Buffer.from(await resp.arrayBuffer());
    ctype = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  } finally { clearTimeout(timer); }
  if (!buf || !buf.length) throw new Error('source returned no bytes');
  // Fall back to the url's own extension when the content-type is unhelpful.
  const urlExt = (src.split('?')[0].split('.').pop() || '').toLowerCase();
  const knownType = EXT_BY_TYPE[ctype] ? ctype : (TYPE_BY_EXT[urlExt] || ctype);
  return { ...(await checkInBytes(buf, knownType)), contentType: knownType, size: buf.length };
};

export const mediaFilePath = (key) => path.join(MEDIA_DIR, key);
export const mediaFileExists = (key) => fs.existsSync(path.join(MEDIA_DIR, key));

// Drop one key from the LOCAL store (disk file + unmirrored ledger). TOS mirror
// deletion is the caller's job (cloud purge does reference-counting first — the
// store itself can't know which projects still use a shared, content-addressed key).
export const deleteStoreKey = (key) => {
  if (!KEY_RE.test(String(key || ''))) return false;
  const file = path.resolve(MEDIA_DIR, key);
  if (!file.startsWith(MEDIA_DIR + path.sep)) return false;
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* cache only — best effort */ }
  clearUnmirrored(key);
  return true;
};

// Extract a store key from ANY store-url shape (relative `/api/film/media?key=…` or an
// absolutized `http://host/api/film/media?key=…`). Null for non-store urls.
export const storeKeyFromUrl = (url) => {
  const m = /\/api\/film\/media\?key=([a-f0-9]{16,64}\.[a-z0-9]{1,5})\b/.exec(String(url || ''));
  return m ? m[1] : null;
};

// DIRECT in-process read-through (disk, else the TOS mirror + backfill). Server code
// calls THIS — never `fetch(http://<self>)`, which breaks behind https load balancers.
export const readStoreBytes = async (key) => {
  if (!KEY_RE.test(String(key || ''))) throw new Error('bad store key');
  const file = path.resolve(MEDIA_DIR, key);
  if (!file.startsWith(MEDIA_DIR + path.sep)) throw new Error('bad store key');
  if (!fs.existsSync(file)) {
    const cfg = getServerTosConfig();
    if (!hasServerTosConfig(cfg)) throw new Error('media not in the store (and no TOS mirror configured)');
    const { buffer } = await downloadTosObject({ ...cfg, objectKey: `${CLOUD_MEDIA_PREFIX}/${key}` });
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    fs.writeFileSync(file, buffer);
  }
  const ext = key.split('.').pop().toLowerCase();
  return { buffer: fs.readFileSync(file), contentType: TYPE_BY_EXT[ext] || 'application/octet-stream' };
};

// Ensure the file exists locally (read-through) and return its PATH — for ffmpeg-style
// consumers that want a file, not a buffer.
export const ensureStoreFile = async (key) => {
  await readStoreBytes(key);
  return mediaFilePath(key);
};
