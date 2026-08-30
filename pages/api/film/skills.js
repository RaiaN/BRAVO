import fs from 'fs';
import path from 'path';

const SKILLS_DIR = path.join(process.cwd(), 'skills');

const readFront = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { front: {}, body: text };
  const front = {};
  const scalar = (k) => { const r = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1]); return r ? r[1].trim() : ''; };
  front.name = scalar('name');
  front.description = scalar('description');
  const list = /^\s*models:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(m[1]);
  front.models = list ? list[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean) : [];
  return { front, body: text };
};

export default function handler(req, res) {
  try {
    if (!fs.existsSync(SKILLS_DIR)) {
      return res.status(500).json({ error: `No skills directory at ${SKILLS_DIR}. The prompt specs live in skills/<id>/SKILL.md.` });
    }
    const skills = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const file = path.join(SKILLS_DIR, d.name, 'SKILL.md');
        if (!fs.existsSync(file)) return null;
        const text = fs.readFileSync(file, 'utf8');
        const { front } = readFront(text);
        return { id: d.name, name: front.name || d.name, description: front.description || '', models: front.models, text };
      })
      .filter(Boolean);
    return res.status(200).json({ skills });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
