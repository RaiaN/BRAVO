import { useCallback, useEffect, useRef, useState } from 'react';
import Rail from '../components/Rail';
import Thread from '../components/Thread';
import SkillsScreen from '../components/SkillsScreen';
import FilmsScreen from '../components/FilmsScreen';
import RulesScreen from '../components/RulesScreen';
import {
  addThread,
  appendMessage,
  clearProject,
  listProjects,
  setCorrectionStatus,
  loadProject,
  makeProject,
  pruneSequenceActivity,
  renameThreadSubject,
  saveProject,
  setThreadDraft,
  threadById,
} from '../state/project';
import { browserClient } from '../agents/client';
import { applyDeployModels } from '../utils/film/suiteConfig';
import { hydrateSkills } from '../utils/film/skills';
import '../agents';
import { advance, approveCall, cancelCall, resumeRun } from '../agents/session';
import { tracedClient } from '../agents/trace';
import { reconcileInterrupted, resumeActivity } from '../agents/resume';
import { resumeSequences } from '../agents/director/execute';

const THEME_KEY = 'bravo:theme';
const SAVE_DEBOUNCE_MS = 300;

export default function Shell() {
  const [project, setProject] = useState(null);
  const [openThreadId, setOpenThreadId] = useState(null);
  const [more, setMore] = useState(false);
  const [screen, setScreen] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [theme, setTheme] = useState('system');
  const saveTimer = useRef(null);
  const latest = useRef(null);
  const running = useRef(new Set());
  const epoch = useRef(0);
  const [, bumpRuns] = useState(0);

  const apply = useCallback((mutator) => {
    const next = mutator(latest.current);
    if (!next || next === latest.current) return;
    latest.current = next;
    setProject(next);
  }, []);

  const epochApply = useCallback((born) => (mutator) => {
    if (epoch.current !== born) return;
    apply(mutator);
  }, [apply]);

  const adopt = useCallback((next) => {
    epoch.current += 1;
    latest.current = next;
    setProject(next);
    setOpenThreadId(next.threads[0]?.id || null);
  }, []);

  useEffect(() => {
    let stored;
    try {
      stored = loadProject();
    } catch (err) {
      setLoadError(err.message);
      return;
    }
    const next = stored ? reconcileInterrupted(pruneSequenceActivity(stored)) : makeProject();
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
    saveTimer.current = setTimeout(() => {
      try { saveProject(project); setSaveError(null); } catch (err) { setSaveError(err.message); }
    }, SAVE_DEBOUNCE_MS);
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
      hydrateSkills().catch(() => {});

      const applyHere = epochApply(epoch.current);
      await resumeActivity({ get: () => latest.current, apply: applyHere });
      await resumeSequences({ client: browserClient(), get: () => latest.current, apply: applyHere });
    })().catch((err) => setSaveError(`Recovery after reload failed: ${err.message}`));
  }, [project?.id, epochApply]);

  useEffect(() => {
    if (window.BRAVO_DESKTOP || window.navigator.userAgent.includes('Electron')) {
      document.body.classList.add('desktop');
    }
  }, []);

  const startRun = useCallback((threadId, run) => {
    if (!threadId || running.current.has(threadId)) return;
    running.current.add(threadId);
    bumpRuns((n) => n + 1);
    const applyHere = epochApply(epoch.current);
    Promise.resolve()
      .then(() => run({ client: tracedClient(threadId), threadId, get: () => latest.current, apply: applyHere }))
      .catch((err) => epochApply(epoch.current)((prev) => appendMessage(prev, threadId, { role: 'agent', text: `That failed: ${err.message}` })))
      .finally(() => { running.current.delete(threadId); bumpRuns((n) => n + 1); });
  }, [epochApply]);

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

  const resume = useCallback(() => {
    const threadId = openThreadId;
    startRun(threadId, (args) => resumeRun(args));
  }, [openThreadId, startRun]);

  const cancel = useCallback((messageId) => {
    apply((prev) => cancelCall(prev, openThreadId, messageId));
  }, [openThreadId, apply]);

  const draft = useCallback((text) => {
    apply((prev) => setThreadDraft(prev, openThreadId, text));
  }, [openThreadId, apply]);

  const upload = useCallback((file) => {
    const threadId = openThreadId;
    if (!threadId) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await fetch('/api/film/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: reader.result, name: file.name }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `upload failed (HTTP ${res.status})`);
        apply((prev) => appendMessage(prev, threadId, {
          role: 'user',
          text: '',
          asset: { url: data.url, name: file.name, assetId: data.assetId || null },
        }));
      } catch (err) {
        apply((prev) => appendMessage(prev, threadId, { role: 'agent', text: `That upload failed: ${err.message}` }));
      }
    };
    reader.readAsDataURL(file);
  }, [openThreadId, apply]);

  const openFilm = useCallback((id) => {
    let loaded;
    try { loaded = loadProject(id); } catch (err) { setLoadError(err.message); return; }
    if (!loaded) return;
    adopt(reconcileInterrupted(pruneSequenceActivity(loaded)));
    setScreen(null);
  }, []);

  const newFilm = useCallback(() => {
    const fresh = makeProject();
    saveProject(fresh);
    adopt(fresh);
    setScreen(null);
  }, [adopt]);

  const filmsChanged = useCallback(() => {
    if (listProjects().some((f) => f.id === latest.current?.id)) return;
    let remaining = null;
    try { remaining = loadProject(); } catch (err) { setLoadError(err.message); return; }
    const next = remaining || makeProject();
    saveProject(next);
    adopt(reconcileInterrupted(pruneSequenceActivity(next)));
  }, [adopt]);

  const newThread = useCallback(() => {
    const { project: next, thread } = addThread(latest.current);
    apply(() => next);
    setOpenThreadId(thread.id);
  }, [apply]);

  const rename = useCallback((title) => {
    apply((prev) => (prev ? renameThreadSubject(prev, openThreadId, title) : prev));
  }, [apply, openThreadId]);

  const reset = useCallback(() => {
    const n = latest.current?.threads?.reduce((sum, t) => sum + t.messages.length, 0) || 0;
    const warn = n
      ? `Delete this project and its ${n} message${n === 1 ? '' : 's'}? This cannot be undone.`
      : 'Delete this project and start over?';
    if (!window.confirm(warn)) return;
    clearProject();
    const fresh = makeProject();
    saveProject(fresh);
    adopt(fresh);
    setMore(false);
  }, [adopt]);

  if (!project) {
    return (<div className="boot" aria-hidden={!loadError}>
        {loadError && (
          <div className="dead">
            <h1>The saved film could not be loaded</h1>
            <p>{loadError}</p>
          </div>
        )}
        <style jsx>{`
          .boot { height: 100%; background: var(--canvas); }
          .dead { max-width: 520px; margin: 18vh auto 0; padding: 0 24px; }
          h1 { font-size: 16px; }
          p { color: var(--muted); font-size: 13.5px; line-height: 1.6; }
        `}</style>
      </div>
    );
  }

  const open = threadById(project, openThreadId);

  return (<div className="app">
      {(saveError || loadError) && (
        <div className="storagewarn" role="alert">{saveError || loadError}</div>
      )}
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
      {screen === 'rules' && (
        <RulesScreen
          project={project}
          onClose={() => setScreen(null)}
          onCorrectionStatus={(seqId, itId, corId, status) => apply((prev) => setCorrectionStatus(prev, seqId, itId, corId, status))}
        />
      )}
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
          onResume={resume}
          onCancel={cancel}
          onUpload={upload}
          onOpenThread={setOpenThreadId}
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
        .storagewarn {
          position: fixed; inset: var(--chrome-h) 0 auto 0; z-index: 60;
          padding: 9px 16px; text-align: center;
          background: var(--accent); color: var(--accent-ink);
          font-size: 13px; font-weight: 550;
        }
      `}</style>
    </div>
  );
}
