// The transport for tests.
//
// The kit's `createBrowserClient` posts to RELATIVE urls (`/api/seed`), which only
// resolve in a browser. Tests run in Node against a real BRAVO server, so this mirrors
// the same interface against an absolute base. It is test-only — the kit is untouched
// and the app still uses createBrowserClient.

const BASE = process.env.BRAVO_TEST_URL || `http://127.0.0.1:${process.env.PORT || 3210}`;

export const testClient = ({ base = BASE, onCall = () => {} } = {}) => ({
  base,
  async reason({ prompt, systemPrompt, modelId, reasoningEffort }) {
    onCall({ tool: 'reason', chars: prompt.length });
    const res = await fetch(`${base}/api/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, systemPrompt, modelId, reasoningEffort, images: [] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `reason failed (HTTP ${res.status})`);
    return data;
  },
});

// A client that never reaches the network: replies come from a list, in order. Lets the
// gate tests exercise malformed and hostile replies that a real model rarely produces on
// demand.
export const scriptedClient = (replies) => {
  let i = 0;
  return {
    calls: [],
    async reason({ prompt, systemPrompt }) {
      this.calls.push({ prompt, systemPrompt });
      const next = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return { content: typeof next === 'function' ? next({ prompt, systemPrompt }) : next };
    },
  };
};

export const serverUp = async (base = BASE) => {
  try {
    const r = await fetch(`${base}/api/film/config`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
};

// The kit is written for a browser: `hydrateSkills` fetches the RELATIVE url
// `/api/film/skills`, which Node cannot resolve. Rather than change the kit, give
// Node an origin — wrap global fetch so relative /api/... paths resolve against the test
// server, exactly as they would in a page served from it.
export const installRelativeFetch = (base = BASE) => {
  const real = globalThis.fetch;
  if (real.__bravoWrapped) return;
  const wrapped = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) return real(`${base}${input}`, init);
    return real(input, init);
  };
  wrapped.__bravoWrapped = true;
  globalThis.fetch = wrapped;
};
