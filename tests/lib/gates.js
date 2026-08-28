// THE GATES — deterministic checks an agent's output must pass.
//
// §8: "every LLM promise needs a code gate — a deterministic check, a retry, a visible
// report." These are the checks. They assert STRUCTURE, never wording: a model that
// phrases a report differently is not a regression, one that cites image 7 of 3 is.

export const gates = {
  // A reply the parser could read at all.
  parses: ({ errors }) => (errors.length ? `${errors.length} unreadable block(s): ${errors[0].error}` : null),

  // Every call names a tool the agent actually holds (§4's row).
  onlyAllowedTools: ({ calls }, allowed) => {
    const bad = calls.filter((c) => !allowed.includes(c.tool));
    return bad.length ? `called tools it does not hold: ${bad.map((c) => c.tool).join(', ')}` : null;
  },

  // §8: an unknown id resolves to nothing. A tool result that errored on a bad id is a
  // PASS — the failure would be inventing one.
  noInventedIds: ({ toolResults }) => {
    const invented = toolResults.filter((r) => r.output?.kind === 'shot' && !r.output.shot?.id);
    return invented.length ? 'a tool returned a shot with no id' : null;
  },

  // The router must land on a known kind or ask. Never a default.
  routedOrAsked: (decision, kinds) => {
    if (decision.ask) return null;
    return kinds.includes(decision.kind) ? null : `routed to an unknown kind: ${decision.kind}`;
  },

  // Phase B will add: citation numbers within range, dialogue preserved, and no
  // duration/ratio/resolution in prompt text (§8 — those are parameters, never text).
  noParametersInPromptText: (prompt) => {
    // `seconds?` and `secs?` matter: "a 6 second shot" is the leak people actually write,
    // and a plural-only pattern sails straight past it.
    const hit = /\b(\d+\s*(seconds?|secs?|s)\b|\d+:\d+\b|1080p|720p|480p|4K)\b/i.exec(String(prompt || ''));
    return hit ? `duration/ratio/resolution leaked into prompt text: "${hit[0]}"` : null;
  },

  citationsInRange: (prompt, refCount) => {
    const nums = [...String(prompt || '').matchAll(/@?Image\s*(\d+)/gi)].map((m) => Number(m[1]));
    const bad = nums.filter((n) => n < 1 || n > refCount);
    return bad.length ? `cites image ${bad.join(', ')} but the shot has ${refCount} ref(s)` : null;
  },
};

// Assert no gated tool was reached. A suite that quietly starts costing money is a bug,
// so this runs on every non-spending run.
export const assertNoSpend = (spent) => (spent.length
  ? `gated tools ran without --spend: ${spent.join(', ')}`
  : null);
