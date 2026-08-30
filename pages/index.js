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
import '../agents';
import { advance, approveCall, cancelCall } from '../agents/session';
import { resumeActivity } from '../agents/resume';

const THEME_KEY = 'bravo:theme';
const SAVE_DEBOUNCE_MS = 300;

export default function Shell() {
  const [project, setProject] = useState(null);
  const [openThreadId, setOpenThreadId] = useState(null);
  const [more, setMore] = useState(false);
  const [screen, setScreen] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [theme, setTheme] = useState('system');
  const saveTimer = useRef(null);
  const latest = useRef(null);
  const running = useRef(new Set());
  const [, bumpRuns] = useState(0);

  const apply = useCallback((mutator) => {
    const next = mutator(latest.current);
    if (!next || next === latest.current) return;
    latest.current = next;
    setProject(next);
  }, []);

  useEffect(() => {
    let stored;
    try {
      stored = loadProject();
    } catch (err) {
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
    } catch { }
  }, []);

  useEffect(() => {
    latest.current = project;
    if (!project) return undefined;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveProject(project), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimer.current);
  }, [project]);

  useEffect(() => {
    const flush = () => { if (latest.current) saveProject(latest.current); };
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try { window.localStorage.setItem(THEME_KEY, theme); } catch { }
  }, [theme]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/film/config');
        const cfg = await res.json();
        if (cfg?.models) applyDeployModels(cfg.models);
      } catch { }
      hydrateSkills();

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

  useEffect(() => {
    if (window.BRAVO_DESKTOP || window.navigator.userAgent.includes('Electron')) {
      document.body.classList.add('desktop');
    }
  }, []);

  const startRun = useCallback((threadId, run) => {
    if (!threadId || running.current.has(threadId)) return;
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

  const openFilm = useCallback((id) => {
    let loaded;
    try { loaded = loadProject(id); } catch (err) { setLoadError(err.message); return; }
    if (!loaded) return;
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

  const open = threadById(project, openThreadId);

  return (<div className="app">
      {}
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
