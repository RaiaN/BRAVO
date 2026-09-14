import path from 'path';
import { loadPolicyValues } from '../../agents/director/policy';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  try {
    const loaded = loadPolicyValues(path.join(process.cwd(), 'policy', 'default.json'));
    return res.status(200).json({ values: loaded.values, hash: loaded.hash, file: 'policy/default.json' });
  } catch (err) {
    return res.status(500).json({ error: `the policy file refuses to load — the studio plans under no policy: ${err.message}` });
  }
}
