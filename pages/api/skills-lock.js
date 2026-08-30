import fs from 'fs';
import path from 'path';

// PROVENANCE. a bound spec outrank everything, so which document a slot carries —
// and where it came from — is load-bearing. skills-lock.json records the source and hash
// of every skill on disk; the Skills screen shows it so a vendor spec is never mistaken
// for something we wrote.
export default function handler(req, res) {
  try {
    const file = path.join(process.cwd(), 'skills-lock.json');
    if (!fs.existsSync(file)) return res.status(200).json({ version: 1, skills: {} });
    return res.status(200).json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
