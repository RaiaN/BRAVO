import { DEFAULT_PERSONA, PLACEHOLDERS, withPersonaDefaults } from '../../agents/persona.js';
import { readAgentSettings, saveAgentSettings } from '../../agents/settings-store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const { config, revision } = readAgentSettings();
      return res.status(200).json({ persona: config.persona, revision, defaults: DEFAULT_PERSONA, placeholders: PLACEHOLDERS });
    }
    if (req.method === 'PUT') {
      const persona = withPersonaDefaults({ system: req.body?.system, review: req.body?.review, choice: req.body?.choice, receiptChoice: req.body?.receiptChoice });
      const current = readAgentSettings();
      const saved = await saveAgentSettings({ ...current.config, persona }, req.body?.revision ?? current.revision, { source: 'persona-api' });
      return res.status(200).json({ persona: saved.config.persona, revision: saved.revision });
    }
    res.setHeader('Allow', ['GET', 'PUT']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
