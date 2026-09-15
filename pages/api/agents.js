import { DEFAULT_AGENT_CONFIG, AGENT_FIELDS } from '../../agents/config.js';
import { readAgentSettings, saveAgentSettings } from '../../agents/settings-store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ ...readAgentSettings(), defaults: DEFAULT_AGENT_CONFIG, fields: AGENT_FIELDS });
    }
    if (req.method === 'PUT') {
      const saved = await saveAgentSettings(req.body?.config, req.body?.revision);
      return res.status(200).json(saved);
    }
    res.setHeader('Allow', ['GET', 'PUT']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
