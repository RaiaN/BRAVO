// A tool result, INLINE AND VISUAL (§2). Never a wall of text where a picture is the
// answer — a film renders as a strip, a prompt as a fenced block, refs as a chip row.
//
// It is collapsed to one line by default: the agent's prose is the story, and the tool
// call is the receipt underneath it. Click to see the whole thing.
import { useState } from 'react';
import FilmStrip from '../results/FilmStrip';
import PromptBlock from '../results/PromptBlock';
import RefChips from '../results/RefChips';

const summarise = (name, output) => {
  if (!output) return name;
  if (output.kind === 'error') return output.error;
  if (output.kind === 'film') return `${output.shots.length} shot${output.shots.length === 1 ? '' : 's'}`;
  if (output.kind === 'shot') return output.shot ? `${output.shot.n || '—'} · ${output.shot.title || 'untitled'}` : 'a shot';
  if (output.kind === 'routed') return `this thread is a ${output.to} thread`;
  if (output.kind === 'look') return 'the look';
  if (output.kind === 'bible') return `${output.entries.length} bible entr${output.entries.length === 1 ? 'y' : 'ies'}`;
  return name;
};

const Body = ({ output }) => {
  if (!output) return null;
  if (output.kind === 'film') return <FilmStrip shots={output.shots} />;
  if (output.kind === 'shot' && output.shot) {
    return (
      <div className="stack">
        <RefChips refs={output.shot.refs} />
        <PromptBlock prompt={output.shot.prompt} />
        <style jsx>{`.stack{display:flex;flex-direction:column;gap:8px}`}</style>
      </div>
    );
  }
  if (output.kind === 'look') {
    const l = output.look || {};
    const rows = [['style', l.style], ['grade', l.grade], ['notes', l.notes]].filter(([, v]) => v);
    return rows.length
      ? <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}<style jsx>{`
          dl{margin:0;display:flex;flex-direction:column;gap:4px;font-size:13px}
          div{display:flex;gap:8px}
          dt{flex:none;width:52px;color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding-top:2px}
          dd{margin:0;flex:1}
        `}</style></dl>
      : <p className="none">The look is not set yet.<style jsx>{`.none{margin:0;color:var(--faint);font-size:13px}`}</style></p>;
  }
  return null;
};

export default function ToolResult({ message }) {
  const [open, setOpen] = useState(false);
  const { name, output, cost } = message.tool;
  const failed = output?.kind === 'error';
  const hasBody = ['film', 'shot', 'look'].includes(output?.kind);

  return (
    <article className={`tool${failed ? ' failed' : ''}`} data-role="tool">
      <button type="button" className="line" onClick={() => hasBody && setOpen((v) => !v)} disabled={!hasBody} aria-expanded={hasBody ? open : undefined}>
        <span className="dot" aria-hidden="true">{failed ? '⚠' : '·'}</span>
        <span className="name">{name}</span>
        <span className="sum">{summarise(name, output)}</span>
        {cost > 0 && <span className="cost tnum">${cost.toFixed(2)}</span>}
        {hasBody && <span className={`caret${open ? ' open' : ''}`} aria-hidden="true">▾</span>}
      </button>
      {open && hasBody && <div className="body"><Body output={output} /></div>}
      <style jsx>{`
        .tool { margin: 10px 0; }
        .line {
          display: flex; align-items: baseline; gap: 8px; width: 100%;
          padding: 3px 4px; border-radius: 6px; text-align: left;
          font-size: 12.5px; color: var(--muted);
        }
        .line:not(:disabled):hover { background: var(--hover); }
        .line:disabled { cursor: default; }
        .dot  { flex: none; width: 10px; text-align: center; color: var(--faint); }
        .failed .dot { color: var(--state-stale); }
        .name { flex: none; font-weight: 550; color: var(--ink-soft); }
        .failed .name { color: var(--state-stale); }
        .sum  { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cost { flex: none; color: var(--state-needs); }
        .caret { flex: none; font-size: 9px; transition: transform .15s ease; transform: rotate(-90deg); }
        .caret.open { transform: none; }
        .body { margin: 7px 0 0 22px; }
      `}</style>
    </article>
  );
}
