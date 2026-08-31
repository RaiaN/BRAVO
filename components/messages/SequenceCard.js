import { useState } from 'react';
import PromptBlock from '../results/PromptBlock';

export default function SequenceCard({ message, onApprove, onCancel, busy }) {
  const { card } = message.tool;
  const [openShot, setOpenShot] = useState(null);
  if (!card?.manifest) return null;
  const m = card.manifest;
  const total = m.shots.reduce((a, b) => a + b.seconds, 0);

  return (
    <article className="card">
      <header>
        <span className="what">sequence · the whole slice</span>
        <span className="est">{card.estimate}</span>
      </header>

      <div className="body">
        <dl className="params">
          <div><dt>target</dt><dd>{m.targetSeconds}s ± {m.tolerance}s</dd></div>
          <div><dt>plan</dt><dd>{m.shots.length} shots, {m.shots.map((s) => s.seconds).join('+')} = {total}s</dd></div>
          <div><dt>model</dt><dd>{m.slot} · {m.params.resolution} · {m.params.fps}fps</dd></div>
          <div><dt>renders</dt><dd>{m.renders.takes} takes + {m.renders.stills} plates · retry pool {m.retryPool}</dd></div>
          <div><dt>audio</dt><dd>{m.params.audio ? 'on' : 'off'}</dd></div>
        </dl>
        {m.params.audio && <p className="note">{m.audioContingency}</p>}

        {m.plates.length > 0 && (
          <div className="section">
            <span className="lbl">plates rendered first</span>
            {m.plates.map((pl) => (
              <div key={pl.entity} className="platebox">
                <span className="pname">{pl.entity} <i>({pl.role})</i></span>
                <PromptBlock prompt={pl.prompt} label={`plate · sent verbatim to ${pl.model}`} />
              </div>
            ))}
          </div>
        )}

        <div className="section">
          <span className="lbl">every shot, exactly as it will be sent</span>
          {m.shots.map((sh, i) => (
            <div key={sh.id} className="shotrow">
              <button type="button" className="shothead" onClick={() => setOpenShot(openShot === sh.id ? null : sh.id)} aria-expanded={openShot === sh.id}>
                <span className="n tnum">{i + 1}</span>
                <span className="meta">{sh.seconds}s · {sh.setup} · side {sh.side} · {sh.location}</span>
                <span className="chars tnum">{sh.prompt.length} chars</span>
              </button>
              {openShot === sh.id && <PromptBlock prompt={sh.prompt} label={`shot ${i + 1} · sent verbatim to ${m.slot}`} />}
            </div>
          ))}
        </div>
      </div>

      <footer>
        <button type="button" className="ok" onClick={onApprove} disabled={busy}>
          {busy ? 'running…' : `approve the whole sequence · ${m.renders.takes + m.renders.stills} renders`}
        </button>
        <button type="button" className="no" onClick={onCancel} disabled={busy}>cancel</button>
      </footer>

      <style jsx>{`
        .card { margin: 14px 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--raised); box-shadow: var(--shadow-soft); }
        header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 9px 13px; background: var(--accent-wash); border-bottom: 1px solid var(--line-soft); }
        .what { font-size: 12px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
        .est { font-size: 11.5px; color: var(--muted); }
        .body { padding: 11px 13px; display: flex; flex-direction: column; gap: 12px; }
        .params { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 18px; }
        .params div { display: flex; gap: 6px; align-items: baseline; }
        dt { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--faint); }
        dd { margin: 0; font-size: 12px; color: var(--ink-soft); }
        .note { margin: 0; font-size: 11.5px; color: var(--muted); }
        .section { display: flex; flex-direction: column; gap: 7px; }
        .lbl { font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--faint); }
        .platebox { display: flex; flex-direction: column; gap: 5px; }
        .pname { font-size: 12.5px; font-weight: 600; }
        .pname i { font-weight: 400; color: var(--muted); }
        .shotrow { display: flex; flex-direction: column; gap: 6px; }
        .shothead { display: flex; align-items: baseline; gap: 9px; padding: 6px 9px; border-radius: 8px; background: var(--hover); text-align: left; }
        .shothead:hover { background: var(--active); }
        .n { flex: none; font-size: 12px; font-weight: 650; color: var(--accent); }
        .meta { flex: 1; min-width: 0; font-size: 12.5px; }
        .chars { flex: none; font-size: 10.5px; color: var(--faint); }
        footer { display: flex; gap: 8px; padding: 0 13px 13px; }
        .ok { padding: 8px 16px; border-radius: 9px; background: var(--accent); color: var(--accent-ink); font-size: 13px; font-weight: 550; }
        .ok:disabled { opacity: .5; cursor: default; }
        .no { padding: 7px 12px; border-radius: 9px; font-size: 13px; color: var(--muted); }
        .no:hover:not(:disabled) { background: var(--hover); color: var(--ink); }
      `}</style>
    </article>
  );
}
