export const SCHEMA_VERSION = 1;

const STORAGE_KEY = 'bravo:project';

let idCounter = 0;
export const newId = (prefix) => {
  idCounter += 1;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${idCounter.toString(36)}${rand}`;
};

export const makeShot = (fields = {}) => ({
  id: newId('shot'),
  parentId: null,
  title: '',
  prompt: '',
  model: null,
  refs: [],
  keyframes: [],
  duration: 'auto',
  resolution: null,
  ratio: null,
  seed: null,
  generateAudio: false,
  takes: [],
  stills: [],
  chosenTakeId: null,
  stale: false,
  ...fields,
});

export const makeBibleEntry = (fields = {}) => ({
  id: newId('bib'),
  name: '',
  role: 'character',
  plateUrl: null,
  assetId: null,
  notes: '',
  prompt: '',
  model: null,
  stills: [],
  refs: [],
  ...fields,
});

export const makeMessage = (fields = {}) => ({
  id: newId('msg'),
  at: new Date().toISOString(),
  role: 'user',
  text: '',
  tool: null,
  asset: null,
  ...fields,
});

export const makeThread = (fields = {}) => ({
  id: newId('thr'),
  kind: null,
  subjectId: null,
  title: '',
  messages: [],
  status: 'idle',
  draft: '',
  budget: { takesCap: 999, spentTakes: 0 },
  ...fields,
});

export const THREAD_KINDS = ['shot', 'edit', 'storyboard', 'bible', 'audio'];

export const makeProject = (title = 'Untitled film') => {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('prj'),
    title,
    createdAt: now,
    updatedAt: now,
    film: { shots: [] },
    bible: [],
    threads: [makeThread()],
    activity: [],
    look: { style: '', grade: '', notes: '' },
  };
};

export const shotById = (project, id) => (id ? project?.film?.shots?.find((s) => s.id === id) || null : null);
export const bibleEntryById = (project, id) => (id ? project?.bible?.find((b) => b.id === id) || null : null);
export const threadById = (project, id) => (id ? project?.threads?.find((t) => t.id === id) || null : null);

export const subjectOf = (project, thread) => {
  if (!thread) return null;
  if (thread.kind === 'bible') return bibleEntryById(project, thread.subjectId);
  return shotById(project, thread.subjectId);
};

export const threadForSubject = (project, subjectId) => (subjectId
  ? project?.threads?.find((t) => t.subjectId === subjectId) || null
  : null);

export const filmRows = (project) => {
  const shots = project?.film?.shots || [];
  const rows = [];
  let root = 0;
  const suffix = new Map();
  shots.forEach((shot, i) => {
    const parent = shot.parentId ? rows.find((r) => r.shot.id === shot.parentId) : null;
    let label;
    if (parent) {
      const taken = (suffix.get(parent.shot.id) || 0) + 1;
      suffix.set(parent.shot.id, taken);
      label = `${parent.label}${String.fromCharCode(97 + taken)}`;
    } else {
      root += 1;
      label = String(root).padStart(2, '0');
    }
    rows.push({ shot, n: i + 1, label, depth: parent ? 1 : 0 });
  });
  return rows;
};

export const STATES = {
  empty: { glyph: '○', label: 'empty' },
  working: { glyph: '⟳', label: 'working' },
  'needs-you': { glyph: '●', label: 'needs you' },
  settled: { glyph: '✓', label: 'settled' },
  stale: { glyph: '⚠', label: 'stale' },
};

export const stateOf = (project, thread) => {
  const subject = subjectOf(project, thread);
  if (thread && activeFor(project, thread.id).length) return 'working';
  if (subject?.stale) return 'stale';
  if (thread?.status === 'working') return 'working';
  if (thread?.status === 'needs-you') return 'needs-you';
  if (thread?.status === 'settled') return 'settled';
  return 'empty';
};

const hydrate = (raw, key) => {
  const broken = (what) => {
    throw new Error(`The saved film at "${key}" ${what}. It has NOT been overwritten.`);
  };
  if (!raw || typeof raw !== 'object') broken('is not a project');
  if (typeof raw.id !== 'string' || !raw.id) broken('has no id');
  if (!Array.isArray(raw.film?.shots)) broken('has no film');
  if (!Array.isArray(raw.threads)) broken('has no threads');
  return {
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    look: { style: '', grade: '', notes: '', ...(raw.look || {}) },
    bible: (Array.isArray(raw.bible) ? raw.bible : []).map((b) => makeBibleEntry(b)),
    activity: Array.isArray(raw.activity) ? raw.activity : [],
    film: { shots: raw.film.shots.map((sh) => makeShot(sh)) },
    threads: raw.threads.map((t) => makeThread({
      ...t,
      messages: (Array.isArray(t.messages) ? t.messages : []).map((m) => makeMessage(m)),
      budget: { takesCap: 4, spentTakes: 0, ...(t.budget || {}) },
    })),
  };
};

const KEY_INDEX = 'bravo:projects';
const KEY_OPEN = 'bravo:open';
const keyFor = (id) => `bravo:project:${id}`;

const readJSON = (key, fallback) => {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
};

const writeJSON = (key, value) => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { }
};

export const listProjects = () => {
  if (typeof window === 'undefined') return [];
  const ids = readJSON(KEY_INDEX, []);
  return ids
    .map((id) => {
      const p = readJSON(keyFor(id), null);
      if (!p) return null;
      const shots = p.film?.shots?.length || 0;
      const takes = (p.film?.shots || []).reduce((n, sh) => n + (sh.takes?.length || 0), 0);
      return { id, title: p.title || 'Untitled film', updatedAt: p.updatedAt, shots, takes };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
};

const indexAdd = (id) => {
  const ids = readJSON(KEY_INDEX, []);
  if (!ids.includes(id)) writeJSON(KEY_INDEX, [...ids, id]);
};

export const loadProject = (id = null) => {
  if (typeof window === 'undefined') return null;
  const want = id || readJSON(KEY_OPEN, null) || listProjects()[0]?.id;
  if (!want) return null;

  const key = keyFor(want);
  const raw = window.localStorage.getItem(key);
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The saved film at "${key}" could not be read (${err.message}). It has NOT been overwritten.`);
  }
  return hydrate(parsed, key);
};

