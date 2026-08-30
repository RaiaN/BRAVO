// A turn the thread's agent wrote. Bare prose at the reading measure — no bubble, no
// avatar — so the agent's output reads as the document it is.
//
// : tool results render INLINE AND VISUAL. They are `role: 'tool'` messages and get
// their own component (ToolResult, from M3); this one is text only.
//
// `enter` follows the same rule as UserMessage: motion is decoration, never the thing
// that makes the words appear.
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
