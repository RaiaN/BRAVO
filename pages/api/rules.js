import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'rules');
const FILES = ['cinematic.json', 'screenwriting.json', 'metrics.json'];

export default function handler(req, res) {
  try {
    if (!fs.existsSync(DIR)) {
      return res.status(500).json({ error: `No rules directory at ${DIR}. The rulebooks live in rules/*.json.` });
    }
    const out = {};
    for (const f of FILES) {
      const file = path.join(DIR, f);
      if (!fs.existsSync(file)) {
        return res.status(500).json({ error: `Missing ${file} — a director with half a rulebook refuses to plan.` });
      }
      out[f.replace('.json', '')] = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
