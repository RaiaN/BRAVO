// THE PROJECT — the data model of docs/BRAVO.md §3, plus load / save / migrate.
//
// One canonical film; threads reference it. Everything here is a pure function over a
// plain JSON object, so the same model serialises to disk, to localStorage, or over the
// wire without a translation layer.
//
// Build rule (§8): NEVER SUBSTITUTE A DEFAULT. Every lookup below returns `null` for an
// id it does not know. Not the first item, not an empty stub — nothing. A caller that
// gets null must say so rather than quietly operate on the wrong subject.

export const SCHEMA_VERSION = 1;

const STORAGE_KEY = 'bravo:project';

// ---- ids ------------------------------------------------------------------------
// Stable, sortable, and readable in a JSON dump. Never an index: §3 says a shot's id is
// stable and its position is derived, so the two can never be the same value.

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
  prompt: '',            // §3 invariant 1: this IS the final prompt. Nothing wraps it.
  model: null,           // slot key — unset until chosen. No default (§8).
  refs: [],              // ORDERED; position IS the citation number (§3 invariant 2).
  keyframes: [],
  duration: 'auto',
  resolution: null,
  ratio: null,
  seed: null,
  generateAudio: false,
  takes: [],
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

// A thread is born UNISEX: no kind, no subject, just a conversation. The first message
// routes it, and the kind then LATCHES — which is what keeps §4's "a thread owns exactly
// one artifact" true. Unisex only until first use, never after.
export const makeThread = (fields = {}) => ({
  id: newId('thr'),
  kind: null,            // null = not yet routed
  subjectId: null,       // a thread owns exactly ONE artifact (§4), once latched
  title: '',
  messages: [],
  status: 'idle',
  draft: '',             // the half-typed message, per thread
  budget: { takesCap: 4, spentTakes: 0 },
  ...fields,
});

export const THREAD_KINDS = ['shot', 'edit', 'storyboard', 'bible', 'audio'];

// A new project is ONE BLANK THREAD and an empty film. Nothing is seeded: the first thing
// you say decides what this conversation is about, and the artifact is created then. An
// empty film is a legal state — it is what a film looks like before anyone has spoken.
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

// §3: `n` is the derived 1-based position — what the user says out loud. It is computed
// from the array on every read and stored nowhere, so reordering cannot desynchronise it.
//
// §5 forks a shot as a SIBLING (03 → 03b, rendered indented under its parent) or as NEXT
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

// ---- derived: rail state (§2) ----------------------------------------------------
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
  if (subject?.stale) return 'stale';
  if (thread?.status === 'working') return 'working';
  if (thread?.status === 'needs-you') return 'needs-you';
  if (thread?.status === 'settled') return 'settled';
  return 'empty';
};

// ---- persistence -----------------------------------------------------------------
//
// §3: "Persist as JSON per project." The browser store is the file for now; the shape on
// the wire is the shape in §3, so a later move to disk is a change of medium, not of
// model.

// Bring a stored object up to the current schema. Unknown/older payloads are repaired
// field by field rather than discarded — a transcript is not something to throw away
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
  const shots = Array.isArray(project.film?.shots) ? project.film.shots : [];
  project.film = { shots: shots.map((s) => makeShot(s)) };
  const threads = Array.isArray(project.threads) ? project.threads : [];
  project.threads = threads.map((t) => makeThread({
    ...t,
    kind: THREAD_KINDS.includes(t.kind) ? t.kind : null,   // an unknown kind is unlatched, never guessed (§8)
    messages: Array.isArray(t.messages) ? t.messages.map((m) => makeMessage(m)) : [],
    budget: { takesCap: 4, spentTakes: 0, ...(t.budget || {}) },
  }));
  // An EMPTY FILM is legal — it is what a film looks like before anyone has spoken. But a
  // project with no thread cannot be talked to at all, so that one is repaired.
  if (!project.threads.length) project.threads.push(makeThread());

  // THE LOOP RUNS IN THE BROWSER, so a reload kills any turn that was in flight. A thread
  // left saying `working` would spin forever against nothing running. Reconcile it here,
  // and say so in the transcript — §8 wants a visible report, not a silent reset.
  project.threads = project.threads.map((t) => (t.status === 'working'
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

export const loadProject = () => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    return null;   // a corrupt store is not a crash; the caller starts a fresh project
  }
};

export const saveProject = (project) => {
  if (typeof window === 'undefined' || !project) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  } catch { /* quota / private mode — the session copy stays live */ }
};

export const clearProject = () => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
};

// Every mutation goes through here so `updatedAt` can never drift from the content.
export const touch = (project) => ({ ...project, updatedAt: new Date().toISOString() });

// ---- mutations used by the shell -------------------------------------------------

export const appendMessage = (project, threadId, message) => {
  const thread = threadById(project, threadId);
  if (!thread) return project;          // unknown id → nothing happens (§8)
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
// at M7); absent, it lands at the end. `parentId` records a fork (§5) and is what makes a
// row render indented under its parent.
export const insertShot = (project, { afterId = null, parentId = null, fields = {} } = {}) => {
  const shot = makeShot({ ...fields, parentId });
  const shots = [...project.film.shots];
  const at = afterId ? shots.findIndex((s) => s.id === afterId) : -1;
  if (at >= 0) shots.splice(at + 1, 0, shot); else shots.push(shot);
  return { project: touch({ ...project, film: { shots } }), shot };
};

// §3 invariant 1: `prompt` is the final prompt — this sets fields, it never compiles one.
// An unknown id changes nothing (§8).
export const setShotFields = (project, shotId, fields) => (shotById(project, shotId)
  ? touch({ ...project, film: { shots: project.film.shots.map((s) => (s.id === shotId ? { ...s, ...fields, id: s.id } : s)) } })
  : project);

// §3 invariant 2: refs order IS the citation numbering, so moving a shot NEVER rewrites
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

export const chooseTake = (project, shotId, takeId) => {
  const shot = shotById(project, shotId);
  if (!shot || !shot.takes.some((t) => t.id === takeId)) return project;   // unknown → nothing (§8)
  return setShotFields(project, shotId, { chosenTakeId: takeId, stale: false });
};

// ---- latching --------------------------------------------------------------------

// The one-way door. A unisex thread becomes a `shot`/`bible`/… thread and gains its
// subject; from here §4 holds and the thread owns exactly one artifact. Re-latching is
// refused outright rather than silently re-pointed.
export const latchThread = (project, threadId, kind, { subjectId = null, title = '' } = {}) => {
  const thread = threadById(project, threadId);
  if (!thread) return { project, thread: null };
  if (thread.kind) return { project, thread };                 // already latched — no-op
  if (!THREAD_KINDS.includes(kind)) return { project, thread }; // unknown kind → nothing (§8)

  let next = project;
  let subject = subjectId;

  if (!subject && (kind === 'shot' || kind === 'storyboard' || kind === 'edit')) {
    const made = insertShot(next, { fields: { title } });
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

