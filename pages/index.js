import { useCallback, useEffect, useRef, useState } from 'react';
import Rail from '../components/Rail';
import Thread from '../components/Thread';
import SkillsScreen from '../components/SkillsScreen';
import FilmsScreen from '../components/FilmsScreen';
import {
  addThread,
  appendMessage,
  clearProject,
  listProjects,
  loadProject,
  makeProject,
  renameThreadSubject,
  saveProject,
  setThreadDraft,
  threadById,
} from '../state/project';
import { browserClient } from '../agents/client';
import { applyDeployModels } from '../utils/film/suiteConfig';
import { hydrateSkills } from '../utils/film/skills';
import '../agents';                                   // registers the roster
import { advance, approveCall, cancelCall } from '../agents/session';
import { resumeActivity } from '../agents/resume';

// THE SHELL — rail on the left, the open thread on the right, composer pinned below
// it. The rail's two global links open full-pane screens over the thread; the thread is
// what everything else happens in.

const THEME_KEY = 'bravo:theme';
const SAVE_DEBOUNCE_MS = 300;

export default function Shell() {
  const [project, setProject] = useState(null);        // null until the store is read
  const [openThreadId, setOpenThreadId] = useState(null);
  const [more, setMore] = useState(false);
  const [screen, setScreen] = useState(null);   // null | 'films' | 'skills'
  const [loadError, setLoadError] = useState(null);
  const [theme, setTheme] = useState('system');
  const saveTimer = useRef(null);
  const latest = useRef(null);
  // Threads with a turn in flight. runs agents independently, so this is a SET, not a
  // boolean — several can be working while you read a fourth.
  const running = useRef(new Set());
  const [, bumpRuns] = useState(0);

  // THE ONE WRITER. Every mutation — from any run, in any thread — goes through here, so
  // concurrent agents queue behind each other instead of overwriting whole projects.
  const apply = useCallback((mutator) => {
    const next = mutator(latest.current);
    if (!next || next === latest.current) return;
    latest.current = next;
    setProject(next);
  }, []);

  // ---- hydrate ------------------------------------------------------------------
  // localStorage does not exist on the server, so the first paint is deliberately empty
  // and the store is read in an effect. Rendering the project during SSR would hydrate
  // against a different tree.
  useEffect(() => {
    let stored;
    try {
      stored = loadProject();
    } catch (err) {
      // A saved film that will not parse must NOT be replaced by a blank one. Stop and
      // say so; the data is still on disk and still recoverable.
      setLoadError(err.message);
      return;
    }
    const next = stored || makeProject();
    if (!stored) saveProject(next);
    setProject(next);
    setOpenThreadId(next.threads[0]?.id || null);

    try {
      const t = window.localStorage.getItem(THEME_KEY);
      if (t === 'light' || t === 'dark' || t === 'system') setTheme(t);
    } catch { /* private mode — the session default stands */ }
  }, []);

  // ---- persist ------------------------------------------------------------------
  // Debounced so a fast typist does not serialise the transcript on every keystroke, and
  // flushed on the way out so the last turn can never be the one that is lost.
  useEffect(() => {
    latest.current = project;
    if (!project) return undefined;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveProject(project), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimer.current);
  }, [project]);

  useEffect(() => {
    const flush = () => { if (latest.current) saveProject(latest.current); };
    // Only on the way OUT. Flushing when the tab comes BACK would overwrite the store
    // with this tab's older copy if anything else had touched it in the meantime.
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  // ---- appearance ---------------------------------------------------------------
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* noop */ }
  }, [theme]);

  // The browser cannot read server env, so the model table arrives from the config route
  // once per session — the kit's documented path. WITHOUT THIS every slot looks
  // unconfigured and `defaultVideoModelKey()` falls to seedance 2.0, which binds sd20-pe
  // instead of sd25-pe. The skills library is warmed at the same time so the first
  // compose of a session does not fail merely because it had not loaded.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/film/config');
        const cfg = await res.json();
        if (cfg?.models) applyDeployModels(cfg.models);
      } catch { /* offline — slots stay unconfigured and say so when used */ }
      hydrateSkills();

      // A Seedance take runs for minutes and the loop lives in this tab, so a reload used
      // to abandon a render that was already paid for. The task keeps running server-side;
      // pick it back up.
      if ((latest.current?.activity || []).some((a) => a.state === 'running')) {
        const next = await resumeActivity({
          client: browserClient(),
          project: latest.current,
          onProgress: (pr) => { latest.current = pr; setProject(pr); },
        });
        apply(() => next);
      }
    })();
  }, [project?.id]);

  // The packaged desktop window sets this class so the drag strip becomes a real title
  // bar; in a browser tab it stays off and nothing intercepts a click.
  useEffect(() => {
    if (window.BRAVO_DESKTOP || window.navigator.userAgent.includes('Electron')) {
      document.body.classList.add('desktop');
    }
  }, []);

  // ---- actions ------------------------------------------------------------------

  // Send, then run the agent's turn. : selection is implicit — this thread is the
  // subject of everything typed here, so nothing is passed but the text.
  // Start a turn on a thread and DO NOT await it here. : "an agent composes, renders,
  // looks, revises — while you work in another thread." Awaiting would tie every agent to
  // whichever thread happens to be open.
  const startRun = useCallback((threadId, run) => {
    if (!threadId || running.current.has(threadId)) return;   // one agent per thread
    running.current.add(threadId);
    bumpRuns((n) => n + 1);
    Promise.resolve()
      .then(() => run({ client: browserClient(), threadId, get: () => latest.current, apply }))
      .catch((err) => apply((prev) => appendMessage(prev, threadId, { role: 'agent', text: `That failed: ${err.message}` })))
      .finally(() => { running.current.delete(threadId); bumpRuns((n) => n + 1); });
  }, [apply]);

  const send = useCallback((text) => {
    const threadId = openThreadId;
    if (!threadId) return;
    apply((prev) => appendMessage(setThreadDraft(prev, threadId, ''), threadId, { role: 'user', text }));
    startRun(threadId, (args) => advance(args));
  }, [openThreadId, apply, startRun]);

  const approve = useCallback((messageId) => {
    const threadId = openThreadId;
    startRun(threadId, (args) => approveCall({ ...args, messageId }));
  }, [openThreadId, startRun]);

  const cancel = useCallback((messageId) => {
    apply((prev) => cancelCall(prev, openThreadId, messageId));
  }, [openThreadId, apply]);

  const draft = useCallback((text) => {
    apply((prev) => setThreadDraft(prev, openThreadId, text));
  }, [openThreadId, apply]);

  // ---- films ---------------------------------------------------------------------

  const openFilm = useCallback((id) => {
    let loaded;
    try { loaded = loadProject(id); } catch (err) { setLoadError(err.message); return; }
    if (!loaded) return;                      // an id the store does not hold → nothing
    latest.current = loaded;
    setProject(loaded);
    setOpenThreadId(loaded.threads[0]?.id || null);
    setScreen(null);
  }, []);

  const newFilm = useCallback(() => {
    const fresh = makeProject();
    saveProject(fresh);
    latest.current = fresh;
    setProject(fresh);
    setOpenThreadId(fresh.threads[0]?.id || null);
    setScreen(null);
  }, []);

  const filmsChanged = useCallback(() => {
    // A deleted film may have been the open one; open whatever remains.
    if (listProjects().some((f) => f.id === latest.current?.id)) { setMore((v) => v); return; }
    let remaining = null;
    try { remaining = loadProject(); } catch (err) { setLoadError(err.message); return; }
    const next = remaining || makeProject();
    saveProject(next);
    latest.current = next;
    setProject(next);
    setOpenThreadId(next.threads[0]?.id || null);
  }, []);

  const newThread = useCallback(() => {
    const { project: next, thread } = addThread(latest.current);
    latest.current = next;
    setProject(next);
    setOpenThreadId(thread.id);
  }, []);

  const rename = useCallback((title) => {
    setProject((p) => (p ? renameThreadSubject(p, openThreadId, title) : p));
  }, [openThreadId]);

  const reset = useCallback(() => {
    const n = latest.current?.threads?.reduce((sum, t) => sum + t.messages.length, 0) || 0;
    const warn = n
      ? `Delete this project and its ${n} message${n === 1 ? '' : 's'}? This cannot be undone.`
      : 'Delete this project and start over?';
    if (!window.confirm(warn)) return;
    clearProject();
    const fresh = makeProject();
    saveProject(fresh);
    setProject(fresh);
    setOpenThreadId(fresh.threads[0]?.id || null);
    setMore(false);
  }, []);

  if (!project) {
    return (<div className="boot" aria-hidden="true">
        <style jsx>{`.boot { height: 100%; background: var(--canvas); }`}</style>
      </div>
    );
  }

  // An unknown id resolves to nothing — never to "the first thread".
  const open = threadById(project, openThreadId);

  return (<div className="app">
      {/* macOS window chrome: the strip the window is dragged by, and where the traffic
          lights sit once this is packaged. Nothing interactive lives under it. */}
      <div className="chrome" aria-hidden="true" />

      <Rail
        project={project}
        openThreadId={openThreadId}
        onOpenThread={setOpenThreadId}
        onNewThread={newThread}
        screen={screen}
        onScreen={setScreen}
        more={more}
        onToggleMore={() => setMore((v) => !v)}
        onAgentsChanged={() => bumpRuns((n) => n + 1)}
        onReset={reset}
        theme={theme}
        onTheme={setTheme}
      />
      {screen === 'skills' && <SkillsScreen onClose={() => setScreen(null)} />}
      {screen === 'films' && (<FilmsScreen
          currentId={project.id}
          onOpen={openFilm}
          onNew={newFilm}
          onClose={() => setScreen(null)}
          onChanged={filmsChanged}
        />
      )}
      {!screen && (<Thread
          project={project}
          thread={open}
          onSend={send}
          onRename={rename}
          onDraft={draft}
          onApprove={approve}
          onCancel={cancel}
          running={running.current.has(open?.id)}
        />
      )}

      <style jsx>{`
        .app { display: flex; height: 100%; min-height: 0; }
        .chrome {
          position: fixed; inset: 0 0 auto 0; height: var(--chrome-h);
          z-index: 40;
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}