export const saveProject = (project) => {
  if (typeof window === 'undefined' || !project) return;
  writeJSON(keyFor(project.id), project);
  indexAdd(project.id);
  writeJSON(KEY_OPEN, project.id);
};

export const deleteProject = (id) => {
  if (typeof window === 'undefined' || !id) return;
  try {
    window.localStorage.removeItem(keyFor(id));
    writeJSON(KEY_INDEX, readJSON(KEY_INDEX, []).filter((x) => x !== id));
    if (readJSON(KEY_OPEN, null) === id) window.localStorage.removeItem(KEY_OPEN);
  } catch { }
};

export const clearProject = () => {
  if (typeof window === 'undefined') return;
  try {
    readJSON(KEY_INDEX, []).forEach((id) => window.localStorage.removeItem(keyFor(id)));
    window.localStorage.removeItem(KEY_INDEX);
    window.localStorage.removeItem(KEY_OPEN);
    window.localStorage.removeItem(STORAGE_KEY);
  } catch { }
};

export const addActivity = (project, entry) => touch({
  ...project,
  activity: [...(project.activity || []), { startedAt: new Date().toISOString(), state: 'running', ...entry }],
});

export const patchActivity = (project, id, patch) => touch({
  ...project,
  activity: (project.activity || []).map((a) => (a.id === id ? { ...a, ...patch } : a)),
});

export const removeActivity = (project, id) => touch({
  ...project,
  activity: (project.activity || []).filter((a) => a.id !== id),
});

export const activeFor = (project, threadId) => (project?.activity || []).filter((a) => a.threadId === threadId && a.state === 'running');

export const projectSpend = (project) => (project?.threads || []).reduce((acc, t) => ({
  takes: acc.takes + (t.budget?.spentTakes || 0),
  cap: acc.cap + (t.budget?.takesCap || 0),
}), { takes: 0, cap: 0 });

export const touch = (project) => ({ ...project, updatedAt: new Date().toISOString() });

export const appendMessage = (project, threadId, message) => {
  const thread = threadById(project, threadId);
  if (!thread) return project;
  return touch({
    ...project,
    threads: project.threads.map((t) => (t.id === threadId
      ? { ...t, messages: [...t.messages, makeMessage(message)] }
      : t)),
  });
};

export const renameThreadSubject = (project, threadId, title) => {
  const thread = threadById(project, threadId);
  if (!thread) return project;
  const next = { ...project, threads: project.threads.map((t) => (t.id === threadId ? { ...t, title } : t)) };
  if (thread.kind === 'bible') {
    next.bible = project.bible.map((b) => (b.id === thread.subjectId ? { ...b, name: title } : b));
  } else {
    next.film = { shots: project.film.shots.map((s) => (s.id === thread.subjectId ? { ...s, title } : s)) };
  }
  return touch(next);
};

