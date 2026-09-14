import fs from 'fs';
import path from 'path';
import { DEFAULT_PERSONA, PLACEHOLDERS, problemsIn } from '../../agents/persona.js';

const FILE = path.join(process.cwd(), 'looks', 'persona.json');

export default function handler(req, res) {
  if (req.method === 'GET') {
    if (!fs.existsSync(FILE)) return res.status(404).json({ error: 'looks/persona.json is missing', defaults: DEFAULT_PERSONA, placeholders: PLACEHOLDERS });
    return res.status(200).json({ persona: JSON.parse(fs.readFileSync(FILE, 'utf8')), defaults: DEFAULT_PERSONA, placeholders: PLACEHOLDERS });
  }
  if (req.method === 'PUT') {
    const persona = { system: req.body?.system, review: req.body?.review, choice: req.body?.choice };
    const problems = problemsIn(persona);
    if (problems.length) return res.status(400).json({ error: problems.join('; '), problems });
    fs.writeFileSync(FILE, `${JSON.stringify(persona, null, 2)}\n`);
    return res.status(200).json({ persona });
  }
  res.setHeader('Allow', ['GET', 'PUT']);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
