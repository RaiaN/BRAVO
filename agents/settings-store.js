import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_CONFIG, agentConfigProblems } from './config.js';
import { withPersonaDefaults } from './persona.js';
import { openJournal } from './journal.js';

export const configRevision = (config) => createHash('sha256').update(JSON.stringify(config)).digest('hex');
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

export const readAgentSettings = (root = process.cwd()) => {
  const file = path.join(root, 'looks', 'agents.json');
  let config;
  if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    config = structuredClone(DEFAULT_AGENT_CONFIG);
    const legacy = path.join(root, 'looks', 'persona.json');
    if (fs.existsSync(legacy)) config.persona = withPersonaDefaults(JSON.parse(fs.readFileSync(legacy, 'utf8')));
  }
  const problems = agentConfigProblems(config);
  if (problems.length) throw failure(`E-AGENT-CONFIG: ${problems.join('; ')}`, 500);
  return { config, revision: configRevision(config) };
};

// Both settings routes share this queue, including across Next's separate route bundles.
const QUEUE = Symbol.for('bravo.agent-settings.queue');
export const saveAgentSettings = (config, revision, { root = process.cwd(), source = 'agents-panel' } = {}) => {
  const task = async () => {
    const before = readAgentSettings(root);
    const journal = await openJournal({ dir: path.join(root, 'runs', 'agent-settings') });
    try {
      const problems = agentConfigProblems(config);
      if (problems.length || revision !== before.revision) {
        const error = problems.length ? problems.join('; ') : 'Agent settings changed since you loaded them. Reload saved settings before saving again.';
        await journal.write('settings.rejected', { source, revision, currentRevision: before.revision, error });
        throw failure(error, problems.length ? 400 : 409);
      }
      const nextRevision = configRevision(config);
      const intentId = await journal.intent('settings.save', { source, before: before.config, after: config, previousRevision: before.revision, revision: nextRevision });
      const file = path.join(root, 'looks', 'agents.json');
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = fs.openSync(temporary, 'wx');
        try {
          fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, file);
      } catch (err) {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        await journal.result(intentId, { error: err.message });
        throw err;
      }
      await journal.result(intentId, { status: 'saved', revision: nextRevision });
      return { config, revision: nextRevision };
    } finally { await journal.close(); }
  };
  const result = (globalThis[QUEUE] || Promise.resolve()).then(task, task);
  globalThis[QUEUE] = result.then(() => {}, () => {});
  return result;
};
