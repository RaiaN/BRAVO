import { threadForSubject } from '../../state/project';

export default function BibleAssets({ project, onOpenThread }) {
  const entries = project.bible;
  return (
    <div className="panel">
      {entries.length === 0 && <p className="empty">The bible is empty. Ask for a reference plate, or upload an image.</p>}
      <div className="grid">
        {entries.map((b) => {
          const thread = threadForSubject(project, b.id);
          return (
            <button
              key={b.id}
              type="button"
              className="cell"
              onClick={() => thread && onOpenThread(thread.id)}
              title={thread ? `open “${b.name}”` : `${b.name} (no thread)`}
            >
              {b.plateUrl
                ? <img src={b.plateUrl} alt={b.name} loading="lazy" />
                : <span className="pending">plate pending</span>}
              <span className="meta">
                <b>{b.name || '—'}</b>
                <span className="sub">
                  {b.role}
                  {b.refs?.length ? ` · ${b.refs.length} ref${b.refs.length === 1 ? '' : 's'}` : ''}
                  {b.stills?.length ? ` · ${b.stills.length} render${b.stills.length === 1 ? '' : 's'}` : ''}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <style jsx>{`
        .panel { padding: 12px 0 14px; border-bottom: 1px solid var(--line-soft); }
        .empty { margin: 0; font-size: 12.5px; color: var(--muted); }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
        .cell {
          display: flex; flex-direction: column; text-align: left;
          border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
          background: var(--raised);
        }
        .cell:hover { border-color: rgba(201, 100, 66, 0.45); }
        img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
        .pending {
          display: grid; place-items: center; aspect-ratio: 1;
          font-size: 11px; color: var(--faint); background: var(--hover);
        }
        .meta { display: flex; flex-direction: column; gap: 1px; padding: 6px 9px; }
        b { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sub { font-size: 10.5px; color: var(--faint); }
      `}</style>
    </div>
  );
}
