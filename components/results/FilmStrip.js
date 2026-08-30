// The film, rendered as the ordered list it is (inline and visual, never a wall of
// text where a picture is the answer). Forks sit indented under their parent.
import { STATES } from '../../state/project';

export default function FilmStrip({ shots = [] }) {
  if (!shots.length) return <p className="empty">The film is empty.<style jsx>{`.empty{margin:0;color:var(--muted);font-size:13px}`}</style></p>;
  return (<ol className="strip">
      {shots.map((s) => (<li key={s.id} className={s.depth ? 'forked' : ''}>
          <span className="n tnum">{s.n}</span>
          <span className="title">{s.title || '—'}</span>
          <span className="meta">
            {s.hasPrompt ? 'prompt' : 'no prompt'}
            {s.takes ? ` · ${s.takes} take${s.takes === 1 ? '' : 's'}` : ''}
            {s.chosen ? ' · chosen' : ''}
          </span>
          {s.stale && <span className="stale" title={STATES.stale.label}>⚠</span>}
        </li>
      ))}
      <style jsx>{`
        .strip { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 1px; }
        li {
          display: flex; align-items: baseline; gap: 9px;
          padding: 5px 9px; border-radius: 6px; font-size: 13px;
          background: var(--hover);
        }
        .forked { margin-left: 20px; }
        .n     { flex: none; color: var(--muted); font-size: 12px; }
        .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .meta  { flex: none; font-size: 11.5px; color: var(--faint); }
        .stale { flex: none; color: var(--state-stale); font-size: 11px; }
      `}</style>
    </ol>
  );
}
