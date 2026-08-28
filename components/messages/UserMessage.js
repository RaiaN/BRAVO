// A turn you typed. Claude's transcript gives the human a bubble and the agent bare
// prose, so the two are told apart by shape before a word is read.
export default function UserMessage({ message }) {
  return (
    <article className="turn" data-role="user">
      <div className="bubble">{message.text}</div>
      <style jsx>{`
        .turn {
          display: flex; justify-content: flex-end;
          margin: 18px 0;
          animation: bravo-rise 0.18s ease both;
        }
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
