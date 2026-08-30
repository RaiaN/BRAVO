const REQUIRED = ['id', 'title', 'job', 'tools', 'system', 'context'];

export const defineAgent = (mod) => {
  const missing = REQUIRED.filter((k) => mod[k] === undefined);
  if (missing.length) throw new Error(`agent "${mod.id || '?'}" is missing: ${missing.join(', ')}`);
  return {
    enabledByDefault: true,
    guards: [],
    latch: null,
    ...mod,
  };
};

const AGENTS = new Map();

export const register = (mod) => {
  if (AGENTS.has(mod.id)) throw new Error(`agent "${mod.id}" is already registered`);
  AGENTS.set(mod.id, mod);
  return mod;
};

const STORAGE_KEY = 'bravo:agents';

let overrides = null;

const readOverrides = () => {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { return {}; }
};

const overrideMap = () => { if (!overrides) overrides = readOverrides(); return overrides; };

export const isEnabled = (id) => {
  const mod = AGENTS.get(id);
  if (!mod) return false;
  const o = overrideMap()[id];
  return typeof o === 'boolean' ? o : mod.enabledByDefault !== false;
};

export const setEnabled = (id, on) => {
  const map = { ...overrideMap(), [id]: !!on };
  overrides = map;
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { }
  }
};

export const resetOverrides = () => { overrides = {}; };

export const agentFor = (id) => (id && isEnabled(id) ? AGENTS.get(id) || null : null);
export const allAgents = () => [...AGENTS.values()];
export const enabledAgents = () => allAgents().filter((a) => isEnabled(a.id));
export const knownKinds = () => allAgents().map((a) => a.id);

export const explainMissing = (id) => {
  if (!id) return 'this thread has no kind yet';
  if (!AGENTS.has(id)) return `there is no "${id}" agent in this build`;
  if (!isEnabled(id)) return `the ${id} agent is switched off — turn it on under More › Agents`;
  return null;
};

export const _clear = () => AGENTS.clear();
