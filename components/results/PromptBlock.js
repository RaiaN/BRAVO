export default function PromptBlock({ prompt, label = 'prompt' }) {
  if (!prompt) return <p className="none">No prompt yet.<style jsx>{`.none{margin:0;color:var(--faint);font-size:13px}`}</style></p>;
  return (<div className="block">
      <div className="head"><span>{label}</span><span className="chars tnum">{prompt.length.toLocaleString()} chars</span></div>
      <pre>{prompt}</pre>
      <style jsx>{`
        .block { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; background: var(--raised); }
        .head {
          display: flex; justify-content: space-between; align-items: center;
          padding: 5px 11px; border-bottom: 1px solid var(--line-soft);
          font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint);
        }
        pre {
          margin: 0; padding: 11px; overflow-x: auto;
          font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
          font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
        }
      `}</style>
    </div>
  );
}
