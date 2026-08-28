// Transient-failure retry — pure, no imports. Generative calls routinely die on
// "server overload" / "Seedance timed out", and without a second attempt those are
// holes in the cut. A redo is cheap relative to a missing shot, so the engine
// retries transient errors with
// exponential backoff + jitter (jitter so parallel retries don't re-stampede the
// service that just shed load).

// What counts as transient: throttling/overload, gateway errors, timeouts, and
// connection-level flakes. Hard 4xx (bad params, auth) are NOT matched — retrying
// those just burns time.
const TRANSIENT_RE = /overload|retry later|too many requests|rate.?limit|\b429\b|\b502\b|\b503\b|\b504\b|timed? ?out|timeout|temporar|econnreset|socket hang ?up|fetch failed|network/i;

export const isTransient = (err) => TRANSIENT_RE.test(String((err && err.message) || err || ''));

/**
 * Run fn(); on a retryable error wait (baseMs · 2^attempt · jitter) and try again.
 * @param {() => Promise<any>} fn
 * @param {{ tries?: number, baseMs?: number, shouldRetry?: (err) => boolean,
 *           onRetry?: (err, attempt, delayMs) => void }} opts
 */
export const withRetry = async (fn, { tries = 3, baseMs = 2000, shouldRetry = isTransient, onRetry } = {}) => {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await fn(); // eslint-disable-line no-await-in-loop
    } catch (err) {
      lastErr = err;
      if (attempt === tries - 1 || !shouldRetry(err)) throw err;
      const delayMs = Math.round(baseMs * 2 ** attempt * (0.75 + Math.random() * 0.5));
      if (onRetry) { try { onRetry(err, attempt + 1, delayMs); } catch { /* never break the retry */ } }
      await new Promise((r) => setTimeout(r, delayMs)); // eslint-disable-line no-await-in-loop
    }
  }
  throw lastErr;
};
