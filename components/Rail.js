import { filmRows, STATES, stateOf, threadForSubject, unlatchedThreads } from '../state/project';

// THE RAIL (§2) — project name, global links, then two sections: THE FILM (shots in
// order, forks indented under their parent) and THE BIBLE (entries, unordered). `+ new
// thread` at the bottom.
//
// It is also the FLEET MONITOR: every row wears the state of its agent, so the film's
// whole progress is legible without opening anything.

// A control that belongs to the layout but whose behaviour arrives at a later milestone.
// Drawn at full fidelity, inert, and honest about why — a shell that hides its unbuilt
// parts teaches the wrong shape.
const Pending = ({ icon, label, at }) => (
  <div className="row pending" title={`${label} — ${at}`} aria-disabled="true">
    <span className="icon">{icon}</span>
    <span className="label">{label}</span>
    <span className="at">{at}</span>
    <style jsx>{`
      .row {
        display: flex; align-items: center; gap: 9px;
        padding: 6px 10px; border-radius: 7px;
        color: var(--muted); font-size: 13.5px;
      }
      .pending { cursor: default; }
      .icon { width: 16px; text-align: center; opacity: 0.75; font-size: 13px; }
      .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .at {
        font-size: 10.5px; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--faint); border: 1px solid var(--line-soft);
        border-radius: 5px; padding: 0 5px; line-height: 15px;
      }
    `}</style>
  </div>
);

const StateGlyph = ({ state }) => {
  const { glyph, label } = STATES[state] || STATES.empty;
  return (
    <span className={`glyph ${state}`} title={label} aria-label={label} role="img">
      {glyph}
      <style jsx>{`
        .glyph {
          width: 14px; flex: none; text-align: center;
          font-size: 11px; line-height: 1;
          display: inline-flex; align-items: center; justify-content: center;
        }
        .empty     { color: var(--state-empty); }
        .working   { color: var(--state-working); animation: bravo-spin 1.8s linear infinite; }
        .needs-you { color: var(--state-needs); }
        .settled   { color: var(--state-settled); }
        .stale     { color: var(--state-stale); }
      `}</style>
    </span>
  );
};

const ShotRow = ({ row, thread, state, open, onOpen }) => (
  <button
    type="button"
    className={`row${open ? ' open' : ''}${row.depth ? ' forked' : ''}`}
    onClick={() => onOpen(thread?.id || null)}
    aria-current={open ? 'true' : undefined}
  >
    <span className="mark" aria-hidden="true">{row.depth ? '└' : '⌗'}</span>
    <span className="n tnum">{row.label}</span>
    <span className="title">{row.shot.title || '—'}</span>
    <StateGlyph state={state} />
    <style jsx>{`
      .row {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 6px 10px; border-radius: 7px; text-align: left;
        color: var(--ink-soft); font-size: 13.5px;
        transition: background 0.12s ease, color 0.12s ease;
      }
      .row:hover  { background: var(--hover); }
      .row.open   { background: var(--active); color: var(--ink); font-weight: 500; }
      .forked     { padding-left: 26px; }
      .mark  { width: 12px; flex: none; text-align: center; color: var(--faint); font-size: 11.5px; }
      .n     { flex: none; color: var(--muted); font-size: 12.5px; letter-spacing: 0.01em; }
      .open .n { color: var(--ink-soft); }
      .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `}</style>
  </button>
);

const Section = ({ children }) => (
  <div className="head">
    {children}
    <style jsx>{`
      .head {
        padding: 16px 12px 5px;
        font-size: 10.5px; font-weight: 600;
        letter-spacing: 0.09em; text-transform: uppercase;
        color: var(--faint);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
    `}</style>
  </div>
);

