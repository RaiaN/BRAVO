// A turn you typed. Claude's transcript gives the human a bubble and the agent bare
// prose, so the two are told apart by shape before a word is read.
//
// `enter` marks a turn that ARRIVED while you were watching. A transcript restored from
// the store does not animate — it was already there — and the animation never carries
// the burden of making text visible: the bubble's own opacity is 1, so a frozen
// animation (a hidden tab throttles them to a standstill) degrades to no motion rather
// than to an empty thread.
export default function UserMessage({ message, enter }) {
  return (
    <article className={`turn${enter ? ' enter' : ''}`} data-role="user">
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
