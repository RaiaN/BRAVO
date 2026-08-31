const BASE = process.env.BRAVO_TEST_URL || `http://127.0.0.1:${process.env.PORT || 3210}`;

const transient = /overload|retry later|too many requests|429|502|503|504|timed? ?out/i;

export const testClient = ({ base = BASE, onCall = () => {} } = {}) => ({
  base,
  async reason(args) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.reasonOnce(args);
      } catch (err) {
        if (attempt >= 2 || !transient.test(String(err.message))) throw err;
        await new Promise((r) => setTimeout(r, 2500 * 2 ** attempt));
      }
    }
  },
  async reasonOnce({ prompt, systemPrompt, modelId, reasoningEffort }) {
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
