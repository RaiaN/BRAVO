import { useEffect, useState } from 'react';

const GLYPH = { pending: '○', running: '⟳', done: '✓', halted: '⚠' };

const label = (id) => {
  if (id === 'shots') return 'create shots';
  if (id === 'assemble') return 'assemble';
  if (id === 'final') return 'final gate';
  const [kind, rest] = id.split(':');
  if (kind === 'plate') return `plate · ${rest}`;
  if (kind === 'shoot') return `shoot · ${rest}`;
  if (kind === 'measure') return `measure · ${rest}`;
  if (kind === 'chain') return `join · ${rest}`;
  return id;
};

const planNodes = (seq) => {
  const stages = [
    { id: 'brief', done: !!seq.brief },
    { id: 'screenplay', done: !!seq.screenplay },
    { id: 'breakdown', done: !!seq.plan },
  ];
  return stages.map((s) => ({ id: s.id, status: s.done ? 'done' : 'pending', value: null }));
};

const runNodes = (seq) => {
  if (!seq.plan) return [];
  const ids = [
    'shots',
    ...seq.plan.plates.map((p) => `plate:${p.entity}`),
    ...seq.plan.shots.flatMap((sh, i) => [`shoot:${sh.id}`, `measure:${sh.id}`, ...(i > 0 ? [`chain:${sh.id}`] : [])]),
    'assemble',
    'final',
  ];
  return ids.map((id) => ({ id, ...(seq.run?.nodes?.[id] || { status: 'pending', value: null }) }));
};

const detail = (n) => {
  if (n.status === 'halted') return n.reason || 'halted';
  if (!n.value) return null;
  if (n.id.startsWith('measure:')) return `${n.value.measured}s for ${n.value.requested}s · ${n.value.fps}fps${n.value.silent ? ' · silent' : ''}`;
  if (n.id.startsWith('chain:')) return `distance ${n.value.distance}`;
  if (n.id === 'final') return `${n.value.totalMeasured}s · Δ ${n.value.deltaFromN}s`;
  if (n.id.startsWith('plate:')) return 'rendered';
  if (n.id.startsWith('shoot:') && n.value.takeId) return `take landed${n.value.silent ? ' · silent' : ''}`;
  return null;
};

export default function DirectorFlow({ seq }) {
  const [, tick] = useState(0);
  const executing = seq?.status === 'executing';
  useEffect(() => {
    if (!executing) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [executing]);
  if (!seq) return null;

  const nodes = [...planNodes(seq), ...runNodes(seq)];
  const elapsed = (iso) => {
    const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
  };

  return (
    <div className="flow">
      <div className="head">
        <span>production flow</span>
        <span className={`st ${seq.status}`}>{seq.status}</span>
      </div>
      <ol>
        {nodes.map((n) => (
          <li key={n.id} className={n.status}>
            <span className="g" aria-hidden="true">{GLYPH[n.status] || '○'}</span>
            <span className="name">{label(n.id)}</span>
            <span className="info">
              {n.status === 'running' && n.startedAt ? elapsed(n.startedAt) : detail(n)}
              {n.attempts > 1 ? ` · attempt ${n.attempts}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {seq.run && (
        <div className="foot tnum">
          {seq.run.spentRenders} render{seq.run.spentRenders === 1 ? '' : 's'} · retry pool {seq.run.retryPoolLeft} left
          {seq.run.silentShots?.length ? ` · silent: ${seq.run.silentShots.join(', ')}` : ''}
          {seq.iterations?.length ? ` · iteration ${seq.iterations.length}` : ''}
        </div>
      )}
      <style jsx>{`
        .flow { padding: 12px 0 14px; border-bottom: 1px solid var(--line-soft); }
        .head { display: flex; justify-content: space-between; padding-bottom: 7px; font-size: 10.5px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: var(--faint); }
        .st.executing { color: var(--state-working); }
        .st.assembled { color: var(--state-settled); }
        .st.halted { color: var(--state-stale); }
        ol { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
        li { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; padding: 2px 4px; border-radius: 5px; }
        li.running { background: var(--hover); }
        .g { flex: none; width: 13px; text-align: center; font-size: 11px; color: var(--faint); }
        li.done .g { color: var(--state-settled); }
        li.halted .g { color: var(--state-stale); }
        li.running .g { color: var(--state-working); display: inline-block; animation: bravo-spin 1.8s linear infinite; }
        .name { flex: none; color: var(--ink-soft); }
        li.pending .name { color: var(--faint); }
        .info { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--muted); text-align: right; }
        li.halted .info { color: var(--state-stale); }
        .foot { padding-top: 8px; font-size: 11px; color: var(--faint); }
      `}</style>
    </div>
  );
}
