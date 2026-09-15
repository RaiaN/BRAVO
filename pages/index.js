import { useEffect, useRef, useState } from 'react';
import AgentSidebar from '../components/AgentSidebar.js';

const KEY = 'bravo.extend';
const remember = (patch) => {
  try { localStorage.setItem(KEY, JSON.stringify({ ...(JSON.parse(localStorage.getItem(KEY) || '{}')), ...patch })); } catch { }
};
const recall = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };

const GLYPH = { pending: '○', running: '⟳', done: '✓', failed: '!' };
const StatusBar = ({ shot }) => {
  const done = shot.status === 'done';
  const running = shot.status === 'running';
  if (!done && !running) return null;
  return (
    <div className={`bar ${shot.status}${shot.shipped === 'absent' ? ' absent' : ''}`}>
      <span className="fill" />
      <span className="lbl">{done ? (shot.shipped === 'absent' ? 'absent' : 'done') : shot.phase === 'film-qc' ? (shot.filmQC?.status === 'selecting' ? 'Persona selecting' : 'film QC') : 'rendering'}</span>
      <style jsx>{`
        .bar { display: flex; align-items: center; gap: 8px; margin: 6px 0 4px; }
        .fill { flex: 1; height: 4px; border-radius: 2px; background: var(--state-settled); }
        .running .fill { background: var(--state-working); animation: pulse 1.2s ease-in-out infinite; }
        .absent .fill { background: var(--state-stale); }
        .lbl { flex: none; font-size: 11px; color: var(--muted); min-width: 60px; text-align: right; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
      `}</style>
    </div>
  );
};

const FilmQC = ({ qc }) => {
  if (!qc) return null;
  return (
    <section className="film-qc" aria-label="Film quality review">
      <b>Film QC · {qc.receipts.length}/5 receipts · {qc.status}</b>
      <p className="hint">Five independent film specialists, powered by Seed 2.0 Pro. Receipts propose improvements to the selected take.</p>
      <div className="agents">
        {qc.agents.map((agent) => (
          <span key={agent.id}>{agent.name}: {agent.stage === 'inspect' ? 'inspection' : 'receipt'} {agent.status}{agent.attempt > 1 ? ` (attempt ${agent.attempt})` : ''}</span>
        ))}
      </div>
      {qc.failures.map((f) => <p className="failure" key={f.agentId}>{f.agentId}: {f.error}</p>)}
      {qc.selection && <p className="selected"><b>Persona selected {qc.selection.selectedReceipt.agentName}.</b> {qc.selection.reason}</p>}
      {qc.receipts.map((r) => (
        <details key={r.receiptId} className={qc.selection?.receiptId === r.receiptId ? 'picked' : ''}>
          <summary>{r.agentName} · {r.receipt.title}{qc.selection?.receiptId === r.receiptId ? ' · Persona’s pick' : ''}</summary>
          <p>{r.receipt.summary}</p>
          <p><b>Inspection · {r.inspection.score}/10:</b> {r.inspection.summary}</p>
          {r.inspection.strengths.length > 0 && <p><b>Strengths:</b> {r.inspection.strengths.join(' · ')}</p>}
          {r.inspection.findings.map((f) => <p key={f.id}><b>{f.id} · {f.severity}{f.timecode != null ? ` · ${f.timecode}s` : ''}:</b> {f.evidence} {f.impact}</p>)}
          {r.receipt.preserve.length > 0 && <p><b>Preserve:</b> {r.receipt.preserve.join(' · ')}</p>}
          {r.receipt.actions.map((a, i) => (
            <div className="action" key={i}>
              <p><b>{a.priority}. {a.department}:</b> {a.change}</p>
              <p>{a.rationale}{a.findingIds.length ? ` (${a.findingIds.join(', ')})` : ''}</p>
              <p><b>Risk:</b> {a.risk}</p>
              <p><b>Verify:</b> {a.verify}</p>
            </div>
          ))}
          <p><b>Revised shot prompt:</b> {r.receipt.revisedPrompt}</p>
          {[...r.inspection.limitations, ...r.receipt.limitations].length > 0 && <p><b>Limitations:</b> {[...new Set([...r.inspection.limitations, ...r.receipt.limitations])].join(' · ')}</p>}
        </details>
      ))}
      {qc.selection && <details><summary>Persona’s comparison of all five receipts</summary>{qc.selection.comparisons.map((c) => <p key={c.receiptId}><b>{qc.receipts.find((r) => r.receiptId === c.receiptId)?.agentName}:</b> {c.assessment}</p>)}</details>}
      <style jsx>{`
        .film-qc { margin-top: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; line-height: 1.5; }
        .hint, .agents { font-size: 12px; color: var(--muted); }
        .agents { display: flex; flex-wrap: wrap; gap: 6px 14px; }
        p { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
        .selected { color: var(--state-settled); }
        .failure { color: var(--state-stale); }
        details { margin-top: 8px; padding: 8px; border: 1px solid var(--line-soft); border-radius: 6px; }
        details.picked { border-color: var(--state-settled); }
        summary { cursor: pointer; font-weight: 550; }
        .action { border-top: 1px solid var(--line-soft); margin-top: 8px; padding-top: 4px; }
      `}</style>
    </section>
  );
};

