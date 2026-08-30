export default function AgentMessage({ message, enter }) {
  return (<article className={`turn${enter ? ' enter' : ''}`} data-role="agent">
      <div className="prose">{message.text}</div>
      <style jsx>{`
        .turn { margin: 18px 0; }
        .turn.enter { animation: bravo-rise 0.18s ease; }
        .prose {
          color: var(--ink);
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
      `}</style>
    </article>
  );
}
