// THREAD MEMORY: the recent transcript, then a rolling summary of what came before.
// A policy about what an agent remembers, not a step in running a turn.

export const DEFAULT_CAP = 24;

export const transcriptFor = (thread, cap = DEFAULT_CAP) => {
  const msgs = thread.messages;
  const recent = msgs.slice(-cap);
  const older = msgs.slice(0, -cap);

  // The cap counts TURNS, not characters, so one enormous tool result can never evict the
  // thing the person actually said.
  const summary = older.length
    ? `EARLIER IN THIS THREAD (${older.length} messages, summarised): ${older
      .filter((m) => m.role !== 'tool')
      .slice(-12)
      .map((m) => `${m.role}: ${String(m.text || '').slice(0, 120)}`)
      .join(' | ')}\n\n`
    : '';

  const body = recent.map((m) => {
    // "YOU ALREADY RAN", not "[tool …]". Labelled neutrally, an agent reads its own
    // completed work as new information and second-guesses it.
    if (m.role === 'tool') return `YOU ALREADY RAN ${m.tool.name} → ${JSON.stringify(m.tool.output).slice(0, 1200)}`;
    return `${m.role === 'user' ? 'PERSON' : 'YOU'}: ${m.text}`;
  }).join('\n');

  return summary + body;
};
