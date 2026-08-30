// THE DATA MODEL, plus load / save / migrate.
//
// One canonical film; threads reference it. Every function is pure over a plain JSON
// object, so the same model serialises to disk, to localStorage, or over the wire.
//
// NEVER SUBSTITUTE A DEFAULT: every lookup returns null for an id it does not know. Not
// the first item, not an empty stub. A caller that gets null must say so.

export const SCHEMA_VERSION = 1;

const STORAGE_KEY = 'bravo:project';

// ---- ids ------------------------------------------------------------------------
// Never an index: a shot's id is stable and its position derived, so the two can never
// be the same value.

let idCounter = 0;
export const newId = (prefix) => {
  idCounter += 1;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${idCounter.toString(36)}${rand}`;
};

// ---- constructors ---------------------------------------------------------------

export const makeShot = (fields = {}) => ({
  id: newId('shot'),
  parentId: null,
  title: '',
  prompt: '',            // the invariant: this IS the final prompt. Nothing wraps it.
  model: null,           // slot key — unset until chosen. No default.
  refs: [],              // ORDERED; position IS the citation number.
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
  // A plate is composed and rendered exactly like a shot is, so an entry carries the same
  // three things a render needs: the final prompt, the slot whose spec wrote it, and what
  // came back. Without these the bible agent has nothing to render and loops.
  prompt: '',
  model: null,
  stills: [],
  ...fields,
});

export const makeMessage = (fields = {}) => ({
  id: newId('msg'),
  at: new Date().toISOString(),
  role: 'user',
  text: '',
  tool: null,
  ...fields,
});

// A thread is born with no kind. The first message routes it, and the kind then LATCHES,
// which keeps "a thread owns exactly one artifact" true.
export const makeThread = (fields = {}) => ({
  id: newId('thr'),
  kind: null,            // null = not yet routed
  subjectId: null,       // a thread owns exactly ONE artifact, once latched
  title: '',
  messages: [],
  status: 'idle',
  draft: '',             // the half-typed message, per thread
  budget: { takesCap: 4, spentTakes: 0 },
  ...fields,
});

export const THREAD_KINDS = ['shot', 'edit', 'storyboard', 'bible', 'audio'];

// One blank thread, empty film. An empty film is legal — it is what a film looks like
// before anyone has spoken.
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
    activity: [],           // renders currently in flight — see ACTIVITY below
    look: { style: '', grade: '', notes: '' },   // standing facts every agent reads
  };
};

// ---- lookups (unknown id → null, always) ----------------------------------------

export const shotById = (project, id) => (id ? project?.film?.shots?.find((s) => s.id === id) || null : null);
export const bibleEntryById = (project, id) => (id ? project?.bible?.find((b) => b.id === id) || null : null);
export const threadById = (project, id) => (id ? project?.threads?.find((t) => t.id === id) || null : null);

// The artifact a thread owns. A `shot` thread's subject is a Shot, a `bible` thread's is
// a BibleEntry; `audio` and `edit` threads hang off a shot. An unknown subject is null —
// the pane says so instead of rendering someone else's shot.
export const subjectOf = (project, thread) => {
  if (!thread) return null;
  if (thread.kind === 'bible') return bibleEntryById(project, thread.subjectId);
  return shotById(project, thread.subjectId);
};

export const threadForSubject = (project, subjectId) => (subjectId
  ? project?.threads?.find((t) => t.subjectId === subjectId) || null
  : null);

// ---- derived: the film's order ---------------------------------------------------

// : `n` is the derived 1-based position — what the user says out loud. It is computed
// from the array on every read and stored nowhere, so reordering cannot desynchronise it.
//
// forks a shot as a SIBLING (03 → 03b, rendered indented under its parent) or as NEXT
// (03 → 04). So the number a row DISPLAYS is not always its position: a sibling wears its
// parent's number plus a letter. `label` carries that; `n` stays the literal position.
export const filmRows = (project) => {
  const shots = project?.film?.shots || [];
  const rows = [];
  let root = 0;
  const suffix = new Map();       // parent shot id → how many siblings have been labelled
  shots.forEach((shot, i) => {
    const parent = shot.parentId ? rows.find((r) => r.shot.id === shot.parentId) : null;
    let label;
    if (parent) {
      const taken = (suffix.get(parent.shot.id) || 0) + 1;
      suffix.set(parent.shot.id, taken);
      // 1 → b, 2 → c … the parent itself is the implicit "a".
      label = `${parent.label}${String.fromCharCode(97 + taken)}`;
    } else {
      root += 1;
      label = String(root).padStart(2, '0');
    }
    rows.push({ shot, n: i + 1, label, depth: parent ? 1 : 0 });
  });
  return rows;
};

// ---- derived: rail state ----------------------------------------------------
//
// | ○ | empty — no prompt yet                                          |
// | ⟳ | working — composing or rendering, with an ETA                  |
// | ● | needs you — a decision, an approval, or a choice between takes |
// | ✓ | settled — a chosen take, current with its inputs               |
// | ⚠ | stale — an input changed after the chosen take was rendered    |

export const STATES = {
  empty: { glyph: '○', label: 'empty' },
  working: { glyph: '⟳', label: 'working' },
  'needs-you': { glyph: '●', label: 'needs you' },
  settled: { glyph: '✓', label: 'settled' },
  stale: { glyph: '⚠', label: 'stale' },
};

// Staleness outranks everything: a chosen take whose input moved is wrong NOW, whatever
// the thread is doing about it.
export const stateOf = (project, thread) => {
  const subject = subjectOf(project, thread);
  // A render in flight outranks the stored status: it is the truest thing about the row.
  if (thread && activeFor(project, thread.id).length) return 'working';
  if (subject?.stale) return 'stale';
  if (thread?.status === 'working') return 'working';
  if (thread?.status === 'needs-you') return 'needs-you';
  if (thread?.status === 'settled') return 'settled';
  return 'empty';
};

// ---- persistence -----------------------------------------------------------------
//
// : "Persist as JSON per project." The browser store is the file for now; the shape on
// the wire is the shape in , so a later move to disk is a change of medium, not of
// model.

// Repair field by field rather than discard — a transcript is not worth throwing away
// because a field was added.
export const migrate = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const project = { ...raw };
  project.schemaVersion = SCHEMA_VERSION;
  project.id = project.id || newId('prj');
  project.title = typeof project.title === 'string' ? project.title : 'Untitled film';
  project.createdAt = project.createdAt || new Date().toISOString();
  project.updatedAt = project.updatedAt || project.createdAt;
  project.look = { style: '', grade: '', notes: '', ...(project.look || {}) };
  project.bible = Array.isArray(project.bible) ? project.bible.map((b) => makeBibleEntry(b)) : [];
  project.activity = Array.isArray(project.activity) ? project.activity : [];
  const shots = Array.isArray(project.film?.shots) ? project.film.shots : [];
  project.film = { shots: shots.map((s) => makeShot(s)) };
  const threads = Array.isArray(project.threads) ? project.threads : [];
  project.threads = threads.map((t) => makeThread({
    ...t,
    kind: THREAD_KINDS.includes(t.kind) ? t.kind : null,   // an unknown kind is unlatched, never guessed
    messages: Array.isArray(t.messages) ? t.messages.map((m) => makeMessage(m)) : [],
    budget: { takesCap: 4, spentTakes: 0, ...(t.budget || {}) },
  }));
  // An EMPTY FILM is legal — it is what a film looks like before anyone has spoken. But a
  // project with no thread cannot be talked to at all, so that one is repaired.
  if (!project.threads.length) project.threads.push(makeThread());

  // THE LOOP RUNS IN THE BROWSER, so a reload kills any turn that was in flight. A thread
  // left saying `working` would spin forever against nothing running. Reconcile it here,
  // and say so in the transcript — a visible report, not a silent reset.
  const stillRendering = new Set((project.activity || []).filter((a) => a.state === 'running').map((a) => a.threadId));
  project.threads = project.threads.map((t) => (t.status === 'working' && !stillRendering.has(t.id)
    ? {
      ...t,
      status: 'needs-you',
      messages: [...t.messages, makeMessage({
        role: 'agent',
        text: 'That turn was interrupted — the page reloaded while I was working. Nothing was lost. Say it again and I will pick it up.',
      })],
    }
    : t));

  return project;
};

// persists "as JSON per project", so each film is its own record and an index names
// them. The old single-project key is migrated in on first read and then retired.
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
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
};

// The films list: id, title and when it last changed. Derived from the records, so it can
// never claim a project that is not there.
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
  try {
    // One-time lift of the original single-project key.
    const legacy = window.localStorage.getItem(STORAGE_KEY);
    if (legacy) {
      const lifted = migrate(JSON.parse(legacy));
      if (lifted) {
        writeJSON(keyFor(lifted.id), lifted);
        indexAdd(lifted.id);
        writeJSON(KEY_OPEN, lifted.id);
      }
      window.localStorage.removeItem(STORAGE_KEY);
      if (!id) return lifted;
    }
    const want = id || readJSON(KEY_OPEN, null) || listProjects()[0]?.id;
    if (!want) return null;
    const raw = readJSON(keyFor(want), null);
    return raw ? migrate(raw) : null;
  } catch {
    return null;   // a corrupt store is not a crash; the caller starts a fresh project
  }
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
  } catch { /* noop */ }
};

export const clearProject = () => {
  if (typeof window === 'undefined') return;
  try {
    readJSON(KEY_INDEX, []).forEach((id) => window.localStorage.removeItem(keyFor(id)));
    window.localStorage.removeItem(KEY_INDEX);
    window.localStorage.removeItem(KEY_OPEN);
    window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* noop */ }
};

// ---- ACTIVITY: renders in flight -------------------------------------------------
//
// A Seedance take takes MINUTES, and the loop runs in the browser — so without this a
// render is invisible while it runs and lost entirely on reload. An activity entry is
// written the moment a task id comes back, BEFORE polling starts, so the work survives
// the tab closing: the task keeps running at Seedance and polling resumes on next load.
//
// the rail a fleet monitor showing `⟳` with an ETA. This is what it monitors.

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

// : project spend is visible from the rail.
export const projectSpend = (project) => (project?.threads || []).reduce((acc, t) => ({
  takes: acc.takes + (t.budget?.spentTakes || 0),
  cap: acc.cap + (t.budget?.takesCap || 0),
}), { takes: 0, cap: 0 });

// Every mutation goes through here so `updatedAt` can never drift from the content.
export const touch = (project) => ({ ...project, updatedAt: new Date().toISOString() });

// ---- mutations used by the shell -------------------------------------------------

export const appendMessage = (project, threadId, message) => {
  const thread = threadById(project, threadId);
  if (!thread) return project;          // unknown id → nothing happens
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
  : project);   // drafts do not bump updatedAt — typing is not a change to the film

export const setThreadStatus = (project, threadId, status) => (threadById(project, threadId)
  ? touch({ ...project, threads: project.threads.map((t) => (t.id === threadId ? { ...t, status } : t)) })
  : project);

// ---- shots -----------------------------------------------------------------------

// Insert a shot into the film. `afterId` places it directly after that shot (fork-as-next
// at M7); absent, it lands at the end. `parentId` records a fork and is what makes a
// row render indented under its parent.
// `modelSlot` is recorded ON THE SHOT when it is created, visible and changeable, rather
// than resolved at send time. substituting a default when something is sent;
// choosing one explicitly at creation is the opposite of that — the choice is in the data
// where you can see it and `write` can change it.
export const insertShot = (project, { afterId = null, parentId = null, fields = {}, modelSlot = null } = {}) => {
  const shot = makeShot({ model: modelSlot, ...fields, parentId });
  const shots = [...project.film.shots];
  const at = afterId ? shots.findIndex((s) => s.id === afterId) : -1;
  if (at >= 0) shots.splice(at + 1, 0, shot); else shots.push(shot);
  return { project: touch({ ...project, film: { shots } }), shot };
};

// the invariant: `prompt` is the final prompt — this sets fields, it never compiles one.
// An unknown id changes nothing.
export const setShotFields = (project, shotId, fields) => (shotById(project, shotId)
  ? touch({ ...project, film: { shots: project.film.shots.map((s) => (s.id === shotId ? { ...s, ...fields, id: s.id } : s)) } })
  : project);

// the invariant: refs order IS the citation numbering, so moving a shot NEVER rewrites
// prompt text to compensate. Position is data; the prompt is untouched.
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

// Removing a shot orphans anything forked from it. Re-parent the children onto the
// removed shot's own parent rather than dropping them — a fork is somebody's thinking.
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

export const chooseTake = (project, shotId, takeId) => {
  const shot = shotById(project, shotId);
  if (!shot || !shot.takes.some((t) => t.id === takeId)) return project;   // unknown → nothing
  return setShotFields(project, shotId, { chosenTakeId: takeId, stale: false });
};

// ---- latching --------------------------------------------------------------------

// The one-way door. A unisex thread becomes a `shot`/`bible`/… thread and gains its
// subject; from here holds and the thread owns exactly one artifact. Re-latching is
// refused outright rather than silently re-pointed.
export const latchThread = (project, threadId, kind, { subjectId = null, title = '', modelSlot = null, imageSlot = null } = {}) => {
  const thread = threadById(project, threadId);
  if (!thread) return { project, thread: null };
  if (thread.kind) return { project, thread };                 // already latched — no-op
  if (!THREAD_KINDS.includes(kind)) return { project, thread }; // unknown kind → nothing

  let next = project;
  let subject = subjectId;

  // An EDIT thread operates on something that already exists — it never creates a shot.
  // With exactly one shot holding takes it attaches there; with several it attaches to
  // nothing and the agent asks, because picking one would be substituting a default.
  if (!subject && kind === 'edit') {
    const shot = (next.film.shots || []).filter((sh) => sh.takes.length);
    subject = shot.length === 1 ? shot[0].id : null;
  }

  if (!subject && (kind === 'shot' || kind === 'storyboard')) {
    // A storyboard's artifact is an IMAGE, so it belongs on an image slot; a shot belongs
    // on a video slot. Handing a storyboard a video slot binds it to the wrong spec.
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

