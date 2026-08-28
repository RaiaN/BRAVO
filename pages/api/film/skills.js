import fs from 'fs';
import path from 'path';

// SKILLS ON DISK. Every .agents/skills/<id>/SKILL.md is a skill — the FOLDER is the
// source of truth, so dropping a new vendor spec in makes it appear in the library with
// zero code changes. Frontmatter (name/description, and an optional `models:` list)
// rides through; a skill that names no model binds to nothing until the user picks one.
const SKILLS_DIR = path.join(process.cwd(), '.agents', 'skills');

// A deliberately small frontmatter reader: the two scalars we display plus the one list
// we bind on. Not a YAML parser — a skill that needs more can be edited in the drawer.
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
    if (!fs.existsSync(SKILLS_DIR)) return res.status(200).json({ skills: [] });
    const skills = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const file = path.join(SKILLS_DIR, d.name, 'SKILL.md');
        if (!fs.existsSync(file)) return null;
        // The WHOLE file rides, frontmatter included — the spec is the spec; slicing it
        // is the paraphrasing failure this library exists to end.
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
