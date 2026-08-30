// THE FILMS SCREEN (other global link). persists as JSON per project, so more than
// one film can exist; this is where you move between them.
import { deleteProject, listProjects } from '../state/project';

const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString();
};

export default function FilmsScreen({ currentId, onOpen, onNew, onClose, onChanged }) {
  const films = listProjects();

  return (<main className="screen">
      <header className="head drag">
        <h1>Films</h1>
        <button type="button" className="close" onClick={onClose}>done</button>
      </header>

      <div className="scroll body">
        <div className="measure">
          {films.length === 0 && <p className="empty">No films yet.</p>}

          {films.map((f) => (<div key={f.id} className={`film${f.id === currentId ? ' current' : ''}`}>
              <button type="button" className="open" onClick={() => onOpen(f.id)}>
                <span className="title">{f.title}</span>
                <span className="meta">
                  {f.shots} shot{f.shots === 1 ? '' : 's'}
                  {f.takes ? ` · ${f.takes} take${f.takes === 1 ? '' : 's'}` : ''}
                  {' · '}{when(f.updatedAt)}
                </span>
              </button>
              {f.id === currentId
                ? <span className="badge">open</span>
                : (<button
                    type="button"
                    className="danger"
                    onClick={() => {
                      const label = `${f.title} — ${f.shots} shot${f.shots === 1 ? '' : 's'}, ${f.takes} take${f.takes === 1 ? '' : 's'}`;
                      if (window.confirm(`Delete "${label}"? This cannot be undone.`)) { deleteProject(f.id); onChanged(); }
                    }}
                  >
                    delete
                  </button>
                )}
            </div>
          ))}

          <button type="button" className="add" onClick={onNew}>+ new film</button>
        </div>
      </div>

      <style jsx>{`
        .screen { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--canvas); }
        .head {
          flex: none; display: flex; align-items: center; justify-content: space-between;
          height: 54px; padding: var(--chrome-h) 24px 0 24px; box-sizing: content-box;
          border-bottom: 1px solid var(--line-soft);
        }
        h1 { margin: 0; font-size: 15px; font-weight: 550; }
        .close { font-size: 13px; color: var(--muted); }
        .close:hover { color: var(--ink); }
        .body { flex: 1; min-height: 0; padding: 0 24px 32px; }
        .measure { width: min(var(--pane-w), 100%); margin: 0 auto; padding: 22px 0; }
        .empty { margin: 0 0 12px; color: var(--muted); font-size: 13.5px; }
        .film {
          display: flex; align-items: center; gap: 10px;
          border: 1px solid var(--line); border-radius: 11px;
          padding: 10px 13px; margin-bottom: 7px; background: var(--raised);
        }
        .film.current { border-color: rgba(201, 100, 66, 0.4); }
        .open { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; }
        .title { font-size: 13.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .meta  { font-size: 11.5px; color: var(--faint); }
        .badge { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: var(--accent-wash); color: var(--accent); }
        .danger { font-size: 11.5px; color: var(--muted); }
        .danger:hover { color: var(--state-stale); }
        .add { margin-top: 6px; padding: 7px 12px; border-radius: 9px; font-size: 13px; color: var(--muted); }
        .add:hover { background: var(--hover); color: var(--ink); }
      `}</style>
    </main>
  );
}
