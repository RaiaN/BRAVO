import { createBrowserClient } from '../utils/film/core/client.js';
import { withRetry } from '../utils/film/core/retry.js';

export const browserClient = (apiKey) => {
  const raw = createBrowserClient(apiKey);
  return {
    ...raw,
    reason: (args) => withRetry(() => raw.reason(args), { tries: 3, baseMs: 2500 }),
  };
};