export const renameProject = (project, title) => touch({ ...project, title });

export const setLook = (project, look) => touch({ ...project, look: { ...project.look, ...look } });

export const setThreadDraft = (project, threadId, draft) => (threadById(project, threadId)
  ? { ...project, threads: project.threads.map((t) => (t.id === threadId ? { ...t, draft } : t)) }
  : project);

export const setThreadStatus = (project, threadId, status) => (threadById(project, threadId)
  ? touch({ ...project, threads: project.threads.map((t) => (t.id === threadId ? { ...t, status } : t)) })
  : project);

export const insertShot = (project, { afterId = null, parentId = null, fields = {}, modelSlot = null } = {}) => {
  const shot = makeShot({ model: modelSlot, ...fields, parentId });
  const shots = [...project.film.shots];
  const at = afterId ? shots.findIndex((s) => s.id === afterId) : -1;
  if (at >= 0) shots.splice(at + 1, 0, shot); else shots.push(shot);
  return { project: touch({ ...project, film: { shots } }), shot };
};

export const setShotFields = (project, shotId, fields) => (shotById(project, shotId)
  ? touch({ ...project, film: { shots: project.film.shots.map((s) => (s.id === shotId ? { ...s, ...fields, id: s.id } : s)) } })
  : project);

export const moveShot = (project, shotId, toIndex) => {
  const shots = [...project.film.shots];
  const from = shots.findIndex((s) => s.id === shotId);
  if (from < 0) return project;
  const to = Math.max(0, Math.min(shots.length - 1, toIndex));
  if (to === from) return project;
  const [moved] = shots.splice(from, 1);
  shots.splice(to, 0, moved);
  return touch({ ...project, film: { shots } });
};

export const removeShot = (project, shotId) => {
  const shot = shotById(project, shotId);
  if (!shot) return project;
  const shots = project.film.shots
    .filter((s) => s.id !== shotId)
    .map((s) => (s.parentId === shotId ? { ...s, parentId: shot.parentId } : s));
  return touch({
    ...project,
    film: { shots },
    threads: project.threads.map((t) => (t.subjectId === shotId ? { ...t, subjectId: null, status: 'idle' } : t)),
  });
};

export const setBibleFields = (project, entryId, fields) => (bibleEntryById(project, entryId)
  ? touch({ ...project, bible: project.bible.map((b) => (b.id === entryId ? { ...b, ...fields, id: b.id } : b)) })
  : project);

export const markCitationsStale = (project, entryId) => touch({
  ...project,
  film: {
    shots: project.film.shots.map((s) => (
      s.chosenTakeId && s.refs.some((r) => r.bibleEntryId === entryId) ? { ...s, stale: true } : s
    )),
  },
});

export const chooseTake = (project, shotId, takeId) => {
  const shot = shotById(project, shotId);
  if (!shot || !shot.takes.some((t) => t.id === takeId)) return project;
  return setShotFields(project, shotId, { chosenTakeId: takeId, stale: false });
};

export const latchThread = (project, threadId, kind, { subjectId = null, title = '', modelSlot = null, imageSlot = null } = {}) => {
  const thread = threadById(project, threadId);
  if (!thread) return { project, thread: null };
  if (thread.kind) return { project, thread };
  if (!THREAD_KINDS.includes(kind)) return { project, thread };

  let next = project;
  let subject = subjectId;

  if (!subject && kind === 'edit') {
    const shot = (next.film.shots || []).filter((sh) => sh.takes.length);
    subject = shot.length === 1 ? shot[0].id : null;
  }

  if (!subject && (kind === 'shot' || kind === 'storyboard')) {
    const slot = kind === 'storyboard' ? (imageSlot || modelSlot) : modelSlot;
    const made = insertShot(next, { fields: { title }, modelSlot: slot });
    next = made.project;
    subject = made.shot.id;
  }
  if (!subject && kind === 'bible') {
    const entry = makeBibleEntry({ name: title });
    next = touch({ ...next, bible: [...next.bible, entry] });
    subject = entry.id;
  }

  const latched = { ...threadById(next, threadId), kind, subjectId: subject, title };
  return {
    project: touch({ ...next, threads: next.threads.map((t) => (t.id === threadId ? latched : t)) }),
    thread: latched,
  };
};

export const addThread = (project) => {
  const thread = makeThread();
  return { project: touch({ ...project, threads: [...project.threads, thread] }), thread };
};

export const unlatchedThreads = (project) => (project?.threads || []).filter((t) => !t.kind);

