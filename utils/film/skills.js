// SKILLS LIBRARY — vendor prompt specs the agents send VERBATIM.
//
// A skill is one document (a model vendor's prompt-engineering spec) bound to one or
// more model slots. When a verb runs, the card's OWN model picks its skill and the whole
// document rides in the system prompt — no distillation, no paraphrase.
//
// Storage mirrors promptTemplates: DISK holds the defaults (.agents/skills/<id>/SKILL.md,
// served by /api/film/skills), localStorage holds the user's edits and their own skills.
// A disk skill can be overridden and reset; a user skill can be removed outright.

const STORAGE_KEY = 'film-agent-skills';

// Default bindings for skills whose SKILL.md carries no `models:` frontmatter — vendor
// docs shouldn't have to be edited to work here. A skill that declares its own models,
// or that the user has bound in the drawer, ignores this.
const DEFAULT_BINDING = {
  'sd25-pe': ['seedance25'],
};

// Disk skills, fetched once per session. Empty until hydrate() lands — a verb that runs
// before then simply sends no skill line, exactly like a model with no skill bound.
let diskSkills = [];
let hydrated = false;

const readStore = () => {
  if (typeof window === 'undefined') return { overrides: {}, models: {}, custom: [] };
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
    return { overrides: raw.overrides || {}, models: raw.models || {}, custom: raw.custom || [] };
  } catch { return { overrides: {}, models: {}, custom: [] }; }
};

const writeStore = (next) => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota — keep the session copy */ }
};

export const hydrateSkills = async () => {
  if (hydrated) return diskSkills;
  try {
    const r = await fetch('/api/film/skills');
    const j = await r.json();
    diskSkills = Array.isArray(j.skills) ? j.skills : [];
  } catch { diskSkills = []; }
  hydrated = true;
  return diskSkills;
};

// Every skill the library holds: disk first (in folder order), then the user's own.
// `text` and `models` resolve through the overrides, so what you see is what rides.
export const allSkills = () => {
  const { overrides, models, custom } = readStore();
  const fromDisk = diskSkills.map((s) => ({
    ...s,
    source: 'disk',
    text: typeof overrides[s.id] === 'string' ? overrides[s.id] : s.text,
    // The user's binding wins (an empty array is a deliberate UNBIND, not "unset");
    // then the file's own frontmatter; then the default map.
    models: Array.isArray(models[s.id]) ? models[s.id] : ((s.models || []).length ? s.models : (DEFAULT_BINDING[s.id] || [])),
    edited: typeof overrides[s.id] === 'string' || !!models[s.id],
  }));
  return [...fromDisk, ...custom.map((s) => ({ ...s, source: 'custom', edited: false }))];
};

export const skillById = (id) => allSkills().find((s) => s.id === id) || null;

// THE BINDING. EVERY skill that names this slot rides, in library order — a model can
// have both a methodology and a vendor prompt guide, and dropping one because another
// matched first would silently lose half the guidance. No match → empty.
export const skillsFor = (modelKey) => (modelKey
  ? allSkills().filter((s) => (s.models || []).includes(modelKey) && String(s.text || '').trim())
  : []);

// The line a verb sends. The document rides whole, fenced so the model can tell the spec
// apart from the instruction wrapped around it.
export const skillLineOf = (modelKey) => {
  const found = skillsFor(modelKey);
  if (!found.length) return '';
  const body = found.map((s) => `<<<SPEC name: ${s.name}\n${String(s.text).trim()}\nSPEC>>>`).join('\n\n');
  return `THE OFFICIAL PROMPT ${found.length === 1 ? 'SPEC' : 'SPECS'} for this model follow${found.length === 1 ? 's' : ''}, verbatim. ${found.length === 1 ? 'It OUTRANKS' : 'They OUTRANK'} any habit or general practice: where ${found.length === 1 ? 'it and this instruction disagree' : 'they and this instruction disagree'}, the spec wins. Follow ${found.length === 1 ? 'its' : 'their'} formulas, notation and checklists.\n\n${body}`;
};

// THE SKILL IS MANDATORY. A verb that would otherwise fall back to house doctrine
// stops instead and says which slot is unbound — a silently-degraded prompt is worse
// than a refused one. Hydrates first, so a call early in the session cannot fail merely
// because the library had not loaded yet.
export const requireSkillLine = async (modelKey) => {
  await hydrateSkills();
  const line = skillLineOf(modelKey);
  if (!line) throw new Error(`No skill is bound to "${modelKey}" — open Skills in the toolbar, add that model's prompt spec and bind it to this slot.`);
  return line;
};

export const setSkillText = (id, text) => {
  const store = readStore();
  const custom = store.custom.find((c) => c.id === id);
  if (custom) { custom.text = String(text || ''); writeStore(store); return; }
  writeStore({ ...store, overrides: { ...store.overrides, [id]: String(text || '') } });
};

export const setSkillModels = (id, list) => {
  const store = readStore();
  const custom = store.custom.find((c) => c.id === id);
  if (custom) { custom.models = [...(list || [])]; writeStore(store); return; }
  writeStore({ ...store, models: { ...store.models, [id]: [...(list || [])] } });
};

// Reset returns a DISK skill to the file on disk (text and binding both). A user skill
// has no default to return to — remove it instead.
export const resetSkill = (id) => {
  const store = readStore();
  const { [id]: _t, ...overrides } = store.overrides;
  const { [id]: _m, ...models } = store.models;
  writeStore({ ...store, overrides, models });
};

export const addSkill = ({ name = '', text = '', models = [] } = {}) => {
  const store = readStore();
  const base = String(name || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill';
  let id = base;
  let n = 2;
  while (store.custom.some((c) => c.id === id) || diskSkills.some((d) => d.id === id)) { id = `${base}-${n}`; n += 1; }
  const entry = { id, name: name || id, description: '', text: String(text || ''), models: [...models] };
  writeStore({ ...store, custom: [...store.custom, entry] });
  return entry;
};

export const removeSkill = (id) => {
  const store = readStore();
  writeStore({ ...store, custom: store.custom.filter((c) => c.id !== id) });
};

// Rough token estimate for the drawer — the cost of a skill is real and should be
// visible before it rides on every call.
export const skillTokens = (text) => Math.round(String(text || '').length / 4);
