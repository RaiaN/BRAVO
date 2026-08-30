// THE APPROVAL CARD (§6). A gated call renders THE EXACT PROMPT and THE EXACT ORDERED
// REFERENCES before spending, with approve / edit / cancel.
//
// §8: "Show the full prompt before spending." Not a summary, not the first line — the
// whole thing, scrollable, exactly as it will be sent.
import { useState } from 'react';
import PromptBlock from '../results/PromptBlock';
import RefChips from '../results/RefChips';

export default function ApprovalCard({ message, onApprove, onCancel, busy }) {
  const { card } = message.tool;
  const [open, setOpen] = useState(true);
  if (!card) return null;

  const p = card.params || {};
  const params = [
    p.model && ['model', p.model],
    p.resolution && ['resolution', p.resolution],
    p.ratio && ['ratio', p.ratio],
    p.duration !== undefined && p.duration !== null && ['duration', String(p.duration)],
    p.size && ['size', p.size],
    p.generateAudio !== undefined && ['audio', p.generateAudio ? 'on' : 'off'],
  ].filter(Boolean);

  return (
    <article className="card">
      <header>
        <span className="what">{card.tool}</span>
        <span className="est">{card.estimate}</span>
      </header>

      <div className="body">
        <button type="button" className="toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'hide' : 'show'} the exact prompt · {card.prompt.length.toLocaleString()} chars
        </button>
        {open && <PromptBlock prompt={card.prompt} label={`sent verbatim to ${p.model || 'seedream'}`} />}
        {card.refs?.length > 0 && (
          <div className="refs">
            <span className="lbl">references, in order — position is the citation number</span>
            <RefChips refs={card.refs} prefix={card.refPrefix} />
          </div>
        )}
        {params.length > 0 && (
          <dl className="params">
            {params.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        )}
        {p.ratio === null && p.duration === null && (
          <p className="note">ratio and duration are not sent — an editing task locks both.</p>
        )}
      </div>

      <footer>
        <button type="button" className="ok" onClick={onApprove} disabled={busy}>
          {busy ? 'sending…' : `approve · ${card.estimate}`}
        </button>
        <button type="button" className="no" onClick={onCancel} disabled={busy}>cancel</button>
      </footer>

      <style jsx>{`
        .card {
          margin: 14px 0; border: 1px solid var(--line);
          border-radius: 12px; overflow: hidden; background: var(--raised);
          box-shadow: var(--shadow-soft);
        }
        header {
          display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
          padding: 9px 13px; background: var(--accent-wash);
          border-bottom: 1px solid var(--line-soft);
        }
        .what { font-size: 12px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
        .est  { font-size: 11.5px; color: var(--muted); }
        .body { padding: 11px 13px; display: flex; flex-direction: column; gap: 10px; }
        .toggle { font-size: 11.5px; color: var(--muted); text-align: left; }
        .toggle:hover { color: var(--ink); }
        .refs { display: flex; flex-direction: column; gap: 5px; }
        .lbl { font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--faint); }
        .params { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 16px; }
        .params div { display: flex; gap: 6px; align-items: baseline; }
        dt { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--faint); }
        dd { margin: 0; font-size: 12px; color: var(--ink-soft); }
        .note { margin: 0; font-size: 11.5px; color: var(--muted); }
        footer { display: flex; gap: 8px; padding: 0 13px 13px; }
        .ok {
          padding: 7px 15px; border-radius: 9px;
          background: var(--accent); color: var(--accent-ink);
          font-size: 13px; font-weight: 550;
        }
        .ok:disabled { opacity: .5; cursor: default; }
        .no { padding: 7px 12px; border-radius: 9px; font-size: 13px; color: var(--muted); }
        .no:hover:not(:disabled) { background: var(--hover); color: var(--ink); }
      `}</style>
    </article>
  );
}
