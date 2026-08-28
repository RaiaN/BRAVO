// PROMPT TEMPLATES — the machinery only. BRAVO starts with an empty catalogue: every
// template this app uses is authored here as it is built. Defaults live in
// DEFAULT_TEMPLATES; user edits ride in localStorage and win.
//
// A template is { agent, label, vars: ['{name}'], text }. renderTemplate substitutes the
// vars and collapses nothing else — text arrives at the model as written.

export const DEFAULT_TEMPLATES = {};

const STORAGE_KEY = 'film-agent-prompt-overrides';

const readOverrides = () => {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
};

const writeOverrides = (obj) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch { /* quota / private mode — non-fatal */ }
};

export const getTemplateText = (id) => {
  const overrides = readOverrides();
  if (typeof overrides[id] === 'string') return overrides[id];
  return DEFAULT_TEMPLATES[id]?.text || '';
};

export const isOverridden = (id) => typeof readOverrides()[id] === 'string';

export const setTemplateText = (id, text) => {
  const overrides = readOverrides();
  overrides[id] = text;
  writeOverrides(overrides);
};

export const resetTemplate = (id) => {
  const overrides = readOverrides();
  delete overrides[id];
  writeOverrides(overrides);
};

export const resetAllTemplates = () => writeOverrides({});

// Fill {placeholders} from vars; collapses the double-spaces left by empty vars
// without touching intentional newlines.
export const renderTemplate = (id, vars = {}) => {
  let text = getTemplateText(id);
  Object.keys(vars).forEach((key) => {
    text = text.split(`{${key}}`).join(vars[key] == null ? '' : String(vars[key]));
  });
  return text.replace(/[ \t]{2,}/g, ' ').trim();
};

// Grouped list for the in-app settings UI. Skips server-only templates (surface:
// 'service') — they belong to the headless Service API, not any canvas agent, so
// editing them here would do nothing.
export const templatesByAgent = () => {
  const groups = {};
  Object.entries(DEFAULT_TEMPLATES).forEach(([id, def]) => {
    if (def.surface === 'service') return;
    if (!groups[def.agent]) groups[def.agent] = [];
    groups[def.agent].push({ id, ...def });
  });
  return groups;
};
