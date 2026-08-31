import fs from 'fs';
import path from 'path';
import { validateRule } from '../../agents/director/rulebook';

const DIR = path.join(process.cwd(), 'rules');
const BOOK_BY_PREFIX = { CIN: 'cinematic.json', SCR: 'screenwriting.json' };

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  try {
    const { proposal, dryRun } = req.body || {};
    if (!proposal) return res.status(400).json({ error: 'a "proposal" is required' });
    const prefix = String(proposal.id || '').slice(0, 3);
    const bookFile = BOOK_BY_PREFIX[prefix];
    if (!bookFile) return res.status(422).json({ error: `rule id must start with ${Object.keys(BOOK_BY_PREFIX).join(' or ')}` });
    if (proposal.blocking) return res.status(422).json({ error: 'an approved proposal enters non-blocking; promotion to blocking is a later, separate signature' });
    if (proposal.provenance?.origin !== 'note' || !proposal.provenance.iteration || !proposal.provenance.note) {
      return res.status(422).json({ error: 'a learned rule must carry provenance: { origin: "note", iteration, note }' });
    }

    const rule = {
      id: proposal.id,
      title: proposal.title,
      statement: proposal.statement,
      class: proposal.class,
      appliesTo: proposal.appliesTo,
      blocking: false,
      provenance: proposal.provenance,
      status: proposal.class === 'judgment' ? 'active' : 'calibrating',
      ...(proposal.params ? { params: proposal.params } : {}),
      ...(proposal.failureKind ? { failureKind: proposal.failureKind } : {}),
    };
    validateRule(rule, 'proposal');

    const file = path.join(DIR, bookFile);
    if (!fs.existsSync(file)) return res.status(500).json({ error: `missing ${file}` });
    const book = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (book.rules.some((r) => r.id === rule.id)) return res.status(409).json({ error: `${rule.id} already exists — law is append-only, pick a fresh id` });

    if (dryRun) return res.status(200).json({ ok: true, wouldWrite: rule, book: bookFile, dryRun: true });

    book.rules.push(rule);
    fs.writeFileSync(file, JSON.stringify(book, null, 2) + '\n');
    return res.status(200).json({ ok: true, rule, book: bookFile, total: book.rules.length });
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }
}
