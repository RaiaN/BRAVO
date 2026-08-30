export default function UserMessage({ message, enter }) {
  return (<article className={`turn${enter ? ' enter' : ''}`} data-role="user">
      <div className="bubble">{message.text}</div>
      <style jsx>{`
        .turn {
          display: flex; justify-content: flex-end;
          margin: 18px 0;
        }
        .turn.enter { animation: bravo-rise 0.18s ease; }
        .bubble {
          max-width: 85%;
          padding: 9px 14px;
          background: var(--bubble);
          border-radius: 14px;
          color: var(--ink);
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
      `}</style>
    </article>
  );
}
