import { useCallback, useEffect, useRef, useState } from 'react';
import Rail from '../components/Rail';
import Thread from '../components/Thread';
import {
  appendMessage,
  clearProject,
  loadProject,
  makeProject,
  renameThreadSubject,
  saveProject,
  threadById,
} from '../state/project';

// THE SHELL (§2) — rail on the left, the open thread on the right, composer pinned
// below it. Milestone 1: one project, one thread, no agent, and messages that persist.

const THEME_KEY = 'bravo:theme';
const SAVE_DEBOUNCE_MS = 300;

export default function Shell() {
  const [project, setProject] = useState(null);        // null until the store is read
  const [openThreadId, setOpenThreadId] = useState(null);
  const [more, setMore] = useState(false);
  const [theme, setTheme] = useState('system');
  const saveTimer = useRef(null);
  const latest = useRef(null);

  // ---- hydrate ------------------------------------------------------------------
  // localStorage does not exist on the server, so the first paint is deliberately empty
  // and the store is read in an effect. Rendering the project during SSR would hydrate
  // against a different tree.
  useEffect(() => {
    const stored = loadProject();
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

  // The packaged desktop window sets this class so the drag strip becomes a real title
  // bar; in a browser tab it stays off and nothing intercepts a click.
  useEffect(() => {
    if (window.BRAVO_DESKTOP || window.navigator.userAgent.includes('Electron')) {
      document.body.classList.add('desktop');
    }
  }, []);

  // ---- actions ------------------------------------------------------------------

  const send = useCallback((text) => {
    setProject((p) => (p ? appendMessage(p, openThreadId, { role: 'user', text }) : p));
  }, [openThreadId]);

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
    return (
      <div className="boot" aria-hidden="true">
        <style jsx>{`.boot { height: 100%; background: var(--canvas); }`}</style>
      </div>
    );
  }

  // An unknown id resolves to nothing (§8) — never to "the first thread".
  const open = threadById(project, openThreadId);

  return (
    <div className="app">
      {/* macOS window chrome: the strip the window is dragged by, and where the traffic
          lights sit once this is packaged. Nothing interactive lives under it. */}
      <div className="chrome" aria-hidden="true" />

      <Rail
        project={project}
        openThreadId={openThreadId}
        onOpenThread={setOpenThreadId}
        more={more}
        onToggleMore={() => setMore((v) => !v)}
        onReset={reset}
        theme={theme}
        onTheme={setTheme}
      />
      <Thread project={project} thread={open} onSend={send} onRename={rename} />

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
