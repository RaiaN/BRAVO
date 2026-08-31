import { useEffect, useMemo, useState } from 'react';

const classBadge = { plan: 'plan · pre-spend', measure: 'measure · post-render', judgment: 'judgment · loop-learned' };

export default function RulesScreen({ project, onClose, onCorrectionStatus }) {
  const [books, setBooks] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const fetchRules = () => fetch('/api/rules')
    .then((r) => r.json())
    .then((j) => (j.error ? setError(j.error) : setBooks(j)))
    .catch((e) => setError(e.message));
  useEffect(() => { fetchRules(); }, []);

  const ledger = useMemo(() => {
    const by = new Map();
    for (const seq of project.sequences || []) {
      for (const it of seq.iterations || []) {
        for (const g of it.gates || []) {
          const row = by.get(g.ruleId) || { pass: 0, fail: 0, notes: 0 };
          if (g.pass) row.pass += 1; else row.fail += 1;
          by.set(g.ruleId, row);
        }
        for (const n of it.notes || []) {
          if (n.ruleRef) {
            const row = by.get(n.ruleRef) || { pass: 0, fail: 0, notes: 0 };
            row.notes += 1;
            by.set(n.ruleRef, row);
          }
        }
      }
    }
    return by;
  }, [project]);

  const proposals = useMemo(() => {
    const out = [];
    for (const seq of project.sequences || []) {
      for (const it of seq.iterations || []) {
        for (const c of it.corrections || []) {
          if (c.kind === 'ruleProposal' && c.status === 'recorded') out.push({ seqId: seq.id, iterationId: it.id, correction: c });
        }
      }
    }
    return out;
  }, [project]);

  const approve = async (row) => {
    setBusyId(row.correction.id);
    try {
      const res = await fetch('/api/rule-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal: row.correction.proposal }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onCorrectionStatus(row.seqId, row.iterationId, row.correction.id, 'approved');
      await fetchRules();
    } catch (e) {
      setError(`approval failed: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const rules = books ? [...books.cinematic.rules.map((r) => ({ ...r, book: 'cinematic' })), ...books.screenwriting.rules.map((r) => ({ ...r, book: 'screenwriting' }))] : [];

  return (
    <main className="screen">
      <header className="head drag">
        <h1>Rules</h1>
        <button type="button" className="close" onClick={onClose}>done</button>
      </header>
      <div className="scroll body">
        <div className="measure">
          <p className="lede">
            The rulebook is the law the director plans and renders under. <b>plan</b> and{' '}
            <b>measure</b> rules block; <b>judgment</b> rules are learned through your notes.
            Approving a proposal writes it into the book — non-blocking until calibrated and
            signed again.
          </p>
          {error && <p className="warn">{error}</p>}

          {proposals.length > 0 && (
            <>
              <h2>Proposal inbox</h2>
              {proposals.map((row) => (
                <section key={row.correction.id} className="rule proposal">
                  <div className="top">
                    <span className="id">{row.correction.proposal.id}</span>
                    <span className="title">{row.correction.proposal.title}</span>
                    <span className="badge">{classBadge[row.correction.proposal.class]}</span>
                  </div>
                  <p className="stmt">{row.correction.proposal.statement}</p>
                  <p className="prov">learned from note {row.correction.proposal.provenance.note} on iteration {row.correction.proposal.provenance.iteration}</p>
                  <div className="acts">
                    <button type="button" className="ok" disabled={busyId === row.correction.id} onClick={() => approve(row)}>
                      {busyId === row.correction.id ? 'writing…' : 'approve into the book'}
                    </button>
                    <button type="button" className="no" onClick={() => onCorrectionStatus(row.seqId, row.iterationId, row.correction.id, 'rejected')}>reject</button>
                  </div>
                </section>
              ))}
            </>
          )}

          <h2>The book</h2>
          {rules.map((r) => {
            const led = ledger.get(r.id);
            return (
              <section key={r.id} className="rule">
                <div className="top">
                  <span className="id">{r.id}</span>
                  <span className="title">{r.title}</span>
                  <span className="badge">{classBadge[r.class]}</span>
                  {r.status !== 'active' && <span className="badge cal">{r.status}</span>}
                  {r.blocking && <span className="badge block">blocking</span>}
                  {r.provenance.origin === 'note' && <span className="badge learned">learned</span>}
                </div>
                <p className="stmt">{r.statement}</p>
                <p className="led tnum">
                  {led ? `${led.fail} violation${led.fail === 1 ? '' : 's'} · ${led.pass} pass${led.pass === 1 ? '' : 'es'} · ${led.notes} note${led.notes === 1 ? '' : 's'}` : 'no runs recorded yet'}
                </p>
              </section>
            );
          })}
        </div>
      </div>
      <style jsx>{`
        .screen { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--canvas); }
        .head { flex: none; display: flex; align-items: center; justify-content: space-between; height: 54px; padding: var(--chrome-h) 24px 0 24px; box-sizing: content-box; border-bottom: 1px solid var(--line-soft); }
        h1 { margin: 0; font-size: 15px; font-weight: 550; }
        h2 { margin: 18px 0 8px; font-size: 12px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--faint); }
        .close { font-size: 13px; color: var(--muted); }
        .close:hover { color: var(--ink); }
        .body { flex: 1; min-height: 0; padding: 0 24px 32px; }
        .measure { width: min(var(--pane-w), 100%); margin: 0 auto; padding: 22px 0; }
        .lede { margin: 0 0 10px; color: var(--muted); font-size: 13.5px; line-height: 1.6; }
        .warn { margin: 0 0 12px; padding: 8px 11px; border-radius: 8px; background: var(--accent-wash); color: var(--accent); font-size: 12.5px; }
        .rule { border: 1px solid var(--line); border-radius: 11px; padding: 10px 13px; margin-bottom: 7px; background: var(--raised); }
        .proposal { border-color: rgba(201, 100, 66, 0.5); }
        .top { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }
        .id { font-size: 11.5px; font-weight: 650; color: var(--accent); }
        .title { font-size: 13px; font-weight: 600; }
        .badge { font-size: 10px; padding: 0 6px; border-radius: 4px; background: var(--hover); color: var(--muted); }
        .cal { color: var(--state-working); }
        .block { color: var(--state-stale); }
        .learned { background: var(--accent-wash); color: var(--accent); }
        .stmt { margin: 5px 0 0; font-size: 12.5px; color: var(--ink-soft); line-height: 1.5; }
        .prov { margin: 4px 0 0; font-size: 11px; color: var(--faint); }
        .led { margin: 6px 0 0; font-size: 11px; color: var(--faint); }
        .acts { display: flex; gap: 10px; margin-top: 9px; }
        .ok { padding: 5px 13px; border-radius: 8px; background: var(--accent); color: var(--accent-ink); font-size: 12px; }
        .ok:disabled { opacity: .5; }
        .no { font-size: 12px; color: var(--muted); }
        .no:hover { color: var(--state-stale); }
      `}</style>
    </main>
  );
}