export default function Rail({ project, openThreadId, onOpenThread, onNewThread, more, onToggleMore, onReset, theme, onTheme }) {
  const rows = filmRows(project);
  const blank = unlatchedThreads(project);

  return (
    <nav className="rail" aria-label="Films and bible">
      <div className="brand drag">BRAVO</div>

      <div className="links">
        <Pending icon="⌘" label="Films" at="M2" />
        <Pending icon="⚙" label="Skills" at="M4" />
        <button type="button" className="more" onClick={onToggleMore} aria-expanded={more}>
          <span className={`caret${more ? ' down' : ''}`} aria-hidden="true">▾</span>
          <span>More</span>
        </button>
        {more && (
          <div className="drawer">
            <div className="pref">
              <span>Appearance</span>
              <div className="seg" role="group" aria-label="Appearance">
                {['system', 'light', 'dark'].map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={theme === t ? 'on' : ''}
                    onClick={() => onTheme(t)}
                    aria-pressed={theme === t}
                  >
                    {t === 'system' ? 'Auto' : t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className="danger" onClick={onReset}>Reset project…</button>
          </div>
        )}
      </div>

      <div className="scroll body">
        {blank.length > 0 && (
          <>
            <Section>Unrouted</Section>
            {blank.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`brow${t.id === openThreadId ? ' open' : ''}`}
                onClick={() => onOpenThread(t.id)}
              >
                <span className="mark" aria-hidden="true">＋</span>
                <span className="title">{t.messages.length ? t.messages[0].text.slice(0, 40) : 'new thread'}</span>
                <StateGlyph state={t.status === 'working' ? 'working' : 'empty'} />
              </button>
            ))}
          </>
        )}

        <Section>{project.title || 'Untitled film'}</Section>
        {rows.length === 0 && <p className="empty">No shots yet. Say what you want in a thread.</p>}
        {rows.map((row) => {
          const thread = threadForSubject(project, row.shot.id);
          return (
            <ShotRow
              key={row.shot.id}
              row={row}
              thread={thread}
              state={stateOf(project, thread)}
              open={!!thread && thread.id === openThreadId}
              onOpen={onOpenThread}
            />
          );
        })}

        <div className="rule" />
        <Section>Bible</Section>
        {project.bible.length === 0
          ? <p className="empty">No entries yet. Plates and their citations arrive at M8.</p>
          : project.bible.map((entry) => {
            const thread = threadForSubject(project, entry.id);
            return (
              <button
                key={entry.id}
                type="button"
                className={`brow${thread && thread.id === openThreadId ? ' open' : ''}`}
                onClick={() => onOpenThread(thread?.id || null)}
              >
                <span className="mark" aria-hidden="true">◆</span>
                <span className="title">{entry.name || '—'}</span>
                <StateGlyph state={stateOf(project, thread)} />
              </button>
            );
          })}
      </div>

      <div className="foot">
        <button type="button" className="new" onClick={onNewThread}>
          <span className="icon" aria-hidden="true">+</span>
          <span>New thread</span>
        </button>
        <p className="stage">Phase A · the loop</p>
      </div>

      <style jsx>{`
        .rail {
          width: var(--rail-w); flex: none;
          display: flex; flex-direction: column; min-height: 0;
          background: var(--rail);
          border-right: 1px solid var(--line-soft);
        }
        .brand {
          padding: calc(var(--chrome-h) + 6px) 14px 10px;
          font-size: 13.5px; font-weight: 640; letter-spacing: 0.10em;
          color: var(--ink);
        }
        .links { padding: 0 6px 8px; border-bottom: 1px solid var(--line-soft); }
        .more {
          display: flex; align-items: center; gap: 9px; width: 100%;
          padding: 6px 10px; border-radius: 7px;
          color: var(--muted); font-size: 13.5px; text-align: left;
        }
        .more:hover { background: var(--hover); color: var(--ink-soft); }
        .caret {
          width: 16px; text-align: center; font-size: 10px;
          transition: transform 0.15s ease; transform: rotate(-90deg);
        }
        .caret.down { transform: none; }
        .drawer { padding: 4px 10px 8px 35px; display: flex; flex-direction: column; gap: 8px; }
        .pref { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
        .seg {
          display: flex; gap: 2px; padding: 2px;
          background: var(--hover); border-radius: 7px;
        }
        .seg button {
          flex: 1; padding: 3px 0; border-radius: 5px;
          font-size: 11.5px; color: var(--muted);
        }
        .seg button.on { background: var(--raised); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
        .danger { font-size: 12px; color: var(--muted); text-align: left; }
        .danger:hover { color: var(--state-stale); }

        .body { flex: 1; min-height: 0; padding: 0 6px 12px; }
        .rule { height: 1px; margin: 14px 10px 0; background: var(--line-soft); }
        .empty { margin: 2px 10px; font-size: 12px; line-height: 1.5; color: var(--faint); }

        .brow {
          display: flex; align-items: center; gap: 8px; width: 100%;
          padding: 6px 10px; border-radius: 7px; text-align: left;
          color: var(--ink-soft); font-size: 13.5px;
        }
        .brow:hover { background: var(--hover); }
        .brow.open  { background: var(--active); color: var(--ink); font-weight: 500; }
        .mark  { width: 12px; flex: none; text-align: center; color: var(--faint); font-size: 10px; }
        .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .foot { padding: 8px 6px 10px; border-top: 1px solid var(--line-soft); }
        .new {
          display: flex; align-items: center; gap: 9px; width: 100%;
          padding: 6px 10px; border-radius: 7px;
          color: var(--muted); font-size: 13.5px; text-align: left;
        }
        .new:hover { background: var(--hover); color: var(--ink); }
        .new .icon { width: 16px; text-align: center; }
        .stage {
          margin: 6px 0 0; padding: 0 11px;
          font-size: 10.5px; letter-spacing: 0.05em; color: var(--faint);
        }
      `}</style>
    </nav>
  );
}
