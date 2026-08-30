export const DEFAULT_CAP = 24;

export const transcriptFor = (thread, cap = DEFAULT_CAP) => {
  const msgs = thread.messages;
  const recent = msgs.slice(-cap);
  const older = msgs.slice(0, -cap);

  const summary = older.length
    ? `EARLIER IN THIS THREAD (${older.length} messages, summarised): ${older
      .filter((m) => m.role !== 'tool')
      .slice(-12)
      .map((m) => `${m.role}: ${String(m.text || '').slice(0, 120)}`)
      .join(' | ')}\n\n`
    : '';

  const body = recent.map((m) => {
    if (m.role === 'tool') return `YOU ALREADY RAN ${m.tool.name} → ${JSON.stringify(m.tool.output).slice(0, 1200)}`;
    if (m.asset) return `PERSON UPLOADED an image: url=${m.asset.url}${m.asset.name ? ` name=${JSON.stringify(m.asset.name)}` : ''}${m.text ? ` — ${m.text}` : ''}`;
    return `${m.role === 'user' ? 'PERSON' : 'YOU'}: ${m.text}`;
  }).join('\n');

  return summary + body;
};
