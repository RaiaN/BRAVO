import fs from 'fs';
import path from 'path';

const THREAD_ID = /^[a-z0-9_]+$/i;
const KIND = /^[a-z][a-z0-9.]{0,31}$/i;

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const { threadId, kind, at, data } = req.body || {};
  if (!THREAD_ID.test(String(threadId || ''))) return res.status(400).json({ error: 'threadId must be a plain id' });
  if (!KIND.test(String(kind || ''))) return res.status(400).json({ error: 'kind must be a short token' });

  const dir = path.join(process.cwd(), 'runs', threadId);
  const stepsDir = path.join(dir, 'steps');
  fs.mkdirSync(stepsDir, { recursive: true });

  const record = { at: at || new Date().toISOString(), kind, data };
  fs.appendFileSync(path.join(dir, 'trace.ndjson'), JSON.stringify(record) + '\n');

  const n = fs.readdirSync(stepsDir).length + 1;
  const name = `${String(n).padStart(4, '0')}-${kind.replace(/[^a-z0-9]+/gi, '-')}.json`;
  fs.writeFileSync(path.join(stepsDir, name), JSON.stringify(record, null, 1));

  return res.status(200).json({ ok: true, step: n });
}
