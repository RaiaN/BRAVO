// THE AGENT REGISTRY — the only place that knows which agents exist.
//
// An agent is a MODULE: a closed description of one kind of work, with no knowledge of the
// turn engine and no way for the engine to know it specifically. Adding an agent is one
// file plus one `register()` call; the loop never changes. Removing one likewise.
//
// A module declares:
//   id          the thread kind it serves
//   title, job  what it is, in one line — the router reads `job` to choose between them
//   tools       its §4 row. The gate refuses anything outside it, so this IS its authority
//   system()    its system prompt
//   context()   the live facts it needs this turn (§4 thread memory)
//   latch()     how a thread of this kind acquires its one artifact (§4)
//   guards      optional extra output checks, run after the engine's own
//
// Enable/disable is real: a disabled agent is not offered to the router and refuses to run
// if a thread of its kind already exists. Nothing is silently substituted (§8).

const REQUIRED = ['id', 'title', 'job', 'tools', 'system', 'context'];

export const defineAgent = (mod) => {
  const missing = REQUIRED.filter((k) => mod[k] === undefined);
  if (missing.length) throw new Error(`agent "${mod.id || '?'}" is missing: ${missing.join(', ')}`);
  return {
    enabledByDefault: true,
    guards: [],
    latch: null,          // null = this kind needs no artifact of its own
    ...mod,
  };
};

const AGENTS = new Map();

export const register = (mod) => {
  if (AGENTS.has(mod.id)) throw new Error(`agent "${mod.id}" is already registered`);
  AGENTS.set(mod.id, mod);
  return mod;
};

// ---- enable / disable -------------------------------------------------------------
// Persisted per browser, like the skills library. A disabled agent is a deliberate
// absence, so the app says so rather than falling back to another one.

const STORAGE_KEY = 'bravo:agents';

// ONE override map: id → true | false. Effective state is `override ?? enabledByDefault`.
// The first version kept a "disabled" set and tried to express "off by default" through
// its absence, which made an off-by-default agent read as ON.
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
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* noop */ }
  }
};

// Test seam: the browser has localStorage, Node does not.
export const resetOverrides = () => { overrides = {}; };

// ---- lookup ------------------------------------------------------------------------
// An unknown or disabled kind resolves to NOTHING (§8) — never to a default agent.

export const agentFor = (id) => (id && isEnabled(id) ? AGENTS.get(id) || null : null);
export const allAgents = () => [...AGENTS.values()];
export const enabledAgents = () => allAgents().filter((a) => isEnabled(a.id));
export const knownKinds = () => allAgents().map((a) => a.id);

// Why a kind produced no agent — so the engine can say which of the two it was.
export const explainMissing = (id) => {
  if (!id) return 'this thread has no kind yet';
  if (!AGENTS.has(id)) return `there is no "${id}" agent in this build`;
  if (!isEnabled(id)) return `the ${id} agent is switched off — turn it on under More › Agents`;
  return null;
};

// Test seam only: lets a suite start from an empty registry.
export const _clear = () => AGENTS.clear();
