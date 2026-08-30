export const gates = {
  parses: ({ errors }) => (errors.length ? `${errors.length} unreadable block(s): ${errors[0].error}` : null),

  onlyAllowedTools: ({ calls }, allowed) => {
    const bad = calls.filter((c) => !allowed.includes(c.tool));
    return bad.length ? `called tools it does not hold: ${bad.map((c) => c.tool).join(', ')}` : null;
  },

  noInventedIds: ({ toolResults }) => {
    const invented = toolResults.filter((r) => r.output?.kind === 'shot' && !r.output.shot?.id);
    return invented.length ? 'a tool returned a shot with no id' : null;
  },

  routedOrAsked: (decision, kinds) => {
    if (decision.ask) return null;
    return kinds.includes(decision.kind) ? null : `routed to an unknown kind: ${decision.kind}`;
  },

  noParametersInPromptText: (prompt) => {
    const hit = /\b(\d+\s*(seconds?|secs?|s)\b|\d+:\d+\b|1080p|720p|480p|4K)\b/i.exec(String(prompt || ''));
    return hit ? `duration/ratio/resolution leaked into prompt text: "${hit[0]}"` : null;
  },

  citationsInRange: (prompt, refCount) => {
    const nums = [...String(prompt || '').matchAll(/@?Image\s*(\d+)/gi)].map((m) => Number(m[1]));
    const bad = nums.filter((n) => n < 1 || n > refCount);
    return bad.length ? `cites image ${bad.join(', ')} but the shot has ${refCount} ref(s)` : null;
  },
};

export const assertNoSpend = (spent) => (spent.length
  ? `gated tools ran without --spend: ${spent.join(', ')}`
  : null);