export default function Extend() {
  const [idea, setIdea] = useState('');
  const [seconds, setSeconds] = useState(120);
  const [runId, setRunId] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const r = recall();
    if (typeof r.idea === 'string') setIdea(r.idea);
    if (Number.isInteger(r.seconds)) setSeconds(r.seconds);
    if (r.runId) setRunId(r.runId);
    setRestored(true);
  }, []);
  useEffect(() => { if (restored) remember({ idea, seconds, runId }); }, [restored, idea, seconds, runId]);

  const start = async () => {
    setError(null);
    if (!idea.trim()) { setError('Write the story first.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/extend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea, seconds }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRunId(data.runId);
      setState(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!runId) return undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/extend?runId=${encodeURIComponent(runId)}`);
        const data = await res.json();
        if (res.ok) setState(data);
      } catch { }
    };
    poll();
    timer.current = setInterval(poll, 5000);
    return () => clearInterval(timer.current);
  }, [runId]);

  const finished = state && ['complete', 'failed', 'refused'].includes(state.status);
  useEffect(() => { if (finished) clearInterval(timer.current); }, [finished]);

  return (
    <main className="page">
      <div className="main">
      <h1>Extend</h1>
      <p className="lede">One story in, a film out. Persona chooses a take, five film specialists independently inspect it and propose improvements, then Persona selects the best receipt. Every stage is logged.</p>

      <label className="field">
        <span>The story</span>
        <textarea rows={4} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="Let's make a story about … One or two sentences of detail." disabled={!!runId && !finished} />
      </label>
      <div className="row">
        <label className="field small">
          <span>Seconds</span>
          <input type="number" min={40} step={10} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} disabled={!!runId && !finished} />
        </label>
        <button type="button" className="go" onClick={start} disabled={busy || (!!runId && !finished)}>{busy ? 'starting…' : runId && !finished ? 'running' : 'Make the film'}</button>
      </div>
      {error && <p className="warn">{error}</p>}

      {runId && (
        <section className="run">
          <div className="head">
            <span className="id">{runId}</span>
            <span className={`status ${state?.status || 'starting'}`}>{state?.status || 'starting'}{state?.steps ? ` · ${state.steps} steps` : ''}</span>
          </div>
          {!!state?.steps && <p className="rep"><a href={`/api/extend?runId=${encodeURIComponent(runId)}&journal=1`}>Download run journal</a></p>}
          {state?.refused && <p className="warn">Refused at intake: {state.refused.code} — {state.refused.detail}</p>}
          {state?.failed && <p className="warn">Failed at {state.failed.stage}: {state.failed.detail}</p>}
          {state?.logline && <p className="logline">{state.logline}</p>}
          <ol className="shots">
            {(state?.shots || []).map((sh) => (
              <li key={sh.id} className={sh.status}>
                <span className="g" aria-hidden="true">{GLYPH[sh.status] || '○'}</span>
                <div className="body">
                  <div className="line"><b>{sh.id}</b> · {sh.seconds}s{sh.setup ? ` · ${sh.setup}` : ''}{sh.attempt ? ` · attempt ${sh.attempt}` : ''}{sh.shipped ? ` · ${sh.shipped}` : ''}{sh.extendsFrom ? ' · extends previous' : ''}</div>
                  <StatusBar shot={sh} />
                  {(sh.prompt || sh.subject) && <div className="sub">{sh.prompt || `${sh.subject} · ${sh.force}`}</div>}
                  {sh.qc.map((q) => <div key={q.attempt} className={`qc ${q.pass ? 'pass' : 'fail'}`}>QC {q.attempt}: {q.pass ? 'pass' : 'fail'}{q.score != null ? ` (${q.score})` : ''}{q.findings.length ? ` — ${q.findings.join('; ')}` : ''}</div>)}
                  {sh.decisions.map((d, i) => <div key={i} className="dec">judge: {d.decision}{d.reason ? ` — ${d.reason}` : ''}</div>)}
                  {sh.faults.map((f, i) => <div key={i} className="fault">fault ({f.kind}): {f.reason}</div>)}
                  {(sh.takes || []).length > 0 && (
                    <div className="grid">
                      {(sh.takes || []).map((f) => {
                        const review = (sh.reviews || []).find((r) => r.file === f);
                        const picked = sh.chosen?.file === f;
                        const v = (/-v(\d+)\.\w+$/.exec(f) || [])[1];
                        return (
                          <figure key={f} className={`cand${picked ? ' picked' : ''}`}>
                            <video className="take" controls muted preload="metadata" src={`/api/extend?runId=${encodeURIComponent(runId)}&file=${encodeURIComponent(f)}`} />
                            <figcaption>
                              <span className="tag">{picked ? 'Persona\u2019s pick' : `take ${v || ''}`}{review ? ` · ${review.score}/10` : ''}</span>
                              <span className="notes">{picked ? sh.chosen.reason : review ? review.notes : 'awaiting Persona'}</span>
                            </figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  )}
                  <FilmQC qc={sh.filmQC} />
                </div>
              </li>
            ))}
          </ol>
          {state?.final && <p className="final">Assembled: {state.final.totalMeasured}s for {state.final.targetSeconds}s · {state.final.fps} fps. Selected receipts describe proposed improvements; changes have not been applied.</p>}
          {state?.slice && <video className="film" controls src={`/api/extend?runId=${encodeURIComponent(runId)}&file=slice.mp4`} />}
          {state?.report && <p className="rep">Report: <code>runs/{runId}/report.md</code> · journal: <code>runs/{runId}/journal.ndjson</code></p>}
        </section>
      )}

      </div>
      <AgentSidebar />
      <style jsx>{`
        .page { height: 100%; overflow-y: auto; box-sizing: border-box; padding: 32px 28px 80px; color: var(--ink); display: flex; gap: 28px; align-items: flex-start; }
        .main { flex: 1; min-width: 0; max-width: 860px; }
        @media (max-width: 1080px) { .page { padding: 64px 20px 60px; } }
        h1 { font-size: 22px; font-weight: 550; margin: 0 0 6px; }
        .lede { color: var(--muted); margin: 0 0 20px; line-height: 1.5; }
        .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; font-size: 13px; color: var(--muted); }
        .field.small { width: 120px; }
        textarea, input { font: inherit; color: var(--ink); background: var(--raised); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 12px; }
        .row { display: flex; align-items: flex-end; gap: 14px; }
        .go { padding: 10px 18px; border-radius: var(--radius); background: var(--accent); color: var(--accent-ink); font-size: 14px; }
        .go:disabled { opacity: .5; }
        .warn { margin: 10px 0; padding: 8px 11px; border-radius: 8px; background: var(--accent-wash); color: var(--accent); font-size: 13px; }
        .run { margin-top: 26px; border-top: 1px solid var(--line-soft); padding-top: 16px; }
        .head { display: flex; justify-content: space-between; font-size: 12px; color: var(--faint); }
        .status.complete { color: var(--state-settled); } .status.failed, .status.refused { color: var(--state-stale); } .status.rendering, .status.planning { color: var(--state-working); }
        .logline { margin: 8px 0 14px; font-size: 15px; }
        .shots { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
        .shots li { display: flex; gap: 10px; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--line-soft); }
        .shots li.running { background: var(--hover); }
        .g { flex: none; width: 16px; color: var(--faint); } li.done .g { color: var(--state-settled); } li.running .g { color: var(--state-working); }
        .body { flex: 1; min-width: 0; font-size: 13px; }
        .sub, .qc, .dec, .fault { font-size: 12px; color: var(--muted); margin-top: 3px; }
        .qc.fail, .fault { color: var(--state-stale); } .qc.pass { color: var(--state-settled); }
        .final { margin-top: 14px; font-size: 13px; }
        .film { width: 100%; margin-top: 10px; border-radius: 10px; background: #000; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-top: 10px; }
        .cand { margin: 0; border: 2px solid transparent; border-radius: 10px; overflow: hidden; background: var(--rail); }
        .cand.picked { border-color: var(--state-settled); }
        .take { width: 100%; aspect-ratio: 16 / 9; display: block; background: #000; object-fit: cover; }
        figcaption { padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 2px; }
        .tag { font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); }
        .picked .tag { color: var(--state-settled); }
        .notes { font-size: 12px; color: var(--muted); line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .rep { font-size: 12px; color: var(--faint); }
        code { font-size: 11.5px; }
      `}</style>
    </main>
  );
}
