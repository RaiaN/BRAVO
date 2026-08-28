// The shot's references, IN ORDER — because position IS the citation number (§3
// invariant 2). The number is shown first for exactly that reason.
export default function RefChips({ refs = [], prefix = '' }) {
  if (!refs.length) return null;
  return (
    <div className="row">
      {refs.map((r) => (
        <span key={r.n} className="chip">
          <b className="tnum">{prefix}Image{prefix ? '' : ' '}{r.n}</b>
          {r.label || r.role || 'ref'}
        </span>
      ))}
      <style jsx>{`
        .row  { display: flex; flex-wrap: wrap; gap: 5px; }
        .chip {
          display: inline-flex; align-items: baseline; gap: 6px;
          padding: 2px 8px; border-radius: 999px;
          background: var(--hover); font-size: 11.5px; color: var(--ink-soft);
        }
        b { color: var(--muted); font-weight: 600; font-size: 10.5px; }
      `}</style>
    </div>
  );
}
