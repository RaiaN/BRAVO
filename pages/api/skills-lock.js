import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  try {
    const file = path.join(process.cwd(), 'skills-lock.json');
    if (!fs.existsSync(file)) return res.status(200).json({ version: 1, skills: {} });
    return res.status(200).json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
